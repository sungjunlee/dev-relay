#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getCanonicalRepoRoot,
  getActorName,
  getRelayHome,
  getRubricGrandfatherMetadata,
  readManifest,
  writeManifest,
} = require("./relay-manifest");
const { appendRunEvent } = require("./relay-events");
const { resolveManifestRecord } = require("./relay-resolver");

const HELP_TEXT = `Usage: relay-migrate-rubric.js [options]

Applies rubric-grandfather stamps from the migration manifest.

Options:
  --repo <path>         Repo root (default: canonical cwd)
  --manifest <path>     Migration manifest path (default: ~/.relay/migrations/rubric-mandatory.yaml)
  --dry-run             Print what would happen without writing
  --json                Output JSON`;
const RUBRIC_MIGRATION_MANIFEST_BASENAME = "rubric-mandatory.yaml";

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function formatScalar(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function parseField(line, location) {
  const separator = line.indexOf(":");
  if (separator === -1) {
    throw new Error(`${location}: expected key: value entry, got ${JSON.stringify(line)}`);
  }
  const key = line.slice(0, separator).trim();
  const rawValue = line.slice(separator + 1).trim();
  if (!key) {
    throw new Error(`${location}: missing key in ${JSON.stringify(line)}`);
  }
  return { key, value: parseScalar(rawValue) };
}

function validateMigrationEntry(entry, index, manifestPath) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${manifestPath}: runs[${index}] must be an object`);
  }
  for (const field of ["run_id", "registered_by", "registered_at", "reason"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`${manifestPath}: runs[${index}].${field} is required`);
    }
  }
  if (Number.isNaN(Date.parse(entry.registered_at))) {
    throw new Error(`${manifestPath}: runs[${index}].registered_at must be an ISO timestamp`);
  }
  if (entry.applied_at !== undefined && entry.applied_at !== null) {
    if (
      typeof entry.applied_at !== "string"
      || entry.applied_at.trim() === ""
      || Number.isNaN(Date.parse(entry.applied_at))
    ) {
      throw new Error(`${manifestPath}: runs[${index}].applied_at must be a non-empty ISO timestamp string when set`);
    }
  }
}

function parseMigrationManifest(text, manifestPath) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let version = null;
  let inRuns = false;
  let currentEntry = null;
  const runs = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = rawLine.match(/^ */)[0].length;
    if (indent === 0) {
      currentEntry = null;
      if (trimmed === "runs:") {
        inRuns = true;
        continue;
      }
      const field = parseField(trimmed, `${manifestPath}:${index + 1}`);
      if (field.key !== "version") {
        throw new Error(`${manifestPath}:${index + 1}: unsupported top-level key ${JSON.stringify(field.key)}`);
      }
      version = field.value;
      continue;
    }

    if (indent === 2 && trimmed.startsWith("- ")) {
      if (!inRuns) {
        throw new Error(`${manifestPath}:${index + 1}: list entries are only allowed under runs:`);
      }
      currentEntry = {};
      runs.push(currentEntry);
      const inline = trimmed.slice(2).trim();
      if (inline) {
        const field = parseField(inline, `${manifestPath}:${index + 1}`);
        currentEntry[field.key] = field.value;
      }
      continue;
    }

    if (indent === 4) {
      if (!currentEntry) {
        throw new Error(`${manifestPath}:${index + 1}: nested run fields require a preceding '- ' entry`);
      }
      const field = parseField(trimmed, `${manifestPath}:${index + 1}`);
      currentEntry[field.key] = field.value;
      continue;
    }

    throw new Error(`${manifestPath}:${index + 1}: unsupported indentation`);
  }

  if (version !== 1) {
    throw new Error(`${manifestPath}: version must be 1`);
  }

  const seenRunIds = new Set();
  runs.forEach((entry, index) => {
    validateMigrationEntry(entry, index, manifestPath);
    if (seenRunIds.has(entry.run_id)) {
      throw new Error(`${manifestPath}: duplicate run_id ${JSON.stringify(entry.run_id)}`);
    }
    seenRunIds.add(entry.run_id);
  });

  return { version, runs };
}

function readMigrationManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration manifest not found: ${manifestPath}`);
  }
  const text = fs.readFileSync(manifestPath, "utf-8");
  return parseMigrationManifest(text, manifestPath);
}

function readOptionalMigrationManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, runs: [] };
  }
  return readMigrationManifest(manifestPath);
}

function serializeMigrationManifest(document) {
  const lines = ["version: 1", "runs:"];
  for (const entry of document.runs || []) {
    lines.push(`  - run_id: ${formatScalar(entry.run_id)}`);
    lines.push(`    registered_by: ${formatScalar(entry.registered_by)}`);
    lines.push(`    registered_at: ${formatScalar(entry.registered_at)}`);
    lines.push(`    reason: ${formatScalar(entry.reason)}`);
    if (entry.applied_at !== undefined && entry.applied_at !== null) {
      lines.push(`    applied_at: ${formatScalar(entry.applied_at)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeMigrationManifest(manifestPath, document) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, serializeMigrationManifest(document), "utf-8");
  fs.renameSync(tmpPath, manifestPath);
}

function buildEntriesByRunId(document) {
  return new Map((document.runs || []).map((entry) => [entry.run_id, entry]));
}

function requireMigrationEntry(entriesByRunId, runId, manifestPath) {
  const entry = entriesByRunId.get(runId);
  if (!entry) {
    throw new Error(
      `Run ${runId} is not listed in migration manifest ${manifestPath}; refusing to stamp anchor.rubric_grandfathered.`
    );
  }
  return entry;
}

function createProvenanceStamp({ repoRoot, entry, manifestPath, appliedAt }) {
  return {
    from_migration: RUBRIC_MIGRATION_MANIFEST_BASENAME,
    applied_at: appliedAt,
    actor: getActorName(repoRoot),
    reason: entry.reason,
  };
}

function applyMigrationStamp({ repoRoot, runId, entriesByRunId, manifestPath, dryRun = false, appliedAt }) {
  const entry = requireMigrationEntry(entriesByRunId, runId, manifestPath);
  const manifestRecord = resolveManifestRecord({ repoRoot, runId });
  const currentMetadata = getRubricGrandfatherMetadata(manifestRecord.data);

  // One-shot semantic: once a run carries object-form provenance, do not let a
  // cleared migration-manifest applied_at field re-stamp it. That prevents a
  // tamper-then-rerun flow from silently rewriting audit provenance.
  if (currentMetadata.provenance || currentMetadata.diagnostic) {
    throw new Error(
      `Run ${runId} already has pre-existing object-form anchor.rubric_grandfathered state; refusing to re-apply from ${manifestPath}.`
    );
  }

  const stamp = createProvenanceStamp({
    repoRoot,
    entry,
    manifestPath,
    appliedAt,
  });
  const nextManifest = {
    ...manifestRecord.data,
    anchor: {
      ...(manifestRecord.data.anchor || {}),
      rubric_grandfathered: stamp,
    },
  };

  if (!dryRun) {
    writeManifest(manifestRecord.manifestPath, nextManifest, manifestRecord.body);
    appendRunEvent(repoRoot, runId, {
      event: "rubric_migrated",
      state_from: manifestRecord.data.state,
      state_to: manifestRecord.data.state,
      head_sha: manifestRecord.data.git?.head_sha || null,
      reason: `${path.basename(manifestPath)}: ${entry.reason}`,
    });
  }

  return {
    run_id: runId,
    manifest_path: manifestRecord.manifestPath,
    applied_at: appliedAt,
    provenance: stamp,
    dry_run: dryRun,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  let repoArg = ".";
  let manifestArg = path.join(getRelayHome(), "migrations", RUBRIC_MIGRATION_MANIFEST_BASENAME);
  let dryRun = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repoArg = args[index + 1];
      index += 1;
    } else if (arg === "--manifest") {
      manifestArg = args[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!repoArg) {
    throw new Error("--repo requires a path");
  }
  if (!manifestArg) {
    throw new Error("--manifest requires a path");
  }

  return {
    repoRoot: getCanonicalRepoRoot(repoArg),
    manifestPath: path.resolve(manifestArg),
    dryRun,
    json,
  };
}

function getAuthoritativeMigrationManifestPath() {
  return path.join(getRelayHome(), "migrations", RUBRIC_MIGRATION_MANIFEST_BASENAME);
}

function syncAuthoritativeMigrationEntry({ document, runId, sourceEntry, appliedAt }) {
  const nextEntry = {
    ...sourceEntry,
    applied_at: appliedAt,
  };
  const existingIndex = (document.runs || []).findIndex((entry) => entry.run_id === runId);
  if (existingIndex === -1) {
    document.runs = [...(document.runs || []), nextEntry];
    return;
  }
  document.runs[existingIndex] = {
    ...document.runs[existingIndex],
    applied_at: appliedAt,
  };
}

function runMigration(options) {
  const document = readMigrationManifest(options.manifestPath);
  const entriesByRunId = buildEntriesByRunId(document);
  const authoritativeManifestPath = getAuthoritativeMigrationManifestPath();
  const sharesAuthoritativeManifest = options.manifestPath === authoritativeManifestPath;
  const authoritativeDocument = sharesAuthoritativeManifest
    ? document
    : readOptionalMigrationManifest(authoritativeManifestPath);
  const result = {
    repoRoot: options.repoRoot,
    manifestPath: options.manifestPath,
    dryRun: options.dryRun,
    applied: [],
    skipped: [],
  };

  for (const entry of document.runs) {
    if (entry.applied_at !== undefined && entry.applied_at !== null) {
      result.skipped.push({
        run_id: entry.run_id,
        status: "already_applied",
        applied_at: entry.applied_at,
      });
      continue;
    }

    const appliedAt = new Date().toISOString();
    const applied = applyMigrationStamp({
      repoRoot: options.repoRoot,
      runId: entry.run_id,
      entriesByRunId,
      manifestPath: options.manifestPath,
      dryRun: options.dryRun,
      appliedAt,
    });
    result.applied.push(applied);
    if (!options.dryRun) {
      entry.applied_at = appliedAt;
      writeMigrationManifest(options.manifestPath, document);
      if (!sharesAuthoritativeManifest) {
        syncAuthoritativeMigrationEntry({
          document: authoritativeDocument,
          runId: entry.run_id,
          sourceEntry: entry,
          appliedAt,
        });
        writeMigrationManifest(authoritativeManifestPath, authoritativeDocument);
      }
    }
  }

  result.appliedCount = result.applied.length;
  result.skippedCount = result.skipped.length;
  return result;
}

function main() {
  try {
    const options = parseArgs(process.argv);
    const result = runMigration(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Migration manifest: ${result.manifestPath}`);
      console.log(`Repo root: ${result.repoRoot}`);
      console.log(`Applied: ${result.appliedCount}`);
      console.log(`Skipped: ${result.skippedCount}`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  applyMigrationStamp,
  buildEntriesByRunId,
  parseMigrationManifest,
  readMigrationManifest,
  requireMigrationEntry,
  runMigration,
  serializeMigrationManifest,
  writeMigrationManifest,
};
