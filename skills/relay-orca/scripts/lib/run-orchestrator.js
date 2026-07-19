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
  sendPrompt,
} = require("./run-orca");
const { buildOperatorPrompt } = require("./operator-prompt");
const { coordinationMarkerFor } = require("./coordination-marker");
const { IntegrationLifecycleError, prepareIntegrationGate } = require("./integration-lifecycle");

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

function taskTitle(program, task, programSegment) {
  // A26: the marker embeds the SAME collision-resistant program SEGMENT used for the
  // receipt path (sanitized ≤64 prefix + 8-hex sha256), NOT the raw id. A raw id can
  // contain `/`, so a marker built from `program.id` would let program `alpha` match a
  // task titled for `alpha/child`. The segment is slash-free, so `status`'s
  // `title.includes("relay-orca: <segment>/")` foreign-task check can never confuse two
  // distinct programs. `programSegment` is injected (pure) so lib/ stays subprocess-free.
  return coordinationMarkerFor(program.id, task.outcome_id, programSegment);
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
        title: taskTitle(program, task, options.programSegment),
        spec: taskSpec(program, task),
        deps,
      });
      if (!res.ok) {
        // A12: a mid-wave task-create failure raises TASK_MATERIALIZE_FAILED (exit 41)
        // ONLY after the mappings recorded by earlier successful creates (persisted just
        // below) are already durable — a later failure never drops an earlier outcome's
        // orca_task_id.
        reject(
          "TASK_MATERIALIZE_FAILED",
          `orca orchestration task-create failed for outcome ${task.outcome_id}` +
            procDetail(res.proc, "response reported ok:false or returned no task id"),
        );
      }
      orcaIdByPlanId.set(planId, res.taskId);
      entryByPlanId.get(planId).orca_task_id = res.taskId;
      // A12: persist the receipt after EACH successful task-create so the mapping is on
      // disk before the next (possibly failing) create runs. A reconcile can then adopt
      // the already-created tasks instead of re-materializing them.
      persistReceipt(report, options);
    }
  }
  return { taskByPlanId, entryByPlanId, orcaIdByPlanId };
}

// D3 terminal acquisition: EXPLICIT handles only. `run` dispatches solely to the
// terminals the operator passed via --operator-handle and NEVER creates one itself —
// a bare `terminal create` yields an agent-less terminal that can never accept
// `--inject` ("no recognized agent detected"). Exhausting the provided handles leaves
// the remaining eligible tasks pending (handle-shortfall, no error). The zero-handle
// case is rejected UPFRONT (requireOperatorHandles) before any materialization, so the
// pool here is only ever consulted when at least one handle exists.
function makeHandlePool(options) {
  const explicit = Array.isArray(options.operatorHandles) ? options.operatorHandles.slice() : [];
  let index = 0;
  return {
    acquire() {
      return index < explicit.length ? explicit[index++] : null;
    },
  };
}

// D3.1: `run` invoked with ZERO --operator-handle fails closed with
// OPERATOR_DISPATCH_FAILED (exit 44) BEFORE any mutating Orca subcommand runs (no
// task-create, no dispatch, no terminal create). The remediation instructs creating a
// terminal with an agent CLI and re-running with an explicit handle.
function requireOperatorHandles(options) {
  const explicit = Array.isArray(options.operatorHandles) ? options.operatorHandles : [];
  if (explicit.length === 0) {
    reject(
      "OPERATOR_DISPATCH_FAILED",
      "no operator terminal provided: relay-orca run dispatches only to explicitly provided --operator-handle terminals and never creates its own (a self-created terminal has no recognized agent and cannot accept --inject)",
      'Create an operator terminal running an agent CLI via `orca terminal create --command "<agent-cli>" --json`, then re-run with `--operator-handle <handle>`.',
    );
  }
}

function integrationTasks(program) {
  return (Array.isArray(program.outcomes) ? program.outcomes : []).filter((outcome) => outcome && outcome.task_kind === "integration_gate");
}

function requireIntegrationCoordinator(program, options) {
  if (integrationTasks(program).length > 0 && !isNonEmptyString(options.coordinatorHandle)) {
    reject(
      "INTEGRATION_LIFECYCLE_FAILED",
      "integration_gate requires an explicit --coordinator-handle; the coordinator is never inferred from a receipt, history, or stale dispatch",
      "Re-run with the verified current coordinator handle and a deterministic --gate-evidence-dir; do not use task-update, reset, receipt edits, or manual dispatch replay.",
    );
  }
  if (integrationTasks(program).length > 0 && typeof options.integrationReportPath !== "function") {
    reject(
      "INTEGRATION_LIFECYCLE_FAILED",
      "integration_gate requires a deterministic integration report path before dispatch",
      "Provide --gate-evidence-dir or RELAY_ORCA_GATE_EVIDENCE_ROOT so the operator can write the live report at a deterministic path.",
    );
  }
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

// D2 receipt persistence. The receipt is a minimal, versioned identity/mapping
// record; it is (re)written after EACH successful task-create (A12) and after each
// successful dispatch verification — the mapping-changing steps. The atomic write itself lives
// in the top-level script (options.persistReceipt); this pure module only assembles
// the mapping-changing "core" from the live report and threads back the resulting
// path. When no writer is injected (direct-orchestrator unit tests) it is a no-op.
function persistReceipt(report, options) {
  if (typeof options.persistReceipt !== "function") return;
  report.receipt_path = options.persistReceipt({
    program_id: report.program_id,
    runtime_id: report.admission.runtime_id,
    tasks: report.tasks,
    terminals_created: report.terminals_created,
  });
}

// D6 per-task dispatch: inject, verify, then (only after verification) deliver the
// operator prompt. Any failure records the task `escalated` and re-raises so no
// further pending task is dispatched; already-verified operators are not touched.
function dispatchOne(ctx) {
  const { orcaBin, entry, orcaTaskId, handle, task, program, outcome, options, report } = ctx;
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
  // D2/A2: the provenance trio (orca_task_id, dispatch_id, assignee) is now VERIFIED,
  // so persist the receipt mapping HERE — before prompt delivery. A prompt hand-off
  // failure below must leave the receipt already carrying the verified provenance (it
  // is durable coordination metadata, independent of whether the operator prompt lands),
  // so a later reconcile can recover the dispatch instead of re-materializing it.
  persistReceipt(report, options);
  let integrationGate = null;
  if (task.kind === "integration_gate") {
    try {
      integrationGate = prepareIntegrationGate({
        run: options.runOrca,
        orcaBin,
        programId: program.id,
        outcomeId: task.outcome_id,
        taskId: orcaTaskId,
        dispatchId: show.dispatchId,
        assignee: show.assignee,
        coordinatorHandle: options.coordinatorHandle,
        runtimeId: report.admission.runtime_id,
        reportPath: options.integrationReportPath(task.outcome_id),
        programSegment: options.programSegment,
      });
    } catch (error) {
      if (!(error instanceof IntegrationLifecycleError)) throw error;
      entry.status = STATUS.ESCALATED;
      reject(
        "INTEGRATION_LIFECYCLE_FAILED",
        `integration lifecycle failed before operator prompt for outcome ${task.outcome_id}: ${error.reasonCode}: ${error.message}`,
        "Re-read the current runtime/coordinator/task/dispatch/assignee and canonical gate; do not use task-update, reset, receipt edits, or manual dispatch replay.",
      );
    }
  }
  const prompt = buildOperatorPrompt(task, program, outcome, options.programSegment, { integrationGate });
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
  const handles = makeHandlePool(options);
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
      report,
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
    requireIntegrationCoordinator(program, options);
    // D3.1: reject a zero-handle run AFTER admission (probe result) and BEFORE any
    // materialization mutation, so no task-create/dispatch/terminal-create ever runs.
    requireOperatorHandles(options);
    // materialize persists the receipt after EACH successful task-create (A12), so the
    // full outcome→orca_task_id mapping is already durable here; dispatchWave then
    // re-persists after each provenance verification (A2). No separate post-materialize
    // write is needed.
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

// provenanceMismatch is additively exported (#946) so `resume` reuses the EXACT dispatch
// verification `run` applies — the same trio check on the same dispatch-show shape — when
// it re-dispatches or reacquires a terminal through the verified path. orchestrate and
// the run flow are unchanged (byte-equivalent).
module.exports = { orchestrate, provenanceMismatch };
