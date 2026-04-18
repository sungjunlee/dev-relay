const fs = require("fs");
const path = require("path");

const {
  getRelayHome,
  getRunDir,
  isPathContainedWithin,
  validateRunId,
} = require("./paths");
const { summarizeError } = require("./store");

function hasRubricPath(data) {
  return typeof data?.anchor?.rubric_path === "string" && data.anchor.rubric_path.trim() !== "";
}

const LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS = new Set();
const RUBRIC_GRANDFATHER_REQUIRED_FIELDS = Object.freeze(["from_migration", "applied_at", "actor"]);
const RUBRIC_MIGRATION_MANIFEST_BASENAME = "rubric-mandatory.yaml";
const STRICT_ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function warnLegacyRubricGrandfather(runId) {
  const normalizedRunId = typeof runId === "string" && runId.trim() !== ""
    ? runId.trim()
    : "unknown-run";
  if (LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS.has(normalizedRunId)) {
    return;
  }
  LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS.add(normalizedRunId);
  console.error(
    `Warning: run ${normalizedRunId} uses legacy boolean anchor.rubric_grandfathered=true; ` +
    "migrate it with relay-migrate-rubric.js."
  );
}

function isStrictIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }

  const match = STRICT_ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText,
    timezone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;

  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  const millisecond = millisecondText === undefined ? 0 : Number.parseInt(millisecondText, 10);
  const offsetHours = offsetHourText === undefined ? 0 : Number.parseInt(offsetHourText, 10);
  const offsetMinutes = offsetMinuteText === undefined ? 0 : Number.parseInt(offsetMinuteText, 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHours > 23 || offsetMinutes > 59) {
    return false;
  }

  const offsetTotalMinutes = timezone === "Z"
    ? 0
    : ((offsetSign === "-" ? -1 : 1) * ((offsetHours * 60) + offsetMinutes));
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - (offsetTotalMinutes * 60 * 1000);
  if (Number.isNaN(utcMillis)) {
    return false;
  }

  const localTimestamp = new Date(utcMillis + (offsetTotalMinutes * 60 * 1000));
  return (
    localTimestamp.getUTCFullYear() === year
    && localTimestamp.getUTCMonth() === month - 1
    && localTimestamp.getUTCDate() === day
    && localTimestamp.getUTCHours() === hour
    && localTimestamp.getUTCMinutes() === minute
    && localTimestamp.getUTCSeconds() === second
    && localTimestamp.getUTCMilliseconds() === millisecond
  );
}

function buildRubricGrandfatherDiagnostic(rawValue) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return "anchor.rubric_grandfathered must be true or an object with from_migration, applied_at, and actor.";
  }

  const missingFields = RUBRIC_GRANDFATHER_REQUIRED_FIELDS.filter((field) => {
    return typeof rawValue[field] !== "string" || rawValue[field].trim() === "";
  });
  if (missingFields.length > 0) {
    return `anchor.rubric_grandfathered object is invalid: missing ${missingFields.join(", ")}.`;
  }

  if (!isStrictIsoTimestamp(rawValue.applied_at)) {
    return `anchor.rubric_grandfathered.applied_at must be an ISO timestamp, got ${JSON.stringify(rawValue.applied_at)}.`;
  }

  if (rawValue.reason !== undefined && rawValue.reason !== null && typeof rawValue.reason !== "string") {
    return "anchor.rubric_grandfathered.reason must be a string when set.";
  }

  return null;
}

function loadMigrationManifest(manifestPath) {
  const { readMigrationManifest } = require("../relay-migrate-rubric");
  return readMigrationManifest(manifestPath);
}

function verifyRubricGrandfatherProvenance(data, provenance) {
  const runId = typeof data?.run_id === "string" ? data.run_id.trim() : "";
  if (!runId) {
    return "anchor.rubric_grandfathered provenance requires a valid run_id for migration-manifest verification.";
  }
  if (provenance.from_migration !== RUBRIC_MIGRATION_MANIFEST_BASENAME) {
    return (
      `anchor.rubric_grandfathered.from_migration must be ${JSON.stringify(RUBRIC_MIGRATION_MANIFEST_BASENAME)} ` +
      `for authoritative verification, got ${JSON.stringify(provenance.from_migration)}.`
    );
  }

  const manifestPath = path.join(getRelayHome(), "migrations", RUBRIC_MIGRATION_MANIFEST_BASENAME);

  try {
    const document = loadMigrationManifest(manifestPath);
    const entry = (document.runs || []).find((candidate) => candidate.run_id === runId);
    if (!entry) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `run ${runId} is not listed in the migration manifest.`
      );
    }
    if (!isStrictIsoTimestamp(entry.applied_at)) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `runs[].applied_at for run ${runId} must be a strict ISO timestamp.`
      );
    }
    const normalizedAppliedAt = new Date(Date.parse(entry.applied_at)).toISOString();
    if (normalizedAppliedAt !== provenance.applied_at) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `run ${runId} applied_at ${JSON.stringify(provenance.applied_at)} does not match migration manifest value ` +
        `${JSON.stringify(normalizedAppliedAt)}.`
      );
    }
  } catch (error) {
    return (
      `anchor.rubric_grandfathered provenance could not be verified against ${manifestPath}: ` +
      summarizeError(error)
    );
  }

  return null;
}

function getRubricGrandfatherMetadata(data) {
  const rawValue = data?.anchor?.rubric_grandfathered;
  if (rawValue === true) {
    warnLegacyRubricGrandfather(data?.run_id);
    return {
      grandfathered: true,
      legacyGrandfather: true,
      provenance: null,
      diagnostic: null,
    };
  }

  if (rawValue === undefined || rawValue === null || rawValue === false) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic: null,
    };
  }

  const diagnostic = buildRubricGrandfatherDiagnostic(rawValue);
  if (diagnostic) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic,
    };
  }

  const normalizedProvenance = {
    from_migration: rawValue.from_migration.trim(),
    applied_at: new Date(Date.parse(rawValue.applied_at)).toISOString(),
    actor: rawValue.actor.trim(),
    reason: typeof rawValue.reason === "string" && rawValue.reason.trim() !== ""
      ? rawValue.reason.trim()
      : null,
  };
  const verificationDiagnostic = verifyRubricGrandfatherProvenance(data, normalizedProvenance);
  if (verificationDiagnostic) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic: verificationDiagnostic,
    };
  }

  return {
    grandfathered: true,
    legacyGrandfather: false,
    provenance: normalizedProvenance,
    diagnostic: null,
  };
}

function isRubricGrandfathered(data) {
  return getRubricGrandfatherMetadata(data).grandfathered;
}

function formatRubricGrandfatherNote(metadata) {
  if (metadata.legacyGrandfather) {
    return "Grandfathered pre-rubric run via legacy boolean anchor.rubric_grandfathered=true. " +
      "This deprecated form should be migrated with relay-migrate-rubric.js.";
  }

  if (!metadata.provenance) {
    return "Grandfathered pre-rubric run.";
  }

  const details = [
    `migration=${metadata.provenance.from_migration}`,
    `applied_at=${metadata.provenance.applied_at}`,
    `actor=${metadata.provenance.actor}`,
  ];
  if (metadata.provenance.reason) {
    details.push(`reason=${metadata.provenance.reason}`);
  }
  return `Grandfathered pre-rubric run via migration provenance (${details.join(", ")}).`;
}

function prependGrandfatherDiagnostic(message, metadata) {
  if (!metadata?.diagnostic) {
    return message;
  }
  return `${metadata.diagnostic} ${message}`;
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
      reason: `Unable to resolve the real run directory for anchor.rubric_path=${JSON.stringify(normalizedPath)}: ${summarizeError(error)}`,
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
  const grandfatherMetadata = getRubricGrandfatherMetadata(data);
  const grandfathered = grandfatherMetadata.grandfathered;
  const baseStatus = {
    status: "missing_path",
    rubricPath,
    runDir,
    resolvedPath: null,
    grandfathered,
    grandfatherProvenance: grandfatherMetadata.provenance,
    legacyGrandfather: grandfatherMetadata.legacyGrandfather,
    satisfied: false,
    exists: false,
    empty: false,
    content: null,
    note: null,
    error: null,
  };

  if (grandfathered) {
    return {
      ...baseStatus,
      status: "grandfathered",
      satisfied: true,
      note: formatRubricGrandfatherNote(grandfatherMetadata),
    };
  }

  if (!rubricPath) {
    return {
      ...baseStatus,
      error: prependGrandfatherDiagnostic(
        "anchor.rubric_path is required before review/merge unless anchor.rubric_grandfathered is a valid legacy boolean or provenance object.",
        grandfatherMetadata
      ),
    };
  }

  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    return {
      ...baseStatus,
      ...containment,
      status: containment.status,
      error: prependGrandfatherDiagnostic(containment.reason, grandfatherMetadata),
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
        error: prependGrandfatherDiagnostic(`rubric file is empty: ${containment.resolvedPath}`, grandfatherMetadata),
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
        error: prependGrandfatherDiagnostic(
          `rubric file is missing from the run directory: ${containment.resolvedPath}`,
          grandfatherMetadata
        ),
      };
    }

    if (error.code === "ELOOP") {
      return {
        ...baseStatus,
        ...containment,
        status: "symlink_escape",
        error: prependGrandfatherDiagnostic(
          `anchor.rubric_path must not be a symlink (got ${JSON.stringify(containment.rubricPath)} -> ${JSON.stringify(containment.resolvedPath)}).`,
          grandfatherMetadata
        ),
      };
    }

    if (error.code === "EINVAL" || error.code === ERR_NOT_REGULAR_FILE) {
      return {
        ...baseStatus,
        ...containment,
        status: "not_file",
        error: prependGrandfatherDiagnostic(
          `anchor.rubric_path must point to a file inside the run directory (got ${JSON.stringify(containment.resolvedPath)}).`,
          grandfatherMetadata
        ),
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "unreadable",
      error: prependGrandfatherDiagnostic(
        `Unable to read rubric file ${containment.resolvedPath}: ${summarizeError(error)}`,
        grandfatherMetadata
      ),
    };
  }
}

module.exports = {
  appendTextFileWithoutFollowingSymlinks,
  getRubricAnchorStatus,
  getRubricGrandfatherMetadata,
  hasRubricPath,
  isRubricGrandfathered,
  readTextFileWithoutFollowingSymlinks,
  validateRubricPathContainment,
  writeTextFileWithoutFollowingSymlinks,
};
