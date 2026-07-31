#!/usr/bin/env node
"use strict";

/*
 * Record a same-HEAD, operator-executed replacement for a strict-review
 * evidence artifact whose required rubric gates are absent.  This deliberately
 * does not recover commits, publish, or advance state.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const { STATES } = require("./manifest/lifecycle");
const { getCanonicalRepoRoot, getRunDir, validateManifestPaths } = require("./manifest/paths");
const { getRubricAnchorStatus, readTextFileWithoutFollowingSymlinks } = require("./manifest/rubric");
const { extractVerificationGateDefinitions, hashFileSha256, writeExecutionEvidence } = require("./execution-evidence");
const { computeQualityExecutionStatus } = require("../../relay-review/scripts/review-runner/execution-evidence");
const { findUnknownFlags, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { execGit } = require("./exec");
const { readManifest, withManifestTransaction } = require("./manifest/store");

const args = process.argv.slice(2);
const CLI_OPTIONS = { commandName: "record-verification-evidence", reservedFlags: ["-h"] };
const hasFlag = (flag) => schemaHasFlag(args, flag, CLI_OPTIONS);
const arg = (flag, fallback) => readArg(args, flag, fallback, CLI_OPTIONS);
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const RECORDED_BY = "operator-confirmed-verification-v1";

function help(exitCode) {
  console.log("Usage: record-verification-evidence.js (--repo <path> --run-id <id> | --manifest <path>) --reason <text> [--observation-result <gate-name>=<file>]... [--dry-run] [--json]");
  console.log("\nRun every exact command gate serially in a clean retained worktree and replace only same-HEAD strict-preflight-blocked evidence.");
  console.log("Observation gates require one regular, non-symlink artifact each; the artifact is size-capped and copied into the run directory.");
  console.log("\nOptions:");
  for (const [flag, text] of [
    ["--repo", "Repository root used with --run-id (default: .)"], ["--run-id", "Relay run identifier"],
    ["--manifest", "Explicit manifest path"], ["--reason", "Required audit reason"],
    ["--observation-result", "Repeatable gate-name=regular-file observation artifact"], ["--dry-run", "Validate and print no artifact bodies"],
    ["--json", "Output JSON"], ["--help", "Show this help"],
  ]) console.log(`  ${flag} ${modeLabel(flag)} ${text}`);
  process.exit(exitCode);
}

function requireValue(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${flag} requires a non-empty value`);
  return value.trim();
}

function repeatedObservationArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--observation-result") values.push(argv[index + 1]);
    else if (argv[index].startsWith("--observation-result=")) values.push(argv[index].slice("--observation-result=".length));
  }
  return values.map((value) => requireValue(value, "--observation-result"));
}

function observationMap(values) {
  const result = new Map();
  for (const value of values) {
    const equals = value.indexOf("=");
    if (equals <= 0 || equals === value.length - 1) throw new Error("--observation-result must be <gate-name>=<file>");
    const name = value.slice(0, equals).trim();
    const source = value.slice(equals + 1).trim();
    if (!name || !source || result.has(name)) throw new Error("--observation-result gate names must be unique and non-empty");
    result.set(name, source);
  }
  return result;
}

function readSafeArtifact(source) {
  const resolved = path.resolve(source);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  if (noFollow === 0) {
    const initial = fs.lstatSync(resolved);
    if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("observation artifact must be a readable regular non-symlink file");
  }
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error("observation artifact must be a readable regular non-symlink file");
  }
  let data;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("observation artifact must be a regular non-symlink file");
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`observation artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    data = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (data.length > MAX_ARTIFACT_BYTES) throw new Error(`observation artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  return data;
}

function safeArtifact(source, destination) {
  const data = readSafeArtifact(source);
  writePrivateFile(destination, data);
  return hashFileSha256(destination);
}

function writePrivateFile(destination, data) {
  let existing = null;
  try { existing = fs.lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("refusing non-regular or symlinked verification artifact destination");
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, data); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (fd !== undefined && fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createStagingDir(runDir) {
  const stageDir = path.join(runDir, `.operator-verification-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(stageDir, { mode: 0o700 }); fs.chmodSync(stageDir, 0o700);
  return stageDir;
}

function discardStagingDir(stageDir) {
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
}

function boundedLog(stageDir, index, command, cwd) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd, encoding: "utf-8", maxBuffer: MAX_ARTIFACT_BYTES,
    }) || "";
  } catch (error) {
    exitCode = Number.isInteger(error.status) && error.status >= 0 ? error.status : 1;
    stdout = String(error.stdout || "");
    stderr = String(error.stderr || error.message || "");
  }
  const body = Buffer.from(`${stdout}\n${stderr}`, "utf-8").subarray(0, MAX_ARTIFACT_BYTES);
  const outputName = `operator-verification-gate-${index + 1}.log`;
  const outputPath = path.join(stageDir, outputName);
  writePrivateFile(outputPath, body);
  return { exitCode, outputName, outputPath, outputHash: hashFileSha256(outputPath) };
}

function resolveRecord(repoArg, runId, manifestArg) {
  return resolveManifestRecord({ repoRoot: path.resolve(repoArg || "."), runId, manifestPath: manifestArg });
}

function main() {
  if (!args.length || hasFlag(["--help", "-h"])) help(hasFlag(["--help", "-h"]) ? 0 : 1);
  const unknown = findUnknownFlags(args, "record-verification-evidence");
  if (unknown.length) throw new Error(`Unknown flag(s): ${unknown.join(", ")}`);
  const repoArg = arg("--repo"); const runId = arg("--run-id"); const manifestArg = arg("--manifest");
  const reason = requireValue(arg("--reason"), "--reason"); const dryRun = hasFlag("--dry-run"); const json = hasFlag("--json");
  if (!runId && !manifestArg) throw new Error("Either --run-id or --manifest is required");
  if (runId && manifestArg) throw new Error("Use either --run-id or --manifest, not both");
  const record = resolveRecord(repoArg, runId, manifestArg);
  const expectedRepoRoot = manifestArg && !repoArg ? undefined : getCanonicalRepoRoot(path.resolve(repoArg || "."));
  const paths = validateManifestPaths(record.data?.paths, { expectedRepoRoot, manifestPath: record.manifestPath, runId: record.data?.run_id, caller: "record-verification-evidence" });
  const data = { ...record.data, paths: { ...(record.data.paths || {}), repo_root: paths.repoRoot, worktree: paths.worktree } };
  if (![STATES.INTERNAL_REVIEW_PENDING, STATES.REVIEW_PENDING].includes(data.state)) throw new Error("record-verification-evidence requires state=internal_review_pending or review_pending");
  if (!paths.worktree || data.cleanup?.worktree_removed !== false) throw new Error("record-verification-evidence requires a retained worktree");
  const branch = requireValue(data.git?.working_branch, "manifest git.working_branch");
  if (execGit(paths.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) !== branch) throw new Error("manifest worktree branch does not match git.working_branch");
  if (execGit(paths.worktree, ["status", "--porcelain"])) throw new Error("retained worktree must be clean");
  const headSha = execGit(paths.worktree, ["rev-parse", "HEAD"]); const treeSha = execGit(paths.worktree, ["rev-parse", "HEAD^{tree}"]);
  if (data.git?.head_sha !== headSha) throw new Error("manifest git.head_sha must match retained worktree HEAD");
  const runDir = getRunDir(paths.repoRoot, data.run_id); const evidencePath = path.join(runDir, "execution-evidence.json");
  const existing = JSON.parse(readTextFileWithoutFollowingSymlinks(evidencePath));
  if (existing.head_sha !== headSha) throw new Error("existing execution evidence must match retained worktree HEAD");
  const strictBefore = computeQualityExecutionStatus({ runDir, reviewedHead: headSha, strict: true, manifestData: data });
  const missingGateBlock = /went unrecorded/.test(strictBefore.reason || "");
  if (strictBefore.status !== "fail" || !missingGateBlock) throw new Error("existing evidence is not a same-HEAD strict-preflight missing/unrecorded-gate block; refusing replacement");
  const anchor = getRubricAnchorStatus(data, { runDir, includeContent: true });
  if (!anchor.satisfied) throw new Error(`rubric anchor invalid: ${anchor.error}`);
  const gates = extractVerificationGateDefinitions(anchor.content);
  if (!gates.length) throw new Error("rubric has no verification gates to record");
  const observationResults = observationMap(repeatedObservationArgs(args));
  const observations = gates.filter((gate) => gate.type === "observation");
  for (const gate of observations) if (!observationResults.has(gate.name)) throw new Error(`missing --observation-result for observation gate '${gate.name}'`);
  for (const name of observationResults.keys()) if (!observations.some((gate) => gate.name === name)) throw new Error(`--observation-result does not match an observation gate: '${name}'`);
  // Dry-run intentionally reads no bodies into output, but still validates the
  // source's no-symlink/regular-file/size boundary before promising success.
  if (dryRun) observations.forEach((gate) => readSafeArtifact(observationResults.get(gate.name)));
  const result = { status: dryRun ? "dry_run" : "recorded", runId: data.run_id, headSha, gateNames: gates.map((gate) => gate.name), reason };
  if (!dryRun) {
    const stageDir = createStagingDir(runDir);
    let retainStaging = false;
    try {
    const timestamp = new Date().toISOString();
    const runs = gates.map((gate, index) => {
      if (gate.type === "command") {
        const output = boundedLog(stageDir, index, gate.command, paths.worktree);
        return { name: gate.name, command: gate.command, cwd: paths.worktree, head_sha: headSha, verification_tree_sha: treeSha, exit_code: output.exitCode, output_path: output.outputName, output_hash: output.outputHash, staged_path: output.outputPath, recorded_by: RECORDED_BY, recorded_at: timestamp };
      }
      const outputName = `operator-observation-gate-${index + 1}.artifact`;
      const outputPath = path.join(stageDir, outputName);
      const hash = safeArtifact(observationResults.get(gate.name), outputPath);
      return { name: gate.name, gate_name: gate.name, gate_type: "observation", command: gate.command, cwd: paths.worktree, head_sha: headSha, verification_tree_sha: treeSha, exit_code: 0, output_path: outputName, output_hash: hash, staged_path: outputPath, recorded_by: RECORDED_BY, recorded_at: timestamp };
    });
    if (execGit(paths.worktree, ["status", "--porcelain"]) || execGit(paths.worktree, ["rev-parse", "HEAD"]) !== headSha || execGit(paths.worktree, ["rev-parse", "HEAD^{tree}"]) !== treeSha) {
      throw new Error("verification commands changed the retained worktree; refusing to write evidence");
    }
    const expectedEvidenceHash = hashFileSha256(evidencePath);
    const finalization = withManifestTransaction(record.manifestPath, () => {
      const current = readManifest(record.manifestPath).data;
      if (![STATES.INTERNAL_REVIEW_PENDING, STATES.REVIEW_PENDING].includes(current.state) || current.git?.head_sha !== headSha || current.git?.working_branch !== branch) {
        throw new Error("run changed while verification was executing; refusing evidence replacement");
      }
      if (execGit(paths.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) !== branch
        || execGit(paths.worktree, ["rev-parse", "HEAD"]) !== headSha
        || execGit(paths.worktree, ["rev-parse", "HEAD^{tree}"]) !== treeSha
        || execGit(paths.worktree, ["status", "--porcelain"])) {
        throw new Error("retained worktree changed while verification was executing; refusing evidence replacement");
      }
      if (hashFileSha256(evidencePath) !== expectedEvidenceHash) {
        throw new Error("execution evidence changed while verification was executing; refusing replacement");
      }
      const strictCurrent = computeQualityExecutionStatus({ runDir, reviewedHead: headSha, strict: true, manifestData: current });
      if (strictCurrent.status !== "fail" || !/went unrecorded/.test(strictCurrent.reason || "")) {
        throw new Error("strict preflight changed while verification was executing; refusing replacement");
      }
      const failed = runs.find((run) => run.exit_code !== 0);
      if (failed) {
        retainStaging = true;
        throw new Error(`verification gate '${failed.name}' exited ${failed.exit_code}; preserving existing evidence`);
      }
      const finalRuns = runs.map(({ staged_path, ...run }) => run);
      for (const run of runs) writePrivateFile(path.join(runDir, run.output_path), readSafeArtifact(run.staged_path));
      const evidence = { ...existing, head_sha: headSha, verification_runs: finalRuns, recorded_at: timestamp, recorded_by: "record-verification-evidence-operator-v1", operator_verification: { reason, replaced_evidence_hash: expectedEvidenceHash, head_tree_sha: treeSha, recorded_at: timestamp } };
      const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
      const newHash = crypto.createHash("sha256").update(encoded).digest("hex");
      // Journal first: a crash can leave an orphaned audit attempt, but never a
      // valid replacement artifact without an audit record. Re-run remains safe.
      appendRunEvent(paths.repoRoot, data.run_id, { event: EVENTS.OPERATOR_EXECUTION_EVIDENCE, state_from: current.state, state_to: current.state, head_sha: headSha, branch, reason, operator_initiated: true, execution_evidence_path: evidencePath, execution_evidence_hash: newHash, before: { evidence_hash: expectedEvidenceHash }, after: { evidence_hash: newHash, gate_names: gates.map((gate) => gate.name), head_tree_sha: treeSha } }, { lockHeld: true });
      writeExecutionEvidence(runDir, evidence);
      return { newHash, strictBefore: strictCurrent.reason };
    });
    result.executionEvidenceHash = finalization.newHash; result.strictPreflightBefore = finalization.strictBefore;
    } finally {
      if (!retainStaging) discardStagingDir(stageDir);
    }
  }
  console.log(json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.runId} (${result.gateNames.join(", ")})`);
}

try { main(); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
