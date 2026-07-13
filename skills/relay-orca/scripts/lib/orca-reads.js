"use strict";

// Pure Orca READ-ONLY adapters for `status` (#945 D4). ONLY read subcommands are
// built here: `status --json`, `orchestration task-list --json`,
// `orchestration gate-list --json`, and `orchestration dispatch-show --task <id>
// --json`. No mutating orchestration subcommand (task-create/task-update/dispatch/
// terminal), no `reset`, and no `worktree` subcommand is reachable from this module.
// Every builder receives an injected `run(orcaBin, args, options)` so the subprocess
// boundary stays in the top-level script and plan.js's frozen lib source-scan keeps
// passing.
const { parseJson, isNonEmptyString } = require("./bounded-excerpt");

function envelope(proc) {
  const parsed = parseJson(proc.stdout);
  const ok = proc.status === 0 && parsed.ok && parsed.value && parsed.value.ok === true;
  return { ok, value: ok ? parsed.value : null };
}

function metaRuntimeId(value) {
  const meta = value && value._meta;
  return meta && isNonEmptyString(meta.runtimeId) ? meta.runtimeId : null;
}

function orcaStatus(run, orcaBin, options = {}) {
  const proc = run(orcaBin, ["status", "--json"], options);
  const { ok, value } = envelope(proc);
  if (!ok) return { ok: false, reachable: false, runtimeId: null, proc };
  const runtime = value.result && value.result.runtime;
  const runtimeId = runtime && isNonEmptyString(runtime.runtimeId)
    ? runtime.runtimeId
    : metaRuntimeId(value);
  return { ok: true, reachable: true, runtimeId, proc };
}

function orcaTaskList(run, orcaBin, options = {}) {
  const proc = run(orcaBin, ["orchestration", "task-list", "--json"], options);
  const { ok, value } = envelope(proc);
  if (!ok) return { ok: false, reachable: false, tasks: [], runtimeId: null, proc };
  const result = value.result || {};
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  return { ok: true, reachable: true, tasks, runtimeId: metaRuntimeId(value), proc };
}

function orcaGateList(run, orcaBin, options = {}) {
  const proc = run(orcaBin, ["orchestration", "gate-list", "--json"], options);
  const { ok, value } = envelope(proc);
  if (!ok) return { ok: false, reachable: false, gates: [], runtimeId: null, proc };
  const result = value.result || {};
  const gates = Array.isArray(result.gates) ? result.gates : [];
  // A17: expose the read's `_meta.runtimeId` so the caller can prove this whole-runtime
  // read came from the SAME runtime the status read established before adopting its data.
  return { ok: true, reachable: true, gates, runtimeId: metaRuntimeId(value), proc };
}

// First non-empty string among the candidates, else null. Candidates are drawn from a
// SINGLE provenance domain (all nested, or all flat) — never mixed — so the authoritative
// rule below is honored; it exists only to pick among tolerated aliases within that domain.
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) return candidate;
  }
  return null;
}

function orcaDispatchShow(run, orcaBin, taskId, options = {}) {
  const proc = run(orcaBin, ["orchestration", "dispatch-show", "--task", String(taskId), "--json"], options);
  const { ok, value } = envelope(proc);
  if (!ok) return { ok: false, reachable: false, proc };
  const result = value.result || {};
  // Real mid-2026 shape (D4.3): provenance is nested under result.dispatch — task id at
  // task_id, dispatch id at id (tolerating dispatch_id), assignee at assignee_handle
  // (tolerating assignee/to). When result.dispatch is a present object it is AUTHORITATIVE:
  // facts resolve ONLY inside it, so an empty/missing nested field stays null (upstream →
  // PROVENANCE_MISMATCH / MISSING_*) rather than being rescued by a legacy flat field. The
  // flat fields apply ONLY when result.dispatch is absent or is not an object.
  const nested = result.dispatch && typeof result.dispatch === "object" ? result.dispatch : null;
  const facts = nested
    ? {
        taskId: firstNonEmpty(nested.task_id),
        dispatchId: firstNonEmpty(nested.id, nested.dispatch_id),
        assignee: firstNonEmpty(nested.assignee_handle, nested.assignee, nested.to),
      }
    : {
        taskId: firstNonEmpty(result.task_id),
        dispatchId: firstNonEmpty(result.dispatch_id),
        assignee: firstNonEmpty(result.assignee),
      };
  // Terminal presence: an explicit `terminal_present:false` in result OR result.dispatch (or
  // a null resolved assignee) means the dispatched operator terminal is gone (feeds
  // MISSING_TERMINAL, D7).
  const terminalGone = result.terminal_present === false || (nested && nested.terminal_present === false);
  const terminalPresent = terminalGone ? false : Boolean(facts.assignee);
  return {
    ok: true,
    reachable: true,
    taskId: facts.taskId,
    dispatchId: facts.dispatchId,
    assignee: facts.assignee,
    terminalPresent,
    // A17: expose the per-task read's `_meta.runtimeId` so the caller can prove THIS
    // task's dispatch-show came from the receipt's runtime before adopting its facts.
    runtimeId: metaRuntimeId(value),
    proc,
  };
}

module.exports = { orcaStatus, orcaTaskList, orcaGateList, orcaDispatchShow };
