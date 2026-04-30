const fs = require("fs");
const path = require("path");

const {
  getRunDir,
  isPathContainedWithin,
  validateRunId,
} = require("./paths");
const { summarizeFailure } = require("./paths");

const RUBRIC_PASS_THROUGH_STATES = new Set(["loaded"]);

function hasRubricPath(data) {
  return typeof data?.anchor?.rubric_path === "string" && data.anchor.rubric_path.trim() !== "";
}

function rejectLegacyGrandfatherField(data) {
  const anchor = data?.anchor;
  if (!anchor || !Object.prototype.hasOwnProperty.call(anchor, "rubric_grandfathered")) {
    return { ok: true };
  }

  const rawValue = anchor.rubric_grandfathered;
  if (rawValue === undefined) {
    return { ok: true };
  }

  const runId = typeof data?.run_id === "string" && data.run_id.trim() !== ""
    ? data.run_id.trim()
    : "unknown-run";
  return {
    ok: false,
    error:
      `Run ${runId}: anchor.rubric_grandfathered is no longer supported. ` +
      "Remove anchor.rubric_grandfathered from the manifest and ensure anchor.rubric_path is set, " +
      "or close the run via close-run.js before retrying dispatch, review, or merge.",
  };
}

function resolveRubricRunDir(data, options = {}) {
  if (options.runDir) {
    return path.resolve(options.runDir);
  }

  const repoRoot = options.repoRoot || data?.paths?.repo_root || null;
  const runId = Object.prototype.hasOwnProperty.call(options, "runId")
    ? options.runId
    : data?.run_id;
  const validation = validateRunId(runId);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  if (!repoRoot) {
    return null;
  }
  return path.resolve(getRunDir(repoRoot, validation.runId));
}

function realpathSyncCompat(targetPath) {
  return typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);
}

function isRubricLookupError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function resolveRealPathCandidate(targetPath) {
  const pendingSegments = [];
  let currentPath = targetPath;

  for (;;) {
    try {
      const resolvedExistingPath = realpathSyncCompat(currentPath);
      return pendingSegments.length === 0
        ? resolvedExistingPath
        : path.join(resolvedExistingPath, ...pendingSegments);
    } catch (error) {
      if (!isRubricLookupError(error)) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      pendingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function validateRubricPathContainment(rubricPath, runDir) {
  const normalizedPath = typeof rubricPath === "string" ? rubricPath.trim() : "";
  const resolvedRunDir = typeof runDir === "string" && runDir.trim() !== ""
    ? path.resolve(runDir)
    : null;
  const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
  const containsParentTraversal = segments.includes("..");
  const absolute = normalizedPath ? path.isAbsolute(normalizedPath) : false;
  const resolvedPath = normalizedPath && resolvedRunDir
    ? path.resolve(resolvedRunDir, normalizedPath)
    : null;
  const insideRunDir = Boolean(
    resolvedRunDir
    && resolvedPath
    && isPathContainedWithin(resolvedRunDir, resolvedPath)
  );

  if (!normalizedPath) {
    return {
      valid: false,
      status: "missing_path",
      rubricPath: null,
      runDir: resolvedRunDir,
      resolvedPath: null,
      reason: "anchor.rubric_path is not set.",
    };
  }

  if (!resolvedRunDir) {
    return {
      valid: false,
      status: "run_dir_unavailable",
      rubricPath: normalizedPath,
      runDir: null,
      resolvedPath: null,
      reason: `Unable to resolve the run directory for anchor.rubric_path=${JSON.stringify(normalizedPath)}.`,
    };
  }

  if (absolute) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory; absolute paths are not allowed (got ${JSON.stringify(normalizedPath)}).`,
    };
  }

  if (containsParentTraversal) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory and may not contain '..' segments (got ${JSON.stringify(normalizedPath)}).`,
    };
  }

  if (!insideRunDir) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory ${JSON.stringify(resolvedRunDir)} (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(resolvedPath)}).`,
    };
  }

  try {
    const rubricEntry = fs.lstatSync(resolvedPath);
    if (rubricEntry.isSymbolicLink()) {
      return {
        valid: false,
        status: "symlink_escape",
        rubricPath: normalizedPath,
        runDir: resolvedRunDir,
        resolvedPath,
        realPath: null,
        reason: `anchor.rubric_path must not be a symlink (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(resolvedPath)}).`,
      };
    }
  } catch (error) {
    if (!isRubricLookupError(error)) {
      throw error;
    }
  }

  try {
    const realRunDir = resolveRealPathCandidate(resolvedRunDir);
    const realRubricPath = resolveRealPathCandidate(resolvedPath);
    if (!isPathContainedWithin(realRunDir, realRubricPath)) {
      return {
        valid: false,
        status: "follows_outside_run_dir",
        rubricPath: normalizedPath,
        runDir: resolvedRunDir,
        resolvedPath,
        realPath: realRubricPath,
        reason: `anchor.rubric_path must stay inside the real run directory ${JSON.stringify(realRunDir)} after symlink resolution (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(realRubricPath)}).`,
      };
    }

    return {
      valid: true,
      status: "contained",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      realPath: realRubricPath,
      reason: null,
    };
  } catch (error) {
    return {
      valid: false,
      status: "run_dir_unavailable",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      realPath: null,
      reason: `Unable to resolve the real run directory for anchor.rubric_path=${JSON.stringify(normalizedPath)}: ${summarizeFailure(error)}`,
    };
  }
}

const ERR_NOT_REGULAR_FILE = "ENOT_REGULAR_FILE";

function readTextFileWithoutFollowingSymlinks(targetPath, realPath) {
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  const nonBlockFlag = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const openPath = realPath || targetPath;

  if (typeof noFollowFlag === "number") {
    let fd = null;
    try {
      fd = fs.openSync(openPath, fs.constants.O_RDONLY | noFollowFlag | nonBlockFlag);
    } catch (error) {
      if (!["ELOOP", "ENOTSUP", "EINVAL"].includes(error.code)) {
        throw error;
      }
    }
    if (fd !== null) {
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
          const error = new Error(`Not a regular file: ${openPath}`);
          error.code = ERR_NOT_REGULAR_FILE;
          throw error;
        }
        return fs.readFileSync(fd, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  const targetEntry = fs.lstatSync(targetPath);
  if (targetEntry.isSymbolicLink()) {
    const error = new Error(`Refusing to read symlinked path: ${targetPath}`);
    error.code = "ELOOP";
    throw error;
  }
  if (!targetEntry.isFile()) {
    const error = new Error(`Not a regular file: ${targetPath}`);
    error.code = ERR_NOT_REGULAR_FILE;
    throw error;
  }

  const fd = fs.openSync(openPath, fs.constants.O_RDONLY | nonBlockFlag);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      const error = new Error(`Not a regular file: ${openPath}`);
      error.code = ERR_NOT_REGULAR_FILE;
      throw error;
    }
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function gateWritableFd(fd, targetPath) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    const error = new Error(`Not a regular file: ${targetPath}`);
    error.code = ERR_NOT_REGULAR_FILE;
    throw error;
  }
  return fd;
}

function openForWriteWithoutFollowingSymlinks(targetPath, mode) {
  const modeFlags = {
    w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  };
  const flags = modeFlags[mode];
  if (flags === undefined) {
    throw new Error(`openForWriteWithoutFollowingSymlinks: invalid mode ${mode}`);
  }
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  const nonBlockFlag = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

  if (typeof noFollowFlag === "number") {
    try {
      const fd = fs.openSync(targetPath, flags | noFollowFlag | nonBlockFlag, 0o600);
      return gateWritableFd(fd, targetPath);
    } catch (error) {
      if (error.code === "ELOOP") {
        const wrapped = new Error(`Refusing to open symlinked path: ${targetPath}`);
        wrapped.code = "ELOOP";
        throw wrapped;
      }
      if (!["ENOTSUP", "EINVAL"].includes(error.code)) {
        throw error;
      }
    }
  }

  let existingStat = null;
  try {
    existingStat = fs.lstatSync(targetPath);
  } catch (statError) {
    if (statError.code !== "ENOENT") throw statError;
  }
  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      const error = new Error(`Refusing to open symlinked path: ${targetPath}`);
      error.code = "ELOOP";
      throw error;
    }
    return gateWritableFd(fs.openSync(targetPath, flags | nonBlockFlag, 0o600), targetPath);
  }
  try {
    return gateWritableFd(fs.openSync(targetPath, flags | fs.constants.O_EXCL | nonBlockFlag, 0o600), targetPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const raced = fs.lstatSync(targetPath);
      if (raced.isSymbolicLink()) {
        const wrapped = new Error(`Refusing to open symlinked path: ${targetPath}`);
        wrapped.code = "ELOOP";
        throw wrapped;
      }
      return gateWritableFd(fs.openSync(targetPath, flags | nonBlockFlag, 0o600), targetPath);
    }
    throw error;
  }
}

function writeAllSync(fd, text, targetPath) {
  const buffer = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      const error = new Error(
        `writeSync made no progress writing to ${targetPath} at offset ${offset}/${buffer.length}`
      );
      error.code = "EIO";
      throw error;
    }
    offset += written;
  }
}

function appendTextFileWithoutFollowingSymlinks(targetPath, text) {
  const fd = openForWriteWithoutFollowingSymlinks(targetPath, "a");
  try {
    writeAllSync(fd, text, targetPath);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTextFileWithoutFollowingSymlinks(targetPath, text) {
  const fd = openForWriteWithoutFollowingSymlinks(targetPath, "w");
  try {
    writeAllSync(fd, text, targetPath);
  } finally {
    fs.closeSync(fd);
  }
}

function getRubricAnchorStatus(data, options = {}) {
  const rubricPath = hasRubricPath(data) ? data.anchor.rubric_path.trim() : null;
  const runDir = resolveRubricRunDir(data, options);
  const legacyGrandfatherField = rejectLegacyGrandfatherField(data);
  const baseStatus = {
    status: "missing_path",
    rubricPath,
    runDir,
    resolvedPath: null,
    satisfied: false,
    exists: false,
    empty: false,
    content: null,
    note: null,
    error: null,
  };

  if (!legacyGrandfatherField.ok) {
    return {
      ...baseStatus,
      status: "legacy_grandfather_field",
      error: legacyGrandfatherField.error,
    };
  }

  if (!rubricPath) {
    return {
      ...baseStatus,
      error: "anchor.rubric_path is required before review/merge.",
    };
  }

  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    return {
      ...baseStatus,
      ...containment,
      status: containment.status,
      error: containment.reason,
    };
  }

  try {
    const content = readTextFileWithoutFollowingSymlinks(
      containment.resolvedPath,
      containment.realPath || containment.resolvedPath
    );
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return {
        ...baseStatus,
        ...containment,
        status: "empty",
        exists: true,
        empty: true,
        error: `rubric file is empty: ${containment.resolvedPath}`,
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "satisfied",
      satisfied: true,
      exists: true,
      content: options.includeContent ? trimmedContent : null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ...baseStatus,
        ...containment,
        status: "missing",
        error: `rubric file is missing from the run directory: ${containment.resolvedPath}`,
      };
    }

    if (error.code === "ELOOP") {
      return {
        ...baseStatus,
        ...containment,
        status: "symlink_escape",
        error: `anchor.rubric_path must not be a symlink (got ${JSON.stringify(containment.rubricPath)} -> ${JSON.stringify(containment.resolvedPath)}).`,
      };
    }

    if (error.code === "EINVAL" || error.code === ERR_NOT_REGULAR_FILE) {
      return {
        ...baseStatus,
        ...containment,
        status: "not_file",
        error: `anchor.rubric_path must point to a file inside the run directory (got ${JSON.stringify(containment.resolvedPath)}).`,
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "unreadable",
      error: `Unable to read rubric file ${containment.resolvedPath}: ${summarizeFailure(error)}`,
    };
  }
}

function formatRubricWarning(label, rubricAnchor) {
  const details = [];
  if (rubricAnchor.rubricPath) {
    details.push(`anchor.rubric_path=${JSON.stringify(rubricAnchor.rubricPath)}`);
  }
  if (rubricAnchor.resolvedPath) {
    details.push(`resolved_path=${JSON.stringify(rubricAnchor.resolvedPath)}`);
  }
  return [
    `WARNING: [${label}] ${rubricAnchor.error}`,
    details.length ? `Context: ${details.join(", ")}` : null,
    "Do NOT return PASS or ready_to_merge while this warning is present. Flag the invariant failure in the review output.",
  ].filter(Boolean).join("\n");
}

function createRubricLoad({ state, status, content, warning, rubricPath, resolvedPath, error }) {
  if (!RUBRIC_PASS_THROUGH_STATES.has(state) && warning === null) {
    throw new Error(`Rubric load state '${state}' must include a visible warning`);
  }
  return {
    state,
    status,
    content,
    warning,
    rubricPath,
    resolvedPath,
    error,
  };
}

function loadRubricFromRunDir(runDir, manifestData) {
  const rubricAnchor = getRubricAnchorStatus(manifestData, { runDir, includeContent: true });
  switch (rubricAnchor.status) {
    case "satisfied":
      return createRubricLoad({
        state: "loaded",
        status: rubricAnchor.status,
        content: rubricAnchor.content,
        warning: null,
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing_path":
      return createRubricLoad({
        state: "not_set",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path not set", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing":
      return createRubricLoad({
        state: "missing",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric missing", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "outside_run_dir":
      return createRubricLoad({
        state: "outside_run_dir",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path outside run dir", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "empty":
      return createRubricLoad({
        state: "empty",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric empty", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    default:
      return createRubricLoad({
        state: "invalid",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric invalid", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
  }
}

function buildRubricRecoveryCommand(runId, redispatchPath) {
  return `node skills/relay-dispatch/scripts/dispatch.js . --run-id ${runId} --prompt-file ${redispatchPath} --rubric-file <fixed-rubric.yaml>`;
}

/**
 * Rubric fail-closed moves the run into `changes_requested` so the documented
 * `dispatch --run-id` recovery command remains executable without widening
 * dispatcher resume rules for arbitrary `review_pending` runs.
 * `next_action=repair_rubric_and_redispatch` tells the operator to fix the
 * anchored rubric state, re-dispatch the run, then rerun relay-review, and
 * `review.latest_verdict="rubric_state_failed_closed"` records that the raw
 * reviewer PASS was blocked by review-runner rubric enforcement.
 */
function buildReviewRunnerRubricGateFailure(runId, redispatchPath, rubricLoad) {
  if (!rubricLoad || RUBRIC_PASS_THROUGH_STATES.has(rubricLoad.state)) {
    return null;
  }

  const recoveryCommand = buildRubricRecoveryCommand(runId, redispatchPath);
  const rerunReviewStep = "After the re-dispatch completes, rerun relay-review.";
  let recovery;
  switch (rubricLoad.state) {
    case "not_set":
      recovery = `Persist a rubric for this run, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "missing":
      recovery = `Restore or replace the missing rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "outside_run_dir":
      recovery = `Replace the escaped rubric anchor with a contained rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "empty":
      recovery = `Regenerate the empty rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    default:
      recovery = `Fix or replace the rubric anchor, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
  }

  return {
    status: "rubric_state_failed_closed",
    layer: "review-runner",
    rubricState: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    reason: rubricLoad.error || "Rubric is not loaded.",
    recoveryCommand,
    recovery,
    summary: `review-runner fail-closed: rubricLoad.state='${rubricLoad.state}' blocked ready_to_merge despite reviewer PASS. ${recovery}`,
  };
}

module.exports = {
  appendTextFileWithoutFollowingSymlinks,
  buildReviewRunnerRubricGateFailure,
  buildRubricRecoveryCommand,
  createRubricLoad,
  formatRubricWarning,
  getRubricAnchorStatus,
  hasRubricPath,
  loadRubricFromRunDir,
  rejectLegacyGrandfatherField,
  readTextFileWithoutFollowingSymlinks,
  RUBRIC_PASS_THROUGH_STATES,
  validateRubricPathContainment,
  writeTextFileWithoutFollowingSymlinks,
};
