const fs = require("fs");
const path = require("path");

const {
  ensureRunLayout,
  getRunDir,
  getSidecarOutputDir,
  getSidecarsDir,
  getSidecarsIndexPath,
  isPathContainedWithin,
} = require("./manifest/paths");
const {
  readTextFileWithoutFollowingSymlinks,
  writeTextFileWithoutFollowingSymlinks,
} = require("./manifest/rubric");
const { buildArtifactTimingFields } = require("./advisory-timing");
const { appendRunEvent, EVENTS } = require("./relay-events");

const SIDECAR_STATUSES = Object.freeze(["pending", "running", "completed", "failed"]);
const SIDECAR_TRUST_LEVEL = "advisory";
const SIDECAR_STATUS_SET = new Set(SIDECAR_STATUSES);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function normalizeNullableString(value, field) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null`);
  }
  return value;
}

function validateOutputPath(repoRoot, runId, sidecarId, outputPath) {
  const normalizedOutputPath = requireNonEmptyString(outputPath, "output_path");
  const segments = normalizedOutputPath.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(normalizedOutputPath) || segments.includes("..")) {
    throw new Error(`output_path must be run-dir-relative and may not escape the run directory: ${JSON.stringify(outputPath)}`);
  }

  const runDir = getRunDir(repoRoot, runId);
  const resolvedOutputPath = path.resolve(runDir, normalizedOutputPath);
  if (!isPathContainedWithin(runDir, resolvedOutputPath)) {
    throw new Error(`output_path must resolve inside the run directory: ${JSON.stringify(outputPath)}`);
  }

  const sidecarOutputDir = getSidecarOutputDir(repoRoot, runId, sidecarId);
  if (!isPathContainedWithin(sidecarOutputDir, resolvedOutputPath)) {
    throw new Error(
      `output_path must be under sidecars/${sidecarId}/ for the matching sidecar id: ${JSON.stringify(outputPath)}`
    );
  }
  return normalizedOutputPath;
}

function validateSidecarEntry(repoRoot, runId, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("sidecar entry must be an object");
  }
  if (!SIDECAR_STATUS_SET.has(entry.status)) {
    throw new Error(`status must be one of: ${SIDECAR_STATUSES.join(", ")}`);
  }
  if (entry.trust_level !== SIDECAR_TRUST_LEVEL) {
    throw new Error(`trust_level must be ${JSON.stringify(SIDECAR_TRUST_LEVEL)}`);
  }

  const id = requireNonEmptyString(entry.id, "id");

  return {
    id,
    kind: requireNonEmptyString(entry.kind, "kind"),
    executor: requireNonEmptyString(entry.executor, "executor"),
    model: normalizeNullableString(entry.model, "model"),
    provider: normalizeNullableString(entry.provider, "provider"),
    status: entry.status,
    output_path: validateOutputPath(repoRoot, runId, id, entry.output_path),
    trust_level: SIDECAR_TRUST_LEVEL,
  };
}

function normalizeIndexShape(repoRoot, runId, parsed, indexPath) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid sidecars index at ${indexPath}: expected an object`);
  }
  if (!Array.isArray(parsed.sidecars)) {
    throw new Error(`Invalid sidecars index at ${indexPath}: sidecars must be an array`);
  }
  return {
    sidecars: parsed.sidecars.map((entry) => validateSidecarEntry(repoRoot, runId, entry)),
  };
}

function readSidecarIndex(repoRoot, runId) {
  const indexPath = getSidecarsIndexPath(repoRoot, runId);
  let rawText;
  try {
    rawText = readTextFileWithoutFollowingSymlinks(indexPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { sidecars: [] };
    }
    if (error.code === "ELOOP") {
      throw new Error(`Refusing to read symlinked sidecars index at ${indexPath}: ${error.message}`);
    }
    throw error;
  }
  return normalizeIndexShape(repoRoot, runId, JSON.parse(rawText), indexPath);
}

function writeSidecarIndex(repoRoot, runId, index) {
  ensureRunLayout(repoRoot, runId);
  const sidecarsDir = getSidecarsDir(repoRoot, runId);
  const indexPath = getSidecarsIndexPath(repoRoot, runId);
  fs.mkdirSync(sidecarsDir, { recursive: true });
  try {
    writeTextFileWithoutFollowingSymlinks(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`Refusing to write symlinked sidecars index at ${indexPath}: ${error.message}`);
    }
    throw error;
  }
}

function upsertSidecarEntry(repoRoot, runId, entry) {
  const normalizedEntry = validateSidecarEntry(repoRoot, runId, entry);
  const index = readSidecarIndex(repoRoot, runId);
  const existingIndex = index.sidecars.findIndex((candidate) => candidate?.id === normalizedEntry.id);
  const nextSidecars = [...index.sidecars];
  if (existingIndex === -1) {
    nextSidecars.push(normalizedEntry);
  } else {
    nextSidecars[existingIndex] = normalizedEntry;
  }

  const nextIndex = { sidecars: nextSidecars };
  writeSidecarIndex(repoRoot, runId, nextIndex);
  return normalizedEntry;
}

function appendSidecarStart(repoRoot, runId, { id, kind, executor, model, provider } = {}) {
  const eventData = {
    event: EVENTS.SIDECAR_START,
    sidecar_id: requireNonEmptyString(id, "id"),
    kind: requireNonEmptyString(kind, "kind"),
    executor: requireNonEmptyString(executor, "executor"),
    trust_level: SIDECAR_TRUST_LEVEL,
    ...(model !== undefined ? { model: normalizeNullableString(model, "model") } : {}),
    ...(provider !== undefined ? { provider: normalizeNullableString(provider, "provider") } : {}),
  };
  return appendRunEvent(repoRoot, runId, eventData);
}

function appendSidecarResult(repoRoot, runId, {
  id,
  kind,
  output_path,
  elapsed_ms,
  critical_path_wait_ms = 0,
  consumed_by_phase = "metrics",
  phase_decision_waited = false,
  frontier_step_replaced = false,
} = {}) {
  const sidecarId = requireNonEmptyString(id, "id");
  return appendRunEvent(repoRoot, runId, {
    event: EVENTS.SIDECAR_RESULT,
    sidecar_id: sidecarId,
    kind: requireNonEmptyString(kind, "kind"),
    output_path: validateOutputPath(repoRoot, runId, sidecarId, output_path),
    trust_level: SIDECAR_TRUST_LEVEL,
    ...buildArtifactTimingFields({
      artifactKind: "sidecar",
      elapsedMs: elapsed_ms || 0,
      criticalPathWaitMs: critical_path_wait_ms,
      consumedByPhase: consumed_by_phase,
      phaseDecisionWaited: phase_decision_waited,
      frontierStepReplaced: frontier_step_replaced,
    }),
  });
}

function appendSidecarFailed(repoRoot, runId, {
  id,
  kind,
  failure_reason,
  elapsed_ms,
  critical_path_wait_ms = 0,
  consumed_by_phase = "metrics",
  phase_decision_waited = false,
  frontier_step_replaced = false,
} = {}) {
  return appendRunEvent(repoRoot, runId, {
    event: EVENTS.SIDECAR_FAILED,
    sidecar_id: requireNonEmptyString(id, "id"),
    kind: requireNonEmptyString(kind, "kind"),
    failure_reason: requireNonEmptyString(failure_reason, "failure_reason"),
    ...(elapsed_ms !== undefined
      ? buildArtifactTimingFields({
          artifactKind: "sidecar",
          elapsedMs: elapsed_ms,
          criticalPathWaitMs: critical_path_wait_ms,
          consumedByPhase: consumed_by_phase,
          phaseDecisionWaited: phase_decision_waited,
          frontierStepReplaced: frontier_step_replaced,
        })
      : {}),
  });
}

module.exports = {
  appendSidecarFailed,
  appendSidecarResult,
  appendSidecarStart,
  readSidecarIndex,
  SIDECAR_STATUSES,
  SIDECAR_TRUST_LEVEL,
  upsertSidecarEntry,
};
