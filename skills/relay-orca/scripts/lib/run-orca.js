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

function dispatchObject(result) {
  return result && typeof result.dispatch === "object" && result.dispatch ? result.dispatch : null;
}

// Real mid-2026 shape (D2): provenance is nested under result.dispatch — the task id at
// result.dispatch.task_id, the dispatch id at result.dispatch.id (tolerating dispatch_id),
// and the assignee at result.dispatch.assignee_handle (tolerating assignee/to). When
// result.dispatch is a present object it is AUTHORITATIVE: provenance resolves ONLY inside
// it, so an empty/missing nested value stays null (upstream → PROVENANCE_MISMATCH) rather
// than being rescued by a legacy flat field. The flat reads apply ONLY when result.dispatch
// is absent or is not an object.
function extractTaskId(payload) {
  const result = payload && payload.result;
  const dispatch = dispatchObject(result);
  if (dispatch) return pickString(dispatch, ["task_id"]);
  const direct = pickString(result, ["task_id", "taskId", "id"]);
  if (direct) return direct;
  if (result && result.task) return pickString(result.task, ["id", "task_id"]);
  return null;
}

function extractDispatchId(payload) {
  const result = payload && payload.result;
  const dispatch = dispatchObject(result);
  if (dispatch) return pickString(dispatch, ["id", "dispatch_id"]);
  return pickString(result, ["dispatch_id", "dispatchId", "id"]);
}

function extractAssignee(payload) {
  const result = payload && payload.result;
  const dispatch = dispatchObject(result);
  if (dispatch) return pickString(dispatch, ["assignee_handle", "assignee", "to"]);
  return pickString(result, ["assignee", "to", "handle"]);
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

// Prompt delivery (D6 step 3). Called ONLY after provenance verification. The real
// mid-2026 CLI is `orca terminal send --terminal <handle> --text <text> [--enter] [--json]`
// — there is NO --to flag, NO --task flag, and NO stdin payload path (D1). The full
// operator prompt is delivered as ONE --text value in a SINGLE send (never split), and the
// success gate stays fail-closed and unchanged (exit 0 + JSON + ok===true).
function sendPrompt(run, orcaBin, { handle, prompt }, options = {}) {
  const args = ["terminal", "send", "--terminal", handle, "--text", String(prompt), "--enter", "--json"];
  const proc = run(orcaBin, args, options);
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
  sendPrompt,
};
