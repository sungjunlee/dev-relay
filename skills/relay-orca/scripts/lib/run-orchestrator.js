"use strict";

// Core `run` flow: compile (frozen plan lib) -> admit (frozen #942 probe) ->
// materialize tasks -> dispatch provenance-injected operators. The report is
// mutated in place throughout so it is truthful on every early-exit path. All
// fail-closed transitions go through run-reasons; plan-library rejections
// propagate as PlanError untouched (D1) and are re-raised by the caller.
const { compileProgram } = require("./compile-program");
const { probe, emptyResult } = require("../probe-orca");
const { ProbeError } = require("./probe-reasons");
const { RunError, reject } = require("./run-reasons");
const { initReport, blockingReason, STATUS } = require("./run-report");
const {
  boundedExcerpt,
  isNonEmptyString,
  createTask,
  dispatchTask,
  showDispatch,
  createTerminal,
  sendPrompt,
} = require("./run-orca");
const { buildOperatorPrompt } = require("./operator-prompt");

// The CLI-invocation boundary is injected by run.js (the Node subprocess module
// may not live under scripts/lib/ — plan.js's frozen D6 source scan forbids it).
// Every Orca call below threads options.runOrca into the pure adapter functions.

// The accepted-program root may be the program object directly or wrapped under
// a `program` key (accepted-program-schema.md). compileProgram unwraps the same
// way internally; run needs the unwrapped object for the original outcomes
// (relay_fleet leaves, accepted_outcomes) that the compiled plan does not carry.
function unwrapProgram(raw) {
  return raw && raw.program && typeof raw.program === "object" ? raw.program : raw;
}

function procDetail(proc, note) {
  if (proc && proc.stderr) return `: ${boundedExcerpt(proc.stderr)}`;
  if (proc && proc.status !== 0) return ` (exit ${proc.status})`;
  return note ? `: ${note}` : "";
}

// D3 admission gate: every mutation is preceded by capability admission from the
// FROZEN #942 probe (imported, never modified). Any probe rejection or
// admitted:false fails closed as ADMISSION_REJECTED, before any task/terminal.
function admit(report, options) {
  const result = emptyResult(false);
  try {
    probe({ orcaBin: options.orcaBin, _result: result });
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    report.admission = { admitted: false, runtime_id: result.runtime_id };
    reject(
      "ADMISSION_REJECTED",
      `Orca capability probe rejected admission [${error.reasonCode}]: ${boundedExcerpt(error.message)}`,
    );
  }
  if (!result.admitted) {
    report.admission = { admitted: false, runtime_id: result.runtime_id };
    reject("ADMISSION_REJECTED", "Orca capability probe returned admitted:false");
  }
  report.admission = { admitted: true, runtime_id: result.runtime_id };
  return result.orca_bin;
}

function taskTitle(program, task) {
  // Literal marker `relay-orca:` followed by `<program_id>/<outcome_id>` (D4).
  return `relay-orca: ${program.id}/${task.outcome_id}`;
}

function taskSpec(program, task) {
  // Machine-readable task metadata embedded in --spec (D4). No operator prompt is
  // embedded here: the prompt is delivered only AFTER provenance verification (D6).
  return JSON.stringify({
    marker: "relay-orca",
    program_id: program.id,
    outcome_id: task.outcome_id,
    task_kind: task.kind,
    wave: task.wave,
    depends_on: task.depends_on,
  });
}

// D4 materialization. Waves are ordered and dependencies resolve to strictly
// earlier waves, so iterating waves in order guarantees a task's dependency Orca
// ids already exist when its --deps array is built.
function materialize(plan, program, report, orcaBin, options) {
  const taskByPlanId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const entryByPlanId = new Map(report.tasks.map((entry) => [entry.task_id, entry]));
  const orcaIdByPlanId = new Map();
  for (const wave of plan.waves) {
    for (const planId of wave.task_ids) {
      const task = taskByPlanId.get(planId);
      const deps = task.depends_on.map((dep) => orcaIdByPlanId.get(dep));
      const res = createTask(options.runOrca, orcaBin, {
        title: taskTitle(program, task),
        spec: taskSpec(program, task),
        deps,
      });
      if (!res.ok) {
        reject(
          "TASK_MATERIALIZE_FAILED",
          `orca orchestration task-create failed for outcome ${task.outcome_id}` +
            procDetail(res.proc, "response reported ok:false or returned no task id"),
        );
      }
      orcaIdByPlanId.set(planId, res.taskId);
      entryByPlanId.get(planId).orca_task_id = res.taskId;
    }
  }
  return { taskByPlanId, entryByPlanId, orcaIdByPlanId };
}

// D5 terminal acquisition. A handle is either (a) an explicit --operator-handle
// or (b) one created via `orca terminal create` this invocation. When explicit
// handles are provided, run uses only those: exhausting them leaves the remaining
// eligible tasks pending (handle-shortfall, no error). With no explicit handles,
// run creates a fresh terminal per dispatch; a create that yields no usable
// handle is OPERATOR_DISPATCH_FAILED. Every created handle is recorded (D10).
function makeHandlePool(orcaBin, report, options) {
  const explicit = Array.isArray(options.operatorHandles) ? options.operatorHandles.slice() : [];
  const hasExplicit = explicit.length > 0;
  let index = 0;
  return {
    acquire() {
      if (hasExplicit) return index < explicit.length ? explicit[index++] : null;
      const term = createTerminal(options.runOrca, orcaBin);
      if (!term.ok) {
        reject(
          "OPERATOR_DISPATCH_FAILED",
          "no valid operator target: orca terminal create yielded no usable handle" +
            procDetail(term.proc, "response reported ok:false or returned no handle"),
        );
      }
      report.terminals_created.push(term.handle);
      return term.handle;
    },
  };
}

// D6.2 provenance trio verification. Returns a bounded description of the first
// null/empty/mismatched value, or null when the task/dispatch/assignee trio is
// fully verified.
function provenanceMismatch(show, orcaTaskId) {
  if (!show.ok) return "dispatch-show did not return ok" + procDetail(show.proc);
  if (show.taskId !== orcaTaskId) {
    return `task id ${boundedExcerpt(show.taskId)} does not match dispatched ${boundedExcerpt(orcaTaskId)}`;
  }
  if (!isNonEmptyString(show.dispatchId)) return "dispatch id is null or empty";
  if (!isNonEmptyString(show.assignee)) return "assignee handle is null or empty";
  return null;
}

// D6 per-task dispatch: inject, verify, then (only after verification) deliver the
// operator prompt. Any failure records the task `escalated` and re-raises so no
// further pending task is dispatched; already-verified operators are not touched.
function dispatchOne(ctx) {
  const { orcaBin, entry, orcaTaskId, handle, task, program, outcome, options } = ctx;
  const disp = dispatchTask(options.runOrca, orcaBin, { orcaTaskId, handle });
  if (!disp.ok) {
    entry.status = STATUS.ESCALATED;
    reject(
      "INJECTION_UNDELIVERED",
      `orca orchestration dispatch --inject failed for outcome ${task.outcome_id}` + procDetail(disp.proc),
    );
  }
  const show = showDispatch(options.runOrca, orcaBin, { orcaTaskId });
  const mismatch = provenanceMismatch(show, orcaTaskId);
  if (mismatch) {
    entry.status = STATUS.ESCALATED;
    reject("PROVENANCE_MISMATCH", `dispatch-show provenance verification failed for outcome ${task.outcome_id}: ${mismatch}`);
  }
  entry.dispatch_id = show.dispatchId;
  entry.assignee = show.assignee;
  const prompt = buildOperatorPrompt(task, program, outcome);
  const sent = sendPrompt(options.runOrca, orcaBin, { orcaTaskId, handle, prompt });
  if (!sent.ok) {
    entry.status = STATUS.ESCALATED;
    reject(
      "INJECTION_UNDELIVERED",
      `operator prompt hand-off failed for outcome ${task.outcome_id}` + procDetail(sent.proc),
    );
  }
  entry.status = STATUS.DISPATCHED;
}

// D7 dispatch scope: only wave-1 tasks (all dependency-satisfied) are eligible in
// v0; later waves stay pending. At most `concurrency` are dispatched; excess
// eligible tasks stay pending with no error (partial wave dispatch).
function dispatchWave(plan, program, report, orcaBin, maps, options) {
  const wave1 = plan.waves.length ? plan.waves[0].task_ids : [];
  const target = Math.min(wave1.length, plan.concurrency);
  const handles = makeHandlePool(orcaBin, report, options);
  const outcomeById = new Map(program.outcomes.map((outcome) => [outcome.id, outcome]));
  for (let i = 0; i < target; i += 1) {
    const planId = wave1[i];
    const handle = handles.acquire();
    if (!handle) break; // explicit-handle shortfall → remaining eligible stay pending (D5)
    const task = maps.taskByPlanId.get(planId);
    dispatchOne({
      orcaBin,
      task,
      entry: maps.entryByPlanId.get(planId),
      orcaTaskId: maps.orcaIdByPlanId.get(planId),
      handle,
      program,
      outcome: outcomeById.get(task.outcome_id) || {},
      options,
    });
  }
}

// Compile through the frozen plan library, admit through the frozen probe, then
// materialize and dispatch. PlanError propagates untouched (D1); RunError is
// captured into the report's blocking_reasons with its fail-closed exit code.
function orchestrate(rawProgram, options = {}) {
  const plan = compileProgram(rawProgram, { concurrency: options.concurrency });
  const program = unwrapProgram(rawProgram);
  const report = initReport(plan);
  try {
    const orcaBin = admit(report, options);
    const maps = materialize(plan, program, report, orcaBin, options);
    dispatchWave(plan, program, report, orcaBin, maps, options);
    report.ok = true;
    return { report, exitCode: 0 };
  } catch (error) {
    if (!(error instanceof RunError)) throw error;
    report.ok = false;
    report.blocking_reasons = [blockingReason(error)];
    return { report, exitCode: error.exitCode };
  }
}

module.exports = { orchestrate };
