#!/usr/bin/env node
"use strict";

// relay-orca `attach-marker` — supervised repair of the relay/orca correlation
// boundary. It reads an accepted program and one existing relay run, derives the
// canonical marker, then updates only the relay manifest and its audit journal.
// It deliberately does not read or write an Orca receipt and never replays a
// dispatch. The manifest is re-read while holding a bounded per-run lock so a
// stale caller cannot overwrite a concurrent marker or unrelated manifest edit.
const fs = require("node:fs");
const path = require("node:path");
const { resolveRepoContext, runsRoot, programSegment } = require("./receipt-io");
const { coordinationMarkerFor } = require("./lib/coordination-marker");
const {
  requireValidRunId,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  readManifest,
  withManifestTransaction,
  writeManifestUnlocked,
} = require("../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const {
  coordinationMarkerFromManifest,
  validateCoordinationMarker,
  withCoordinationMarker,
} = require("../../relay-dispatch/scripts/manifest/coordination");

const USAGE_EXIT = 64;

class AttachMarkerError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "AttachMarkerError";
    this.reasonCode = reasonCode;
  }
}

function usageError(message) {
  process.stderr.write(`relay-orca attach-marker: ${message}\n`);
  process.stderr.write(
    "usage: attach-marker.js --program-file <accepted-program.json> " +
      "--outcome-id <outcome-id> --run-id <run-id> [--repo-root <path>] [--json]\n",
  );
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = { programFile: null, outcomeId: null, runId: null, repoRoot: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-file" || arg === "-f") opts.programFile = requireValue(argv[(i += 1)], "--program-file");
    else if (arg === "--outcome-id" || arg === "-o") opts.outcomeId = requireValue(argv[(i += 1)], "--outcome-id");
    else if (arg === "--run-id" || arg === "-r") opts.runId = requireValue(argv[(i += 1)], "--run-id");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
  if (opts.help) return opts;
  if (!opts.programFile) usageError("--program-file is required");
  if (!opts.outcomeId) usageError("--outcome-id is required");
  if (!opts.runId) usageError("--run-id is required");
  return opts;
}

function unwrapProgram(value) {
  return value && value.program && typeof value.program === "object" && !Array.isArray(value.program)
    ? value.program
    : value;
}

function normalizeIssueNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readAcceptedProgram(programFile) {
  const resolved = path.resolve(programFile);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new AttachMarkerError("PROGRAM_FILE_INVALID", `cannot read accepted program file ${resolved}: ${error.message}`);
  }
  if (!stat.isFile()) throw new AttachMarkerError("PROGRAM_FILE_INVALID", `accepted program path is not a file: ${resolved}`);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (error) {
    throw new AttachMarkerError("PROGRAM_FILE_INVALID", `accepted program file is not valid JSON: ${error.message}`);
  }
  const program = unwrapProgram(parsed);
  if (!program || typeof program !== "object" || Array.isArray(program)) {
    throw new AttachMarkerError("PROGRAM_FILE_INVALID", "accepted program must be a JSON object");
  }
  if (typeof program.id !== "string" || program.id.trim() === "") {
    throw new AttachMarkerError("PROGRAM_FILE_INVALID", "accepted program id must be a non-empty string");
  }
  if (!Array.isArray(program.outcomes)) {
    throw new AttachMarkerError("PROGRAM_FILE_INVALID", "accepted program outcomes must be an array");
  }
  return program;
}

function deriveTarget(program, outcomeId) {
  const outcome = program.outcomes.find((entry) => entry && entry.id === outcomeId);
  if (!outcome) {
    throw new AttachMarkerError("OUTCOME_INVALID", `outcome ${JSON.stringify(outcomeId)} is not present in the accepted program`);
  }
  if (outcome.task_kind !== "relay_run") {
    throw new AttachMarkerError("OUTCOME_INVALID", `outcome ${JSON.stringify(outcomeId)} is not a relay_run task`);
  }
  const issueNumber = normalizeIssueNumber(outcome.issue);
  if (issueNumber === null) {
    throw new AttachMarkerError("OUTCOME_INVALID", `outcome ${JSON.stringify(outcomeId)} has no finite declared issue`);
  }
  const marker = coordinationMarkerFor(program.id, outcome.id, programSegment);
  try {
    validateCoordinationMarker(marker);
  } catch (error) {
    throw new AttachMarkerError("MARKER_INVALID", error.message);
  }
  return { issueNumber, marker, outcomeId, programId: program.id };
}

function readAndValidateManifest(manifestPath, runId, repoRoot, expectedIssue) {
  let record;
  try {
    record = readManifest(manifestPath);
  } catch (error) {
    throw new AttachMarkerError("MANIFEST_INVALID", `cannot read relay manifest: ${error.message}`);
  }
  const manifest = record.data;
  if (manifest.run_id !== runId) {
    throw new AttachMarkerError(
      "RUN_ID_MISMATCH",
      `manifest run_id ${JSON.stringify(manifest.run_id)} does not match requested run ${JSON.stringify(runId)}`,
    );
  }
  try {
    validateManifestPaths(manifest.paths, {
      expectedRepoRoot: repoRoot,
      manifestPath,
      expectedRunsBase: runsRoot(),
      runId,
      allowMissingWorktree: true,
      caller: "relay-orca attach-marker",
    });
  } catch (error) {
    throw new AttachMarkerError("MANIFEST_PATH_INVALID", error.message);
  }
  const manifestIssue = normalizeIssueNumber(manifest.issue && manifest.issue.number);
  if (manifestIssue === null || manifestIssue !== expectedIssue) {
    throw new AttachMarkerError(
      "ISSUE_MISMATCH",
      `relay run ${runId} issue ${JSON.stringify(manifestIssue)} does not match accepted outcome issue ${JSON.stringify(expectedIssue)}`,
    );
  }
  const existingMarker = coordinationMarkerFromManifest(manifest);
  if (existingMarker !== undefined) {
    try {
      validateCoordinationMarker(existingMarker);
    } catch (error) {
      throw new AttachMarkerError("MARKER_INVALID", `existing manifest marker is invalid: ${error.message}`);
    }
  }
  return { ...record, data: manifest };
}

function resolveRunPaths(repo, runId) {
  // Keep this resolver in lockstep with status/resume: receipt-io.runsRoot()
  // honors RELAY_ORCA_RUNS_ROOT before the relay-wide fallbacks. The slug and
  // run id remain canonical/single-segment values, so the recovery override
  // cannot broaden the target outside one repository/run path.
  const root = path.resolve(runsRoot());
  const repoDir = path.join(root, repo.slug);
  return {
    manifestPath: path.join(repoDir, `${runId}.md`),
    runDir: path.join(repoDir, runId),
    eventsPath: path.join(repoDir, runId, "events.jsonl"),
  };
}

function snapshotFile(filePath) {
  let entry;
  try {
    entry = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, kind: "missing", text: null };
    throw error;
  }
  if (entry.isSymbolicLink()) {
    return {
      exists: true,
      kind: "symlink",
      linkTarget: fs.readlinkSync(filePath),
      text: null,
    };
  }
  try {
    return { exists: true, kind: "regular", text: fs.readFileSync(filePath, "utf-8") };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, kind: "missing", text: null };
    throw error;
  }
}

function restoreFile(filePath, snapshot) {
  if (snapshot.kind === "symlink") {
    let entry;
    try {
      entry = fs.lstatSync(filePath);
    } catch (error) {
      throw new Error(`rollback refused to recreate journal symlink ${filePath}: ${error.message}`);
    }
    if (!entry.isSymbolicLink() || fs.readlinkSync(filePath) !== snapshot.linkTarget) {
      throw new Error(`rollback refused to replace changed journal boundary ${filePath}`);
    }
    // appendRunEvent refuses this boundary before writing. If a future writer
    // partially fails after opening it, leave the original symlink inode and
    // target untouched rather than replacing the boundary with a regular file.
    return;
  }
  if (!snapshot.exists) {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  const tmpPath = `${filePath}.rollback.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, snapshot.text, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function attachMarker({ opts, repo, target }) {
  const runId = requireValidRunId(opts.runId);
  const paths = resolveRunPaths(repo, runId);
  const { manifestPath, runDir, eventsPath } = paths;
  const initial = readAndValidateManifest(manifestPath, runId, repo.root, target.issueNumber);
  const initialMarker = coordinationMarkerFromManifest(initial.data);
  if (initialMarker === target.marker) return resultFor(target, runId, "already_present");
  if (initialMarker !== undefined) {
    throw new AttachMarkerError(
      "MARKER_CONFLICT",
      `relay run ${runId} already has a different coordination marker`,
    );
  }

  fs.mkdirSync(runDir, { recursive: true });
  try {
    return withManifestTransaction(manifestPath, () => {
      // The caller's first read is only an admission check. Always validate and
      // use the fresh record inside the shared manifest transaction before the
      // atomic write; lifecycle writers use this same transaction boundary.
      const fresh = readAndValidateManifest(manifestPath, runId, repo.root, target.issueNumber);
      const freshMarker = coordinationMarkerFromManifest(fresh.data);
      if (freshMarker === target.marker) return resultFor(target, runId, "already_present");
      if (freshMarker !== undefined) {
        throw new AttachMarkerError("MARKER_CONFLICT", `relay run ${runId} already has a different coordination marker`);
      }

      const manifestBefore = snapshotFile(manifestPath);
      const eventsBefore = snapshotFile(eventsPath);
      const updated = withCoordinationMarker(fresh.data, target.marker);
      try {
        writeManifestUnlocked(manifestPath, updated, fresh.body, { preserveMarker: false });
        appendRunEvent(repo.root, runId, {
          event: EVENTS.COORDINATION_MARKER_ATTACHED,
          state_from: updated.state || null,
          state_to: updated.state || null,
          head_sha: updated.git?.head_sha || null,
          reason: "supervised_relay_orca_marker_recovery",
          program_id: target.programId,
          outcome_id: target.outcomeId,
          issue_number: target.issueNumber,
          coordination_marker: target.marker,
          result: "attached",
        }, { eventsPath, lockHeld: true });
      } catch (error) {
        try {
          restoreFile(manifestPath, manifestBefore);
          restoreFile(eventsPath, eventsBefore);
        } catch (rollbackError) {
          throw new AttachMarkerError(
            "ATTACH_MARKER_ROLLBACK_FAILED",
            `marker persistence failed and rollback failed: ${rollbackError.message}; original error: ${error.message}`,
          );
        }
        throw new AttachMarkerError(
          "ATTACH_MARKER_PERSISTENCE_FAILED",
          `marker persistence failed; manifest and audit journal were restored: ${error.message}`,
        );
      }
      return resultFor(target, runId, "attached");
    });
  } catch (error) {
    if (error?.code === "MANIFEST_LOCK_TIMEOUT") {
      throw new AttachMarkerError("LOCK_TIMEOUT", `${error.message}; refusing to overwrite a concurrently changing manifest`);
    }
    throw error;
  }
}

function resultFor(target, runId, result) {
  return {
    ok: true,
    result,
    run_id: runId,
    program_id: target.programId,
    outcome_id: target.outcomeId,
    issue_number: target.issueNumber,
    coordination_marker: target.marker,
    receipt_mutated: false,
    executor_replayed: false,
  };
}

function printFailure(error, json) {
  const body = {
    ok: false,
    reason_code: error.reasonCode || "ATTACH_MARKER_FAILED",
    message: error.message,
  };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca attach-marker rejected [${body.reason_code}]: ${body.message}\n`);
  process.exitCode = 1;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("attach a derived relay-orca coordination marker to an existing relay run");
  try {
    const runId = requireValidRunId(opts.runId);
    const repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
    // Resolve the exact manifest path before any run-dir or journal mutation.
    const manifestPath = resolveRunPaths(repo, runId).manifestPath;
    if (!fs.existsSync(manifestPath)) {
      throw new AttachMarkerError("RUN_NOT_FOUND", `relay run manifest was not found at ${manifestPath}`);
    }
    const program = readAcceptedProgram(opts.programFile);
    const target = deriveTarget(program, opts.outcomeId);
    const result = attachMarker({ opts: { ...opts, runId }, repo, target });
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`attached coordination marker ${target.marker} to relay run ${runId} (${result.result})\n`);
  } catch (error) {
    printFailure(error, opts.json);
  }
}

if (require.main === module) main();

module.exports = {
  deriveTarget,
  readAndValidateManifest,
  attachMarker,
  resolveRunPaths,
};
