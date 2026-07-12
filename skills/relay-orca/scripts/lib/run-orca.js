"use strict";

// Orca CLI adapter for relay-orca `run` — PURE argv builders + response parsers.
// It never touches the Node subprocess module: the CLI-invocation boundary
// (timeout, poison guards, stdin) lives in run.js, mirroring how the frozen probe
// keeps its spawn helpers out of scripts/lib/ so plan.js's D6 source scan stays
// green. Every step function receives an injected `run(orcaBin, args, options)`.
//
// Every CLI-derived value embedded in a message passes through boundedExcerpt so a
// wedged or adversarial CLI cannot inflate the run report.
const EXCERPT_LIMIT = 256;

// Collapse whitespace and truncate so the returned excerpt — the `…` marker
// included — is at most EXCERPT_LIMIT characters total.
function boundedExcerpt(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LIMIT) return text;
  return `${text.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "empty stdout" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message, excerpt: boundedExcerpt(text) };
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function pickString(result, keys) {
  if (!result || typeof result !== "object") return null;
  for (const key of keys) {
    if (isNonEmptyString(result[key])) return result[key];
  }
  return null;
}

function extractTaskId(payload) {
  const result = payload && payload.result;
  const direct = pickString(result, ["task_id", "taskId", "id"]);
  if (direct) return direct;
  if (result && result.task) return pickString(result.task, ["id", "task_id"]);
  return null;
}

function extractDispatchId(payload) {
  const result = payload && payload.result;
  const direct = pickString(result, ["dispatch_id", "dispatchId", "id"]);
  if (direct) return direct;
  if (result && result.dispatch) return pickString(result.dispatch, ["id", "dispatch_id"]);
  return null;
}

function extractAssignee(payload) {
  const result = payload && payload.result;
  const direct = pickString(result, ["assignee", "to", "handle"]);
  if (direct) return direct;
  if (result && result.dispatch) return pickString(result.dispatch, ["assignee", "to"]);
  return null;
}

function extractHandle(payload) {
  const result = payload && payload.result;
  const direct = pickString(result, ["handle", "terminal_id", "terminalId", "id"]);
  if (direct) return direct;
  if (result && result.terminal) return pickString(result.terminal, ["handle", "id"]);
  return null;
}

// A subprocess is "ok" only when it exited 0, produced parseable JSON, and that
// JSON's top-level ok is exactly true — the same fail-closed test the probe uses.
function envelopeOk(proc, parsed) {
  return proc.status === 0 && parsed.ok && parsed.value && parsed.value.ok === true;
}

function createTask(run, orcaBin, { title, spec, deps }, options = {}) {
  const args = ["orchestration", "task-create", "--spec", spec, "--task-title", title];
  if (Array.isArray(deps) && deps.length) args.push("--deps", JSON.stringify(deps));
  args.push("--json");
  const proc = run(orcaBin, args, options);
  const parsed = parseJson(proc.stdout);
  const taskId = envelopeOk(proc, parsed) ? extractTaskId(parsed.value) : null;
  return { ok: envelopeOk(proc, parsed) && isNonEmptyString(taskId), taskId, proc, parsed };
}

function dispatchTask(run, orcaBin, { orcaTaskId, handle }, options = {}) {
  const args = ["orchestration", "dispatch", "--task", orcaTaskId, "--to", handle, "--inject", "--json"];
  const proc = run(orcaBin, args, options);
  const parsed = parseJson(proc.stdout);
  return { ok: envelopeOk(proc, parsed), proc, parsed };
}

function showDispatch(run, orcaBin, { orcaTaskId }, options = {}) {
  const args = ["orchestration", "dispatch-show", "--task", orcaTaskId, "--json"];
  const proc = run(orcaBin, args, options);
  const parsed = parseJson(proc.stdout);
  if (!envelopeOk(proc, parsed)) return { ok: false, proc, parsed };
  return {
    ok: true,
    taskId: extractTaskId(parsed.value),
    dispatchId: extractDispatchId(parsed.value),
    assignee: extractAssignee(parsed.value),
    proc,
    parsed,
  };
}

function createTerminal(run, orcaBin, options = {}) {
  const proc = run(orcaBin, ["terminal", "create", "--json"], options);
  const parsed = parseJson(proc.stdout);
  const handle = envelopeOk(proc, parsed) ? extractHandle(parsed.value) : null;
  return { ok: envelopeOk(proc, parsed) && isNonEmptyString(handle), handle, proc, parsed };
}

// Prompt delivery (D6 step 3). Called ONLY after provenance verification. The
// prompt is passed on stdin (via options.input) so a multi-line operator prompt
// never lands in argv (and never corrupts the invocation log used by tests).
function sendPrompt(run, orcaBin, { orcaTaskId, handle, prompt }, options = {}) {
  const args = ["terminal", "send", "--to", handle, "--task", orcaTaskId, "--json"];
  const proc = run(orcaBin, args, { ...options, input: prompt });
  const parsed = parseJson(proc.stdout);
  return { ok: envelopeOk(proc, parsed), proc, parsed };
}

module.exports = {
  EXCERPT_LIMIT,
  boundedExcerpt,
  parseJson,
  isNonEmptyString,
  createTask,
  dispatchTask,
  showDispatch,
  createTerminal,
  sendPrompt,
};
