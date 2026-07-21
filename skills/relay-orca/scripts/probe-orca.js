"use strict";

// relay-orca capability probe — fail-closed runtime admission (issue #942).
// Default mode is strictly READ-ONLY (D1). Explicit --smoke performs a
// self-cleaning synthetic injection check (D9). Never invokes orchestration reset (D2).
//
// Subprocess helpers live HERE (not under scripts/lib/) so plan.js's frozen
// D6 source scan — which forbids child_process across every lib module — stays green.
const { execFileSync } = require("node:child_process");
const { resolveOrcaBin, isRunnableFile, MACOS_BUNDLE_FALLBACK } = require("./lib/resolve-orca-bin");
const { REASONS, USAGE_EXIT, ProbeError, reject } = require("./lib/probe-reasons");
const { classifyHistoricalState } = require("./lib/admission-history");
const { loadPriorProgramContexts, PriorProgramContextError } = require("./prior-program-context");
const { programSegment } = require("./lib/program-segment");

const SMOKE_TITLE_MARKER = "relay-orca-probe-smoke";
const SMOKE_SPEC = "relay-orca capability probe synthetic smoke (self-cleaning)";
// Real Orca task-update --status enum (mid-2026). Synthetic probe tasks terminalize as
// failed — honest for a self-cleaning admission check. Never use "cancelled" (not accepted).
const SMOKE_TERMINAL_STATUS = "failed";
// Admission-blocking (live) task states. completed/failed are historical and ignored.
const ACTIVE_TASK_STATUSES = new Set(["pending", "ready", "dispatched", "blocked"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
const EXCERPT_LIMIT = 256;
// Every Orca invocation is bounded so a hung CLI still reaches the rejection
// matrix instead of hanging the probe forever. Tests may shorten the wall-clock
// budget via RELAY_ORCA_PROBE_TIMEOUT_MS (positive integer; invalid → default).
const DEFAULT_PROBE_TIMEOUT_MS = 10000;
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

const JSON_KEYS = Object.freeze([
  "ok",
  "admitted",
  "orca_bin",
  "orca_version",
  "runtime_id",
  "runtime_ready",
  "orchestration_available",
  "existing_state",
  "checks",
  "blocking_reasons",
  "smoke",
]);

// Single bounded-rendering helper (D8). EVERY subprocess-derived value embedded
// in a human-readable message/remediation must pass through this so an adversarial
// or wedged CLI cannot inflate or line-inject a blocking message. Collapses
// whitespace and truncates so the RETURNED excerpt — the `…` marker included — is
// at most EXCERPT_LIMIT characters total (EXCERPT_LIMIT-1 input chars + marker).
function boundedExcerpt(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LIMIT) return text;
  return `${text.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function resolveProbeTimeoutMs(env) {
  const raw = (env || process.env).RELAY_ORCA_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_PROBE_TIMEOUT_MS;
}

function runOrca(orcaBin, args, options = {}) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv.includes("reset")) {
    throw new Error("probe-orca must never invoke orca orchestration reset (D2)");
  }
  const exec = options.execFileSync || execFileSync;
  const env = options.env || process.env;
  try {
    const stdout = exec(orcaBin, argv, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: resolveProbeTimeoutMs(env),
      maxBuffer: PROBE_MAX_BUFFER,
    });
    return { status: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (error) {
    // A timed-out command is killed by signal (status null) → status 1 here, so
    // it flows through the same per-check classification as any spawn failure.
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "empty stdout" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message, excerpt: boundedExcerpt(text) };
  }
}

function parseArgs(argv) {
  const opts = {
    json: false,
    smoke: false,
    smokeTo: null,
    orcaBin: null,
    repoRoot: null,
    priorProgramContexts: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--smoke") opts.smoke = true;
    else if (arg === "--smoke-to") {
      const value = argv[(i += 1)];
      if (!value || value.startsWith("-")) {
        usageError("--smoke-to requires a live agent terminal handle");
      }
      opts.smokeTo = value;
    } else if (arg === "--orca-bin") {
      const value = argv[(i += 1)];
      if (!value || value.startsWith("-")) usageError("--orca-bin requires a path");
      opts.orcaBin = value;
    } else if (arg === "--repo-root") {
      const value = argv[(i += 1)];
      if (!value || value.startsWith("-")) usageError("--repo-root requires a path");
      opts.repoRoot = value;
    } else if (arg === "--prior-program-context") {
      const value = argv[(i += 1)];
      if (!value || value.startsWith("-")) usageError("--prior-program-context requires a path");
      opts.priorProgramContexts.push(value);
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
  // Fail fast before any smoke task state is created: --smoke needs an explicit
  // live recognized-agent terminal. Synthetic handles can never accept --inject.
  if (opts.smoke && !isNonEmptyString(opts.smokeTo)) {
    usageError(
      "--smoke requires --smoke-to <live-agent-terminal-handle> " +
        "(a terminal already running a recognized agent CLI such as claude, codex, gemini, or droid)",
    );
  }
  if (isNonEmptyString(opts.smokeTo) && !opts.smoke) {
    usageError("--smoke-to requires --smoke");
  }
  return opts;
}

function usageError(message) {
  process.stderr.write(`relay-orca probe: ${message}\n`);
  process.stderr.write(
    "usage: probe-orca.js [--json] [--smoke --smoke-to <handle>] [--orca-bin <path>] " +
      "[--repo-root <path>] [--prior-program-context <context.json>] ...\n",
  );
  process.exit(USAGE_EXIT);
}

function emptyResult(smokeRequested) {
  return {
    ok: false,
    admitted: false,
    orca_bin: null,
    orca_version: null,
    runtime_id: null,
    runtime_ready: false,
    orchestration_available: false,
    existing_state: { tasks: null, gates: null },
    checks: [],
    blocking_reasons: [],
    smoke: {
      requested: Boolean(smokeRequested),
      ran: false,
      cleaned_up: null,
      task_id: null,
      dispatch_id: null,
      assignee: null,
    },
  };
}

function recordCheck(checks, name, status) {
  checks.push({ name, status });
}

function skipRemaining(checks, names) {
  names.forEach((name) => {
    if (!checks.some((entry) => entry.name === name)) {
      recordCheck(checks, name, "skipped");
    }
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isIntegerCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function looksLikeUnknownCommand(stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`.toLowerCase();
  return text.includes("unknown command") || text.includes("unrecognized");
}

function assertStatusShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { malformed: true, message: "status JSON is not an object" };
  }
  if (typeof payload.ok !== "boolean") {
    return { malformed: true, message: "status.ok must be a boolean" };
  }
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { malformed: true, message: "status.result must be an object" };
  }
  const app = result.app;
  const runtime = result.runtime;
  const graph = result.graph;
  if (!app || typeof app !== "object" || typeof app.running !== "boolean") {
    return { malformed: true, message: "status.result.app.running must be a boolean" };
  }
  if (!runtime || typeof runtime !== "object") {
    return { malformed: true, message: "status.result.runtime must be an object" };
  }
  if (typeof runtime.reachable !== "boolean") {
    return { malformed: true, message: "status.result.runtime.reachable must be a boolean" };
  }
  if (typeof runtime.state !== "string") {
    return { malformed: true, message: "status.result.runtime.state must be a string" };
  }
  if (!("runtimeId" in runtime) || (runtime.runtimeId !== null && typeof runtime.runtimeId !== "string")) {
    return { malformed: true, message: "status.result.runtime.runtimeId must be a string" };
  }
  if (!graph || typeof graph !== "object" || typeof graph.state !== "string") {
    return { malformed: true, message: "status.result.graph.state must be a string" };
  }
  return { malformed: false, payload };
}

function evaluateReadiness(payload) {
  const ready =
    payload.ok === true &&
    payload.result.app.running === true &&
    payload.result.runtime.reachable === true &&
    payload.result.runtime.state === "ready" &&
    isNonEmptyString(payload.result.runtime.runtimeId) &&
    payload.result.graph.state === "ready";
  return {
    ready,
    runtimeId: isNonEmptyString(payload.result.runtime.runtimeId)
      ? payload.result.runtime.runtimeId
      : null,
  };
}

function parseListPayload(payload, listKey) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { malformed: true, message: `${listKey} JSON is not an object` };
  }
  if (typeof payload.ok !== "boolean") {
    return { malformed: true, message: `${listKey}.ok must be a boolean` };
  }
  return { malformed: false, payload };
}

function extractListCount(payload, listKey, arrayKey) {
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { malformed: true, message: `${listKey}.result must be an object` };
  }
  if (!(arrayKey in result) || !Array.isArray(result[arrayKey])) {
    return { malformed: true, message: `${listKey}.result.${arrayKey} must be an array` };
  }
  if (!("count" in result)) {
    return { malformed: true, message: `${listKey}.result.count is missing` };
  }
  if (!isIntegerCount(result.count)) {
    return { ambiguous: true, message: `${listKey}.result.count must be a non-negative integer` };
  }
  // A count that contradicts its own array admits pre-existing state the D6 gate
  // must reject (e.g. count:0 alongside a non-empty array). Fail closed.
  if (result.count !== result[arrayKey].length) {
    return {
      ambiguous: true,
      message:
        `${listKey}.result.count (${result.count}) does not match ` +
        `${arrayKey}.length (${result[arrayKey].length})`,
    };
  }
  return { count: result.count, items: result[arrayKey] };
}

/**
 * Count admission-blocking (non-terminal) tasks. Historical completed/failed tasks
 * remain listed by the real CLI indefinitely but must not brick later probes.
 * Unknown/missing/malformed status fails closed as ambiguous.
 */
function countActiveTasks(items) {
  let active = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ambiguous: true,
        message: `task-list.result.tasks[${i}] is not an object`,
      };
    }
    const status = item.status;
    if (typeof status !== "string" || status.length === 0) {
      return {
        ambiguous: true,
        message:
          `task-list.result.tasks[${i}] lacks a non-empty status string; ` +
          "admission cannot classify terminal vs live state",
      };
    }
    if (TERMINAL_TASK_STATUSES.has(status)) continue;
    if (ACTIVE_TASK_STATUSES.has(status)) {
      active += 1;
      continue;
    }
    return {
      ambiguous: true,
      message:
        `task-list.result.tasks[${i}] has unknown status ` +
        `"${boundedExcerpt(status)}"; expected one of pending|ready|dispatched|blocked|completed|failed`,
    };
  }
  return { count: active };
}

function metaRuntimeId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const meta = payload._meta;
  if (!meta || typeof meta !== "object") return null;
  return typeof meta.runtimeId === "string" ? meta.runtimeId : null;
}

function extractCreatedId(payload, keys) {
  if (!payload || typeof payload !== "object") return null;
  const result = payload.result;
  if (!result || typeof result !== "object") return null;
  for (const key of keys) {
    if (isNonEmptyString(result[key])) return result[key];
  }
  if (result.task && isNonEmptyString(result.task.id)) return result.task.id;
  if (result.dispatch && isNonEmptyString(result.dispatch.id)) return result.dispatch.id;
  return null;
}

function extractAssignee(payload) {
  if (!payload || typeof payload !== "object") return null;
  const result = payload.result;
  if (!result || typeof result !== "object") return null;
  if (isNonEmptyString(result.assignee)) return result.assignee;
  if (result.dispatch && isNonEmptyString(result.dispatch.assignee)) {
    return result.dispatch.assignee;
  }
  if (isNonEmptyString(result.to)) return result.to;
  return null;
}

function blockingReason(error) {
  return {
    reason_code: error.reasonCode,
    message: error.message,
    remediation: error.remediation || "",
  };
}

function printResult(result, json) {
  if (json) {
    const ordered = {};
    JSON_KEYS.forEach((key) => {
      ordered[key] = result[key];
    });
    process.stdout.write(`${JSON.stringify(ordered, null, 2)}\n`);
    return;
  }
  if (result.admitted) {
    process.stdout.write(
      `relay-orca probe: admitted (orca_bin=${result.orca_bin}, runtime_id=${result.runtime_id})\n`,
    );
  } else {
    const reason = result.blocking_reasons[0];
    process.stderr.write(
      `relay-orca probe rejected [${reason ? reason.reason_code : "UNKNOWN"}]: ` +
        `${reason ? reason.message : "not admitted"}\n`,
    );
  }
}

function runSmoke(result, orcaBin, run, options) {
  result.smoke.ran = true;
  let cleanedUp = false;
  let taskId = null;
  let dispatchId = null;
  let assignee = null;
  let smokeError = null;
  let cleanupError = null;
  let syntheticTaskMaybeCreated = false;
  const smokeTo = options.smokeTo;

  try {
    const createProc = run(
      orcaBin,
      [
        "orchestration",
        "task-create",
        "--spec",
        SMOKE_SPEC,
        "--task-title",
        `${SMOKE_TITLE_MARKER} admission check`,
        "--json",
      ],
      options.runOptions,
    );
    const createParsed = parseJsonOutput(createProc.stdout);
    if (
      createProc.status !== 0 ||
      !createParsed.ok ||
      !createParsed.value ||
      createParsed.value.ok !== true
    ) {
      smokeError = new ProbeError(
        "SMOKE_FAILED",
        `smoke task-create failed` +
          (createProc.stderr ? `: ${boundedExcerpt(createProc.stderr)}` : ""),
      );
    } else {
      taskId = extractCreatedId(createParsed.value, ["task_id", "taskId", "id"]);
      result.smoke.task_id = taskId;
      if (!isNonEmptyString(taskId)) {
        // task-create reported ok but returned no id: a synthetic task may have been
        // created that we can neither reference nor clean up. Fail closed and hand the
        // operator the title marker so they can find and terminalize it manually.
        syntheticTaskMaybeCreated = true;
        smokeError = new ProbeError(
          "SMOKE_FAILED",
          "smoke task-create returned ok without a non-empty task id; a synthetic task " +
            "may have been created without a returned id",
          `Locate any untracked synthetic task by its "${SMOKE_TITLE_MARKER}" title marker ` +
            "via `orca orchestration task-list`, then terminalize it manually (never run reset).",
        );
      }
    }

    if (!smokeError) {
      const dispatchProc = run(
        orcaBin,
        [
          "orchestration",
          "dispatch",
          "--task",
          taskId,
          "--to",
          smokeTo,
          "--inject",
          "--json",
        ],
        options.runOptions,
      );
      const dispatchParsed = parseJsonOutput(dispatchProc.stdout);
      if (
        dispatchProc.status !== 0 ||
        !dispatchParsed.ok ||
        !dispatchParsed.value ||
        dispatchParsed.value.ok !== true
      ) {
        smokeError = new ProbeError(
          "SMOKE_FAILED",
          `smoke dispatch --inject to ${boundedExcerpt(smokeTo)} failed` +
            (dispatchProc.stderr ? `: ${boundedExcerpt(dispatchProc.stderr)}` : ""),
          "Ensure --smoke-to names a live terminal already running a recognized agent CLI " +
            "(claude, codex, gemini, or droid). Synthetic handles cannot accept --inject.",
        );
      } else {
        dispatchId = extractCreatedId(dispatchParsed.value, [
          "dispatch_id",
          "dispatchId",
          "id",
        ]);
        assignee = extractAssignee(dispatchParsed.value);
        result.smoke.dispatch_id = dispatchId;
        result.smoke.assignee = assignee;
        if (!isNonEmptyString(dispatchId) || !isNonEmptyString(assignee)) {
          smokeError = new ProbeError(
            "SMOKE_FAILED",
            "smoke dispatch provenance incomplete " +
              `(task_id=${boundedExcerpt(taskId)}, dispatch_id=${boundedExcerpt(dispatchId)}, ` +
              `assignee=${boundedExcerpt(assignee)})`,
          );
        } else if (assignee !== smokeTo) {
          smokeError = new ProbeError(
            "SMOKE_FAILED",
            "smoke dispatch assignee provenance mismatch " +
              `(expected --smoke-to=${boundedExcerpt(smokeTo)}, got assignee=${boundedExcerpt(assignee)})`,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof ProbeError) smokeError = error;
    else {
      smokeError = new ProbeError(
        "SMOKE_FAILED",
        `smoke failed: ${boundedExcerpt(error.message)}`,
      );
    }
  }

  // Cleanup ONLY smoke-created ids; never reset (D2/D9). Terminalize as failed — the
  // real CLI accepts failed (not cancelled) as a terminal status.
  if (isNonEmptyString(taskId)) {
    const updateProc = run(
      orcaBin,
      [
        "orchestration",
        "task-update",
        "--id",
        taskId,
        "--status",
        SMOKE_TERMINAL_STATUS,
        "--json",
      ],
      options.runOptions,
    );
    const updateParsed = parseJsonOutput(updateProc.stdout);
    const updateOk =
      updateProc.status === 0 &&
      updateParsed.ok &&
      updateParsed.value &&
      updateParsed.value.ok === true;
    if (updateOk) {
      cleanedUp = true;
    } else {
      cleanedUp = false;
      cleanupError = new ProbeError(
        "SMOKE_CLEANUP_FAILED",
        `failed to terminalize smoke-created task leftover id=${boundedExcerpt(taskId)}` +
          (updateProc.stderr ? `: ${boundedExcerpt(updateProc.stderr)}` : ""),
      );
    }
  } else if (syntheticTaskMaybeCreated) {
    // No id came back, so there is nothing to reference and no cleanup is attempted.
    // Report cleaned_up=false truthfully because an untracked synthetic task may exist.
    cleanedUp = false;
  } else {
    cleanedUp = true;
  }

  result.smoke.cleaned_up = cleanedUp;

  // When provenance and cleanup both fail, retain BOTH reasons — do not overwrite
  // the primary SMOKE_FAILED cause with SMOKE_CLEANUP_FAILED.
  if (smokeError && cleanupError) {
    recordCheck(result.checks, "smoke", "failed");
    smokeError.additionalReasons = [cleanupError];
    throw smokeError;
  }
  if (cleanupError) {
    recordCheck(result.checks, "smoke", "failed");
    throw cleanupError;
  }
  if (smokeError) {
    recordCheck(result.checks, "smoke", "failed");
    throw smokeError;
  }

  recordCheck(result.checks, "smoke", "ok");
  result.ok = true;
  result.admitted = true;
  return result;
}

/**
 * Run the capability probe. Mutates options._result when provided so callers
 * can still emit the D8 JSON envelope after a thrown ProbeError.
 */
function probe(options = {}) {
  const smokeRequested = Boolean(options.smoke);
  const result = options._result || emptyResult(smokeRequested);
  result.smoke.requested = smokeRequested;

  const checkOrder = [
    "binary",
    "runtime_ready",
    "orchestration_available",
    "existing_state",
    "smoke",
  ];

  const resolved = resolveOrcaBin({
    orcaBinOverride: options.orcaBin || null,
    pathEnv: options.pathEnv,
    isRunnableFile: options.isRunnableFile,
    pathDelimiter: options.pathDelimiter,
  });

  if (!resolved.path) {
    recordCheck(result.checks, "binary", "failed");
    skipRemaining(result.checks, checkOrder.slice(1));
    reject(
      "BINARY_NOT_FOUND",
      `Orca CLI not found (checked --orca-bin, PATH, and ${MACOS_BUNDLE_FALLBACK})`,
    );
  }

  result.orca_bin = resolved.path;
  recordCheck(result.checks, "binary", "ok");
  // Version is best-effort only; the mid-2026 CLI has no version subcommand (D8).
  result.orca_version = null;

  const run = options.runOrca || runOrca;

  // --- D4 runtime readiness ---
  const statusProc = run(resolved.path, ["status", "--json"], options.runOptions);
  const statusParsed = parseJsonOutput(statusProc.stdout);
  if (!statusParsed.ok) {
    recordCheck(result.checks, "runtime_ready", "failed");
    skipRemaining(result.checks, checkOrder.slice(2));
    reject(
      "MALFORMED_OUTPUT",
      `orca status --json is not parseable JSON: ${statusParsed.error}` +
        (statusParsed.excerpt ? ` (excerpt: ${statusParsed.excerpt})` : ""),
    );
  }
  const statusShape = assertStatusShape(statusParsed.value);
  if (statusShape.malformed) {
    recordCheck(result.checks, "runtime_ready", "failed");
    skipRemaining(result.checks, checkOrder.slice(2));
    reject("MALFORMED_OUTPUT", `orca status --json shape invalid: ${statusShape.message}`);
  }
  // A failed readiness command must never admit, even when its (possibly cached or
  // partial) stdout is shape-valid and claims readiness. Unparseable/empty stdout
  // already stayed MALFORMED_OUTPUT above; only shape-valid stdout reaches here, so a
  // non-zero (or signal-killed → status 1) exit is a runtime failure, not malformed.
  if (statusProc.status !== 0) {
    recordCheck(result.checks, "runtime_ready", "failed");
    skipRemaining(result.checks, checkOrder.slice(2));
    reject(
      "RUNTIME_NOT_READY",
      `orca status --json exited non-zero (exit ${statusProc.status})` +
        (statusProc.stderr ? `: ${boundedExcerpt(statusProc.stderr)}` : ""),
    );
  }
  const readiness = evaluateReadiness(statusShape.payload);
  result.runtime_id = readiness.runtimeId;
  result.runtime_ready = readiness.ready;
  if (!readiness.ready) {
    recordCheck(result.checks, "runtime_ready", "failed");
    skipRemaining(result.checks, checkOrder.slice(2));
    reject(
      "RUNTIME_NOT_READY",
      "orca status --json did not report a ready runtime " +
        `(ok=${statusShape.payload.ok}, app.running=${statusShape.payload.result.app.running}, ` +
        `runtime.reachable=${statusShape.payload.result.runtime.reachable}, ` +
        `runtime.state=${boundedExcerpt(statusShape.payload.result.runtime.state)}, ` +
        `runtimeId=${boundedExcerpt(statusShape.payload.result.runtime.runtimeId)}, ` +
        `graph.state=${boundedExcerpt(statusShape.payload.result.graph.state)})`,
    );
  }
  recordCheck(result.checks, "runtime_ready", "ok");
  const statusRuntimeId = readiness.runtimeId;

  // --- D5 orchestration availability ---
  const taskListProc = run(
    resolved.path,
    ["orchestration", "task-list", "--json"],
    options.runOptions,
  );
  if (
    taskListProc.status !== 0 ||
    looksLikeUnknownCommand(taskListProc.stderr, taskListProc.stdout)
  ) {
    recordCheck(result.checks, "orchestration_available", "failed");
    skipRemaining(result.checks, checkOrder.slice(3));
    reject(
      "ORCHESTRATION_UNAVAILABLE",
      `orca orchestration task-list failed or is unknown` +
        (taskListProc.stderr
          ? `: ${boundedExcerpt(taskListProc.stderr)}`
          : ` (exit ${taskListProc.status})`),
    );
  }
  const taskListParsed = parseJsonOutput(taskListProc.stdout);
  if (!taskListParsed.ok) {
    recordCheck(result.checks, "orchestration_available", "failed");
    skipRemaining(result.checks, checkOrder.slice(3));
    reject(
      "MALFORMED_OUTPUT",
      `orca orchestration task-list --json is not parseable JSON: ${taskListParsed.error}` +
        (taskListParsed.excerpt ? ` (excerpt: ${taskListParsed.excerpt})` : ""),
    );
  }
  const taskListShape = parseListPayload(taskListParsed.value, "task-list");
  if (taskListShape.malformed) {
    recordCheck(result.checks, "orchestration_available", "failed");
    skipRemaining(result.checks, checkOrder.slice(3));
    reject("MALFORMED_OUTPUT", taskListShape.message);
  }
  if (taskListShape.payload.ok === false) {
    result.orchestration_available = false;
    recordCheck(result.checks, "orchestration_available", "failed");
    skipRemaining(result.checks, checkOrder.slice(3));
    reject("ORCHESTRATION_UNAVAILABLE", "orca orchestration task-list returned ok:false");
  }
  const taskCountInfo = extractListCount(taskListShape.payload, "task-list", "tasks");
  if (taskCountInfo.malformed) {
    recordCheck(result.checks, "orchestration_available", "failed");
    skipRemaining(result.checks, checkOrder.slice(3));
    reject("MALFORMED_OUTPUT", taskCountInfo.message);
  }
  if (taskCountInfo.ambiguous) {
    recordCheck(result.checks, "orchestration_available", "ok");
    result.orchestration_available = true;
    result.existing_state.tasks = null;
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject("AMBIGUOUS_GLOBAL_STATE", taskCountInfo.message);
  }
  result.orchestration_available = true;
  recordCheck(result.checks, "orchestration_available", "ok");

  // --- D6 existing global state ---
  const gateListProc = run(
    resolved.path,
    ["orchestration", "gate-list", "--json"],
    options.runOptions,
  );
  if (
    gateListProc.status !== 0 ||
    looksLikeUnknownCommand(gateListProc.stderr, gateListProc.stdout)
  ) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject(
      "ORCHESTRATION_UNAVAILABLE",
      `orca orchestration gate-list failed or is unknown` +
        (gateListProc.stderr
          ? `: ${boundedExcerpt(gateListProc.stderr)}`
          : ` (exit ${gateListProc.status})`),
    );
  }
  const gateListParsed = parseJsonOutput(gateListProc.stdout);
  if (!gateListParsed.ok) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject(
      "MALFORMED_OUTPUT",
      `orca orchestration gate-list --json is not parseable JSON: ${gateListParsed.error}` +
        (gateListParsed.excerpt ? ` (excerpt: ${gateListParsed.excerpt})` : ""),
    );
  }
  const gateListShape = parseListPayload(gateListParsed.value, "gate-list");
  if (gateListShape.malformed) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject("MALFORMED_OUTPUT", gateListShape.message);
  }
  if (gateListShape.payload.ok === false) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject("ORCHESTRATION_UNAVAILABLE", "orca orchestration gate-list returned ok:false");
  }
  const gateCountInfo = extractListCount(gateListShape.payload, "gate-list", "gates");
  if (gateCountInfo.malformed) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject("MALFORMED_OUTPUT", gateCountInfo.message);
  }
  if (gateCountInfo.ambiguous) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject("AMBIGUOUS_GLOBAL_STATE", gateCountInfo.message);
  }

  result.existing_state = { tasks: taskCountInfo.count, gates: gateCountInfo.count };

  const statusMetaId = metaRuntimeId(statusShape.payload);
  const taskMetaId = metaRuntimeId(taskListShape.payload);
  const gateMetaId = metaRuntimeId(gateListShape.payload);
  // Cross-runtime consistency: all FOUR runtime-id observations MUST be present,
  // non-empty, and identical — the D4-validated status runtime.runtimeId AND the
  // _meta.runtimeId echoed by the status, task-list, and gate-list responses. A
  // missing, empty, or non-string id on any response, or any disagreement among
  // the four, means the probe cannot establish that the responses came from one
  // runtime — the SAME failure as a mismatch → AMBIGUOUS_GLOBAL_STATE, never a
  // silent pass. The status response is observed twice on purpose: its D4 runtime
  // id and its own _meta.runtimeId must BOTH be present and agree.
  const runtimeIdSources = [
    ["status", statusRuntimeId],
    ["status", statusMetaId],
    ["task-list", taskMetaId],
    ["gate-list", gateMetaId],
  ];
  const idExcerpts =
    `status.runtime=${boundedExcerpt(statusRuntimeId)}, ` +
    `status._meta=${boundedExcerpt(statusMetaId)}, ` +
    `task-list=${boundedExcerpt(taskMetaId)}, gate-list=${boundedExcerpt(gateMetaId)}`;
  const missingIdSource = runtimeIdSources.find(([, id]) => !isNonEmptyString(id));
  if (missingIdSource) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject(
      "AMBIGUOUS_GLOBAL_STATE",
      `${missingIdSource[0]} response lacked a non-empty runtime id; ` +
        `cross-runtime consistency cannot be established (${idExcerpts})`,
    );
  }
  const mismatchedIdSource = runtimeIdSources.find(([, id]) => id !== statusRuntimeId);
  if (mismatchedIdSource) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject(
      "AMBIGUOUS_GLOBAL_STATE",
      `${mismatchedIdSource[0]} runtime id does not match the status runtime id; ` +
        `cross-runtime consistency cannot be established (${idExcerpts})`,
    );
  }

  // Only non-terminal tasks block admission in the frozen no-context mode. Historical
  // completed/failed tasks stay listed by the real CLI but must not brick later probes.
  // Unknown status fails closed. Keep this path byte-identical for #942 callers.
  const activeTaskInfo = countActiveTasks(taskCountInfo.items || []);
  if (activeTaskInfo.ambiguous) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    result.existing_state = { tasks: null, gates: gateCountInfo.count };
    reject("AMBIGUOUS_GLOBAL_STATE", activeTaskInfo.message);
  }
  result.existing_state = { tasks: activeTaskInfo.count, gates: gateCountInfo.count };

  const priorProgramContexts = Array.isArray(options.priorProgramContexts)
    ? options.priorProgramContexts
    : [];
  if (priorProgramContexts.length > 0) {
    let history;
    try {
      const contexts = loadPriorProgramContexts({
        inputs: priorProgramContexts,
        repoRoot: options.repoRoot,
        // Only a launching `run` supplies launchedProgramId; loadOne fails closed on a
        // prior-program context that is self-referential to it. The standalone probe passes
        // none, so its historical-admission behavior is unchanged.
        launchedProgramId: options.launchedProgramId,
        snapshot: {
          status: statusShape.payload,
          task_list: taskListShape.payload,
          gate_list: gateListShape.payload,
        },
      });
      history = classifyHistoricalState({
        tasks: taskCountInfo.items || [],
        gates: gateCountInfo.items || [],
        contexts,
        programSegment,
      });
    } catch (error) {
      recordCheck(result.checks, "existing_state", "failed");
      skipRemaining(result.checks, ["smoke"]);
      result.existing_state = { tasks: null, gates: null };
      const detail = error instanceof PriorProgramContextError ? error.message : "context could not be read";
      reject("AMBIGUOUS_GLOBAL_STATE", `prior-program context is untrustworthy: ${boundedExcerpt(detail)}`);
    }
    if (!history.ok) {
      recordCheck(result.checks, "existing_state", "failed");
      skipRemaining(result.checks, ["smoke"]);
      result.existing_state = {
        tasks: history.activeTasks ?? null,
        gates: history.blockingGates ?? null,
      };
      reject(history.reasonCode, boundedExcerpt(history.message));
    }
    result.existing_state = { tasks: history.activeTasks, gates: history.blockingGates };
  } else if (activeTaskInfo.count > 0 || gateCountInfo.count > 0) {
    recordCheck(result.checks, "existing_state", "failed");
    skipRemaining(result.checks, ["smoke"]);
    reject(
      "EXISTING_ORCHESTRATION_STATE",
      `existing orchestration state rejected ` +
        `(active_tasks=${activeTaskInfo.count}, gates=${gateCountInfo.count}); ` +
        "v0 admits only one active program per runtime and never adopts pre-existing state",
    );
  }
  recordCheck(result.checks, "existing_state", "ok");

  if (!smokeRequested) {
    recordCheck(result.checks, "smoke", "skipped");
    result.ok = true;
    result.admitted = true;
    return result;
  }

  return runSmoke(result, resolved.path, run, options);
}

function runMain(argv = process.argv.slice(2), runtime = {}) {
  const opts = parseArgs(argv);
  if (opts.help) usageError("fail-closed Orca capability probe");

  const result = emptyResult(opts.smoke);
  try {
    probe({
      smoke: opts.smoke,
      smokeTo: opts.smokeTo,
      orcaBin: opts.orcaBin,
      priorProgramContexts: opts.priorProgramContexts,
      repoRoot: opts.repoRoot || runtime.repoRoot,
      pathEnv: runtime.pathEnv,
      isRunnableFile: runtime.isRunnableFile,
      pathDelimiter: runtime.pathDelimiter,
      runOrca: runtime.runOrca,
      runOptions: runtime.runOptions,
      _result: result,
    });
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error;
    result.blocking_reasons = [blockingReason(error)];
    if (Array.isArray(error.additionalReasons)) {
      for (const extra of error.additionalReasons) {
        result.blocking_reasons.push(blockingReason(extra));
      }
    }
    result.ok = false;
    result.admitted = false;
    printResult(result, opts.json);
    process.exitCode = error.exitCode;
    return result;
  }

  printResult(result, opts.json);
  process.exitCode = 0;
  return result;
}

if (require.main === module) {
  runMain();
}

module.exports = {
  probe,
  runMain,
  parseArgs,
  emptyResult,
  JSON_KEYS,
  SMOKE_TITLE_MARKER,
  SMOKE_TERMINAL_STATUS,
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  REASONS,
  resolveOrcaBin,
  isRunnableFile,
  MACOS_BUNDLE_FALLBACK,
};
