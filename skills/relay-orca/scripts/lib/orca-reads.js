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
  if (!ok) return { ok: false, reachable: false, gates: [], proc };
  const result = value.result || {};
  const gates = Array.isArray(result.gates) ? result.gates : [];
  return { ok: true, reachable: true, gates, proc };
}

function orcaDispatchShow(run, orcaBin, taskId, options = {}) {
  const proc = run(orcaBin, ["orchestration", "dispatch-show", "--task", String(taskId), "--json"], options);
  const { ok, value } = envelope(proc);
  if (!ok) return { ok: false, reachable: false, proc };
  const result = value.result || {};
  const assignee = isNonEmptyString(result.assignee) ? result.assignee : null;
  // Terminal presence: an explicit `terminal_present:false` (or a null assignee)
  // means the dispatched operator terminal is gone (feeds MISSING_TERMINAL, D7).
  const terminalPresent = result.terminal_present === false ? false : Boolean(assignee);
  return {
    ok: true,
    reachable: true,
    taskId: isNonEmptyString(result.task_id) ? result.task_id : null,
    dispatchId: isNonEmptyString(result.dispatch_id) ? result.dispatch_id : null,
    assignee,
    terminalPresent,
    proc,
  };
}

module.exports = { orcaStatus, orcaTaskList, orcaGateList, orcaDispatchShow };
