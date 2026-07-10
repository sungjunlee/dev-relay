// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  EXECUTION_EVIDENCE_FILENAME,
  writeExecutionEvidence,
} = require("../../../skills/relay-dispatch/scripts/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "recover-commit.js");

function writeFakeGh(binDir, statePath, logPath, initialState = {}) {
  const ghPath = path.join(binDir, "gh");
  const relayManifestPath = path.resolve(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "relay-manifest.js");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.RELAY_TEST_GH_STATE;
const logPath = process.env.RELAY_TEST_GH_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf-8");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {};
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function applyManifestPatch(patch) {
  if (!patch || !patch.manifestPath) return;
  const { readManifest, writeManifest, updateManifestState } = require(${JSON.stringify(relayManifestPath)});
  const record = readManifest(patch.manifestPath);
  let data = record.data;
  if (patch.transitionTo) {
    data = updateManifestState(data, patch.transitionTo, patch.nextAction);
  }
  for (const [key, value] of Object.entries(patch.merge || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      data = {
        ...data,
        [key]: {
          ...(data[key] || {}),
          ...value,
        },
      };
    } else {
      data = {
        ...data,
        [key]: value,
      };
    }
  }
  writeManifest(patch.manifestPath, data, record.body);
}
if (args[0] === "pr" && args[1] === "list") {
  if (state.failPrList) {
    process.stderr.write(state.failPrList + "\\n");
    process.exit(1);
  }
  if (state.existingPrNumber !== undefined && state.existingPrNumber !== null) {
    process.stdout.write(String(state.existingPrNumber) + "\\n");
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  state.createCalls = Number(state.createCalls || 0) + 1;
  if (state.failPrCreate) {
    save();
    process.stderr.write(state.failPrCreate + "\\n");
    process.exit(1);
  }
  state.existingPrNumber = state.createNumber || 281;
  save();
  applyManifestPatch(state.patchManifestOnPrCreate);
  process.stdout.write("https://github.com/acme/dev-relay/pull/" + state.existingPrNumber + "\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const issueNumber = String(args[2]);
  state.issueViewCalls = Number(state.issueViewCalls || 0) + 1;
  save();
  if (state.failIssueView) {
    process.stderr.write(state.failIssueView + "\\n");
    process.exit(1);
  }
  const title = state.issueTitles && state.issueTitles[issueNumber];
  if (!title) {
    process.stderr.write("issue not found: " + issueNumber + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ number: Number(issueNumber), title }) + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  fs.writeFileSync(statePath, JSON.stringify({
    createNumber: 281,
    issueTitles: { "281": "Recover commit should use the issue title" },
    ...initialState,
  }, null, 2));
  fs.writeFileSync(logPath, "");
  return ghPath;
}

function writeEventPreload(dir, eventLogPath) {
  const preloadPath = path.join(dir, "event-preload.cjs");
  const relayEventsPath = path.resolve(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "relay-events.js");
  fs.writeFileSync(preloadPath, `const fs = require("fs");
const Module = require("module");
const target = ${JSON.stringify(relayEventsPath)};
const logPath = ${JSON.stringify(eventLogPath)};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    return loaded;
  }
  if (resolved !== target) return loaded;
  return {
    ...loaded,
    appendRunEvent(repoRoot, runId, eventData) {
      fs.appendFileSync(logPath, JSON.stringify({ repoRoot, runId, eventData }) + "\\n", "utf-8");
      return loaded.appendRunEvent(repoRoot, runId, eventData);
    },
  };
};
`, "utf-8");
  fs.writeFileSync(eventLogPath, "");
  return preloadPath;
}

function buildManifestForState(manifest, state, repoRoot, runId) {
  if (state === STATES.DRAFT) return manifest;
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: recover-commit\n", "utf-8");
  manifest.anchor.rubric_path = "rubric.yaml";
  if (state === STATES.DISPATCHED) return manifest;
  if (state === STATES.INTERNAL_REVIEW_PENDING) {
    return updateManifestState(manifest, STATES.INTERNAL_REVIEW_PENDING, "run_internal_review");
  }
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  if (state === STATES.REVIEW_PENDING) return manifest;
  if (state === STATES.READY_TO_MERGE) {
    return updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  }
  if (state === STATES.MERGED) {
    return updateManifestState(
      updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge"),
      STATES.MERGED,
      "manual_cleanup_required"
    );
  }
  if (state === STATES.CLOSED) {
    return updateManifestState(
      updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge"),
      STATES.CLOSED,
      "done"
    );
  }
  throw new Error(`Unsupported test state: ${state}`);
}

function setupRepo({
  dirty = false,
  runtimeOnlyDirty = false,
  unpushed = false,
  evidence = false,
  evidenceOverrides = {},
  staleEvidence = false,
  manifestState = STATES.REVIEW_PENDING,
  branch = "issue-281",
  issueNumber = 281,
  ghState = {},
} = {}) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-commit-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-")));
  const statePath = path.join(binDir, "gh-state.json");
  const ghLogPath = path.join(binDir, "gh.log");
  const eventLogPath = path.join(binDir, "events.log");
  process.env.RELAY_HOME = relayHome;

  const originRoot = path.join(repoRoot, "origin.git");
  execFileSync("git", ["init", "--bare", originRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Recover Commit Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-recover@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", originRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const dispatchHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (dirty) {
    fs.writeFileSync(path.join(worktreePath, "recovered.txt"), "completed but uncommitted\n", "utf-8");
  }
  if (runtimeOnlyDirty) {
    const runtimeDir = path.join(worktreePath, ".antigravitycli");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "session.json"), "{}\n", "utf-8");
  }
  if (unpushed) {
    fs.writeFileSync(path.join(worktreePath, "unpushed.txt"), "committed but not pushed\n", "utf-8");
    execFileSync("git", ["-C", worktreePath, "add", "unpushed.txt"], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "Executor commit"], { encoding: "utf-8", stdio: "pipe" });
  }

  const runId = createRunId({ issueNumber, branch, timestamp: new Date("2026-04-24T01:00:00.000Z") });
  const runLayout = ensureRunLayout(repoRoot, runId);
  const manifestPath = runLayout.manifestPath;
  const runDir = runLayout.runDir;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = buildManifestForState(manifest, manifestState, repoRoot, runId);
  writeManifest(manifestPath, manifest);
  if (evidence) {
    const headSha = staleEvidence
      ? dispatchHead
      : execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    writeExecutionEvidence(runDir, {
      schema_version: 1,
      head_sha: headSha,
      test_command: "node --test tests/relay-*/scripts/*.test.js",
      test_result_hash: "unspecified",
      test_result_summary: "unspecified",
      recorded_at: "2026-04-24T01:00:00.000Z",
      recorded_by: "dispatch-orchestrator-v1",
      ...evidenceOverrides,
    });
  }

  const ghPath = writeFakeGh(binDir, statePath, ghLogPath, ghState);
  const preloadPath = writeEventPreload(binDir, eventLogPath);
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_GH_BIN: ghPath,
    RELAY_TEST_GH_STATE: statePath,
    RELAY_TEST_GH_LOG: ghLogPath,
    NODE_OPTIONS: process.env.NODE_OPTIONS
      ? `${process.env.NODE_OPTIONS} --require ${preloadPath}`
      : `--require ${preloadPath}`,
  };
  return { repoRoot, relayHome, runId, manifestPath, runDir, worktreePath, branch, statePath, ghLogPath, eventLogPath, env };
}

function runRecover(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, "--repo", fixture.repoRoot, "--run-id", fixture.runId, ...extraArgs], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: fixture.env,
  });
}

function readJsonLines(filePath) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8").trim() : "";
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function updateGhState(fixture, patch) {
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
  fs.writeFileSync(fixture.statePath, JSON.stringify({
    ...state,
    ...patch,
  }, null, 2));
}

function findGhCall(fixture, command, subcommand) {
  return readJsonLines(fixture.ghLogPath).find((argv) => argv[0] === command && argv[1] === subcommand);
}

function ghArg(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function isPgidAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return false;
  }
}

function killPgid(pgid) {
  if (!pgid) return;
  try {
    process.kill(-Number(pgid), "SIGTERM");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 5000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function writeLease(fixture, { pid, pgid }) {
  const leasePath = path.join(fixture.runDir, "lease.json");
  fs.writeFileSync(leasePath, `${JSON.stringify({
    pid,
    pgid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: 2400,
  }, null, 2)}\n`, "utf-8");
  return leasePath;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("happy path commits dirty worktree, pushes, opens PR, stamps manifest, and emits audit event", () => {
  const fixture = setupRepo({ dirty: true });
  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.commitCreated, true);
  assert.equal(parsed.prCreated, true);
  assert.equal(parsed.prNumber, 281);

  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.pr_number, 281);

  const commitBody = execFileSync("git", ["-C", fixture.worktreePath, "log", "-1", "--format=%B"], { encoding: "utf-8" });
  assert.match(commitBody, new RegExp(`^Recover relay run ${fixture.runId}`));
  assert.match(commitBody, new RegExp(`Run ID: ${fixture.runId}`));
  assert.match(commitBody, /Reason: executor completed before commit/);
  assert.match(commitBody, /Recovered at \(UTC\): /);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const recoverEvent = events.find((entry) => entry.event === "recover_commit");
  assert.equal(recoverEvent.branch, fixture.branch);
  assert.equal(recoverEvent.commit_sha, parsed.commitSha);
  assert.equal(recoverEvent.pr_number, 281);
  assert.equal(events.filter((entry) => entry.event === "pr_number_stamped").length, 1);
  assert.equal(events.filter((entry) => entry.event === "execution_evidence_rebranded").length, 0);
  assert.ok(readJsonLines(fixture.eventLogPath).some((entry) => entry.eventData.event === "recover_commit"));
  assert.equal(readJsonLines(fixture.ghLogPath).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 1);
});

test("internal_review_pending recovery commits locally without pushing or opening a PR", () => {
  const fixture = setupRepo({ dirty: true, manifestState: STATES.INTERNAL_REVIEW_PENDING });
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, {
    ...record.data,
    next_action: "recover_commit_before_internal_review",
  }, record.body);
  const result = runRecover(fixture, ["--reason", "executor completed before internal review", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(parsed.commitCreated, true);
  assert.equal(parsed.prNumber, null);
  assert.equal(parsed.prCreated, false);

  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_internal_review");
  assert.equal(manifest.git.pr_number, null);
  assert.equal(manifest.git.head_sha, parsed.commitSha);

  assert.deepEqual(readJsonLines(fixture.ghLogPath), []);
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const recoverEvent = events.find((entry) => entry.event === "recover_commit");
  assert.equal(recoverEvent.pr_number, null);
  assert.equal(events.filter((entry) => entry.event === "pr_number_stamped").length, 0);
});

test("internal_review_pending dry-run does not call GitHub or preview PR commands", () => {
  const fixture = setupRepo({ dirty: true, manifestState: STATES.INTERNAL_REVIEW_PENDING });
  const result = runRecover(fixture, ["--reason", "preview internal recovery", "--dry-run", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.prTitle, null);
  assert.equal(parsed.manifestMutation.git_pr_number, null);
  assert.ok(parsed.commands.some((cmd) => cmd.argv.includes("commit")));
  assert.ok(!parsed.commands.some((cmd) => cmd.argv.includes("push")));
  assert.ok(!parsed.commands.some((cmd) => cmd.argv.includes("create")));
  assert.deepEqual(readJsonLines(fixture.ghLogPath), []);
});

test("recover-commit canonicalizes manifest repo_root when it shares the expected git common dir", () => {
  const fixture = setupRepo({ dirty: true });
  const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-linked-root-"));
  execFileSync("git", ["worktree", "add", linkedRoot, "-b", "equivalent-root-626"], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const beforeManifest = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, {
    ...beforeManifest.data,
    paths: {
      ...beforeManifest.data.paths,
      repo_root: linkedRoot,
    },
  }, beforeManifest.body);

  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.prNumber, 281);

  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.paths.repo_root, fixture.repoRoot);
  assert.equal(manifest.paths.worktree, fixture.worktreePath);
  assert.equal(manifest.git.pr_number, 281);
  assert.ok(readRunEvents(fixture.repoRoot, fixture.runId).some((entry) => entry.event === "recover_commit"));
});

test("default PR title uses manifest issue title when available", () => {
  const fixture = setupRepo({ dirty: true });
  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const issueView = findGhCall(fixture, "issue", "view");
  assert.deepEqual(issueView, ["issue", "view", "281", "--json", "title,number"]);
  const prCreate = findGhCall(fixture, "pr", "create");
  assert.equal(ghArg(prCreate, "--title"), "Recover commit should use the issue title (#281)");
});

test("default PR title uses branch-inferred issue title when manifest issue is absent", () => {
  const fixture = setupRepo({
    dirty: true,
    branch: "issue-282",
    issueNumber: null,
    ghState: { issueTitles: { "282": "Branch inferred recovery title" } },
  });
  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const issueView = findGhCall(fixture, "issue", "view");
  assert.deepEqual(issueView, ["issue", "view", "282", "--json", "title,number"]);
  const prCreate = findGhCall(fixture, "pr", "create");
  assert.equal(ghArg(prCreate, "--title"), "Branch inferred recovery title (#282)");
});

test("explicit --pr-title wins without issue title lookup", () => {
  const fixture = setupRepo({ dirty: true });
  const result = runRecover(fixture, [
    "--reason", "executor completed before commit",
    "--pr-title", "Operator supplied recovery title",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(findGhCall(fixture, "issue", "view"), undefined);
  const prCreate = findGhCall(fixture, "pr", "create");
  assert.equal(ghArg(prCreate, "--title"), "Operator supplied recovery title");
});

test("issue lookup failure falls back to existing recovery title", () => {
  const fixture = setupRepo({ dirty: true, ghState: { failIssueView: "not found" } });
  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const issueView = findGhCall(fixture, "issue", "view");
  assert.deepEqual(issueView, ["issue", "view", "281", "--json", "title,number"]);
  const prCreate = findGhCall(fixture, "pr", "create");
  assert.equal(ghArg(prCreate, "--title"), `Recover ${fixture.branch} (${fixture.runId})`);
});

test("dirty worktree recovery rebrands execution evidence to the created commit and emits event", () => {
  const fixture = setupRepo({ dirty: true, evidence: true });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const result = runRecover(fixture, ["--reason", "executor completed before commit", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const afterEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(parsed.commitCreated, true);
  assert.equal(afterEvidence.head_sha, parsed.commitSha);
  assert.equal(afterEvidence.recorded_by, "recover-commit-rebrand");
  assert.equal(afterEvidence.rebrand.previous_head_sha, beforeEvidence.head_sha);
  assert.equal(afterEvidence.rebrand.previous_recorded_by, "dispatch-orchestrator-v1");
  assert.match(afterEvidence.rebrand.reason, /Audit reason: executor completed before commit/);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const rebrandEvent = events.find((entry) => entry.event === "execution_evidence_rebranded");
  assert.equal(rebrandEvent.previous_head_sha, beforeEvidence.head_sha);
  assert.equal(rebrandEvent.new_head_sha, parsed.commitSha);
  assert.equal(rebrandEvent.reason, "executor completed before commit");
  assert.equal(rebrandEvent.override_class, "execution_evidence_rebrand");
  assert.equal(rebrandEvent.affected_head_sha, parsed.commitSha);
  assert.equal(rebrandEvent.prior_state, STATES.REVIEW_PENDING);
  assert.equal(rebrandEvent.required_reason, "executor completed before commit");
  assert.equal(rebrandEvent.operator_initiated, true);
});

test("missing execution evidence with operator test flags writes artifact at recovered HEAD", () => {
  const fixture = setupRepo({ dirty: true });
  const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
  fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
  const testCommand = "node --test tests/relay-dispatch/scripts/recover-commit.test.js";

  const result = runRecover(fixture, [
    "--reason", "executor died before evidence write",
    "--test-command", testCommand,
    "--test-result-file", resultFile,
    "--test-exit-code", "0",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(parsed.commitCreated, true);
  assert.equal(evidence.head_sha, parsed.commitSha);
  assert.equal(evidence.test_command, testCommand);
  assert.equal(evidence.test_result_hash, sha256File(resultFile));
  assert.equal(evidence.test_exit_code, 0);
  assert.equal(evidence.recorded_by, "recover-commit-operator-v1");
  assert.doesNotMatch(result.stderr, /execution-evidence\.json missing/);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const operatorEvidenceEvent = events.find((entry) => entry.event === "operator_execution_evidence");
  assert.equal(operatorEvidenceEvent.head_sha, parsed.commitSha);
  assert.equal(operatorEvidenceEvent.commit_sha, parsed.commitSha);
  assert.equal(operatorEvidenceEvent.branch, fixture.branch);
  assert.equal(operatorEvidenceEvent.reason, "executor died before evidence write");
  assert.equal(operatorEvidenceEvent.operator_initiated, true);
  assert.equal(operatorEvidenceEvent.execution_evidence_path, evidencePath);
  assert.equal(operatorEvidenceEvent.execution_evidence_hash, sha256File(evidencePath));
  assert.equal(events.filter((entry) => entry.event === "execution_evidence_rebranded").length, 0);
});

test("operator test flags reject nonzero exit code before evidence or recovery side effects", () => {
  const fixture = setupRepo({ dirty: true });
  const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
  fs.writeFileSync(resultFile, "node --test failed\n", "utf-8");
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  const result = runRecover(fixture, [
    "--reason", "operator test run failed",
    "--test-command", "node --test",
    "--test-result-file", resultFile,
    "--test-exit-code", "1",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--test-exit-code must be 0/);
  assert.equal(fs.existsSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME)), false);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
  assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

[
  ["--test-command", /--test-command requires a non-empty value/],
  ["--test-result-file", /--test-result-file requires a non-empty value/],
].forEach(([finalFlag, expected]) => {
  test(`operator test flags reject ${finalFlag} given as final token without a value`, () => {
    const fixture = setupRepo({ dirty: true });
    const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
    fs.writeFileSync(resultFile, "ok\n", "utf-8");
    const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

    const args = [
      "--reason", "operator evidence with missing value",
      "--json",
      "--test-exit-code", "0",
    ];
    if (finalFlag === "--test-command") {
      args.push("--test-result-file", resultFile, "--test-command");
    } else {
      args.push("--test-command", "node --test", "--test-result-file");
    }
    const result = runRecover(fixture, args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME)), false);
    assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
    assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
    assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  });
});

[
  ["--test-command"],
  ["--test-result-file"],
  ["--test-exit-code"],
  ["--test-command", "--test-result-file"],
  ["--test-command", "--test-exit-code"],
  ["--test-result-file", "--test-exit-code"],
].forEach((flags) => {
  test(`operator test flags reject incomplete evidence set: ${flags.join(" ")}`, () => {
    const fixture = setupRepo({ dirty: true });
    const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
    fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
    const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const args = ["--reason", "partial operator evidence"];
    for (const flag of flags) {
      args.push(flag);
      if (flag === "--test-command") args.push("node --test");
      if (flag === "--test-result-file") args.push(resultFile);
      if (flag === "--test-exit-code") args.push("0");
    }
    args.push("--json");

    const result = runRecover(fixture, args);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Operator execution evidence flags must be provided together/);
    for (const requiredFlag of ["--test-command", "--test-result-file", "--test-exit-code"]) {
      assert.match(result.stderr, new RegExp(requiredFlag));
    }
    assert.equal(fs.existsSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME)), false);
    assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
    assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
    assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
    assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  });
});

test("missing execution evidence without operator test flags preserves recovery and warns once", () => {
  const fixture = setupRepo({ dirty: true });
  const result = runRecover(fixture, ["--reason", "executor died before evidence write", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.commitCreated, true);
  assert.equal(fs.existsSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME)), false);
  const warningLines = result.stderr.trim().split("\n").filter(Boolean);
  assert.equal(warningLines.length, 1);
  assert.match(warningLines[0], /execution-evidence\.json missing/);
  assert.match(warningLines[0], /--test-command/);
  assert.match(warningLines[0], /--test-result-file/);
  assert.match(warningLines[0], /--test-exit-code/);
});

test("operator test flags refuse to overwrite existing execution evidence", () => {
  const fixture = setupRepo({ dirty: true, evidence: true });
  const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
  fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = fs.readFileSync(evidencePath, "utf-8");

  const result = runRecover(fixture, [
    "--reason", "operator attempted evidence overwrite",
    "--test-command", "node --test",
    "--test-result-file", resultFile,
    "--test-exit-code", "0",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /execution-evidence\.json already exists/);
  assert.match(result.stderr, /rebrand-evidence\.js/);
  assert.doesNotMatch(result.stderr, /--replace-placeholder-evidence/);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), beforeEvidence);
  assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

[
  { name: "malformed", contents: "{not-json\n" },
  { name: "null", contents: "null\n" },
].forEach(({ name, contents }) => {
  test(`operator test flags refuse to overwrite ${name} execution evidence`, () => {
    const fixture = setupRepo({ dirty: true, evidence: true });
    const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
    fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
    const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
    fs.writeFileSync(evidencePath, contents, "utf-8");

    const result = runRecover(fixture, [
      "--reason", `operator attempted ${name} evidence overwrite`,
      "--test-command", "node --test",
      "--test-result-file", resultFile,
      "--test-exit-code", "0",
      "--json",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /execution-evidence\.json already exists/);
    assert.match(result.stderr, /rebrand-evidence\.js/);
    assert.doesNotMatch(result.stderr, /--replace-placeholder-evidence/);
    assert.equal(fs.readFileSync(evidencePath, "utf-8"), contents);
    assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  });
});

test("placeholder evidence without replacement flag is refused with the flag hint", () => {
  const fixture = setupRepo({
    dirty: true,
    evidence: true,
    evidenceOverrides: { test_command: "unspecified" },
  });
  const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
  fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = fs.readFileSync(evidencePath, "utf-8");

  const result = runRecover(fixture, [
    "--reason", "replace timeout placeholder",
    "--test-command", "node --test",
    "--test-result-file", resultFile,
    "--test-exit-code", "0",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /execution-evidence\.json already exists/);
  assert.match(result.stderr, /--replace-placeholder-evidence/);
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), beforeEvidence);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("replacement flag without operator evidence flags is rejected before recovery side effects", () => {
  const fixture = setupRepo({
    dirty: true,
    evidence: true,
    evidenceOverrides: { test_command: "unspecified", test_exit_code: 1 },
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = fs.readFileSync(evidencePath, "utf-8");
  const beforeManifest = fs.readFileSync(fixture.manifestPath, "utf-8");
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  const result = runRecover(fixture, [
    "--reason", "replace timeout placeholder",
    "--replace-placeholder-evidence",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--replace-placeholder-evidence requires operator execution evidence flags together/);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), beforeEvidence);
  assert.equal(fs.readFileSync(fixture.manifestPath, "utf-8"), beforeManifest);
  assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("replacement flag replaces exact placeholder and journals replaced fields on operator evidence event", () => {
  const fixture = setupRepo({
    dirty: true,
    evidence: true,
    evidenceOverrides: { test_command: "unspecified", test_exit_code: 1 },
  });
  const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
  fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
  const testCommand = "node --test tests/relay-dispatch/scripts/recover-commit.test.js";

  const result = runRecover(fixture, [
    "--reason", "replace timeout placeholder",
    "--test-command", testCommand,
    "--test-result-file", resultFile,
    "--test-exit-code", "0",
    "--replace-placeholder-evidence",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(evidence.head_sha, parsed.commitSha);
  assert.equal(evidence.test_command, testCommand);
  assert.equal(evidence.test_exit_code, 0);
  assert.equal(evidence.recorded_by, "recover-commit-operator-v1");

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const operatorEvidenceEvent = events.find((entry) => entry.event === "operator_execution_evidence");
  assert.equal(operatorEvidenceEvent.before.recorded_by, "dispatch-orchestrator-v1");
  assert.equal(operatorEvidenceEvent.before.test_exit_code, 1);
  assert.equal(operatorEvidenceEvent.execution_evidence_path, evidencePath);
  assert.equal(operatorEvidenceEvent.execution_evidence_hash, sha256File(evidencePath));
  assert.equal(events.filter((entry) => entry.event === "execution_evidence_rebranded").length, 0);
});

[
  { name: "recorded_by differs", overrides: { test_command: "unspecified", recorded_by: "recover-commit-operator-v1" } },
  { name: "test_command differs", overrides: { test_command: "node --test", recorded_by: "dispatch-orchestrator-v1" } },
  { name: "both fields differ", overrides: { test_command: "node --test", recorded_by: "codex-executor-v1" } },
].forEach(({ name, overrides }) => {
  test(`replacement flag refuses non-placeholder evidence when ${name}`, () => {
    const fixture = setupRepo({ dirty: true, evidence: true, evidenceOverrides: overrides });
    const resultFile = path.join(fixture.runDir, "operator-test-result.txt");
    fs.writeFileSync(resultFile, "node --test passed\n", "utf-8");
    const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
    const beforeEvidence = fs.readFileSync(evidencePath, "utf-8");

    const result = runRecover(fixture, [
      "--reason", "attempt non-placeholder replacement",
      "--test-command", "node --test",
      "--test-result-file", resultFile,
      "--test-exit-code", "0",
      "--replace-placeholder-evidence",
      "--json",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /execution-evidence\.json already exists/);
    assert.match(result.stderr, /rebrand-evidence\.js/);
    assert.doesNotMatch(result.stderr, /Pass --replace-placeholder-evidence/);
    assert.equal(fs.readFileSync(evidencePath, "utf-8"), beforeEvidence);
    assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  });
});

test("already-committed recovery leaves execution evidence byte-identical", () => {
  const fixture = setupRepo({ unpushed: true, evidence: true });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = fs.readFileSync(evidencePath, "utf-8");
  const result = runRecover(fixture, ["--reason", "executor committed but did not push", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.commitCreated, false);
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), beforeEvidence);
  assert.equal(
    readRunEvents(fixture.repoRoot, fixture.runId).filter((entry) => entry.event === "execution_evidence_rebranded").length,
    0
  );
});

test("dispatched already-committed recovery rebrands stale execution evidence to recovered HEAD", () => {
  const fixture = setupRepo({
    unpushed: true,
    evidence: true,
    staleEvidence: true,
    manifestState: STATES.DISPATCHED,
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const beforeEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));

  const result = runRecover(fixture, ["--reason", "executor committed before dispatch crash", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(fixture.manifestPath).data;
  const afterEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(parsed.commitCreated, false);
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.head_sha, parsed.commitSha);
  assert.equal(afterEvidence.head_sha, parsed.commitSha);
  assert.equal(afterEvidence.recorded_by, "recover-commit-rebrand");
  assert.equal(afterEvidence.rebrand.previous_head_sha, beforeEvidence.head_sha);

  const rebrandEvent = readRunEvents(fixture.repoRoot, fixture.runId)
    .find((entry) => entry.event === "execution_evidence_rebranded");
  assert.equal(rebrandEvent.previous_head_sha, beforeEvidence.head_sha);
  assert.equal(rebrandEvent.new_head_sha, parsed.commitSha);
  assert.equal(rebrandEvent.affected_head_sha, parsed.commitSha);
  assert.equal(rebrandEvent.reason, "executor committed before dispatch crash");
});

test("dispatched recovery stamps PR from a fresh locked manifest update", () => {
  const fixture = setupRepo({ dirty: true, manifestState: STATES.DISPATCHED });
  updateGhState(fixture, {
    patchManifestOnPrCreate: {
      manifestPath: fixture.manifestPath,
      merge: {
        review: {
          rounds: 4,
          latest_verdict: "concurrent_review_started",
        },
      },
    },
  });

  const result = runRecover(fixture, ["--reason", "executor completed during supervisor crash", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(parsed.status, "recovered");
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_review");
  assert.equal(manifest.review.rounds, 4);
  assert.equal(manifest.review.latest_verdict, "concurrent_review_started");
  assert.equal(manifest.git.pr_number, 281);
  assert.equal(manifest.git.head_sha, parsed.commitSha);

  const stampEvents = readRunEvents(fixture.repoRoot, fixture.runId)
    .filter((entry) => entry.event === "pr_number_stamped");
  assert.equal(stampEvents.length, 1);
  assert.equal(stampEvents[0].round, 4);
});

test("clean worktree with no unpushed commits rejects as nothing to recover", () => {
  const fixture = setupRepo();
  const result = runRecover(fixture, ["--reason", "no work", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing_to_recover/);
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, null);
  assert.equal(readJsonLines(fixture.ghLogPath).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 0);
});

test("runtime-only Antigravity dirt rejects as nothing reviewable to recover", () => {
  const fixture = setupRepo({ runtimeOnlyDirty: true });
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  const result = runRecover(fixture, ["--reason", "runtime metadata only", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing_to_recover/);
  assert.match(result.stderr, /runtime metadata dirt/);
  assert.match(result.stderr, /\.antigravitycli\//);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, null);
  assert.equal(readJsonLines(fixture.ghLogPath).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 0);
});

test("dispatched recovery refuses to run while the run lease is live", async () => {
  if (process.platform === "win32") return;

  const fixture = setupRepo({ dirty: true, manifestState: STATES.DISPATCHED });
  const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  const blockerExit = new Promise((resolve) => blocker.on("close", resolve));
  blocker.unref();

  try {
    await waitFor(() => isPgidAlive(blocker.pid), { message: `pgid ${blocker.pid} alive` });
    const leasePath = writeLease(fixture, { pid: blocker.pid, pgid: blocker.pid });
    const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const result = runRecover(fixture, ["--reason", "direct recovery while executor still runs", "--json"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /live run lease/);
    assert.match(result.stderr, /reconcile-run\.js/);
    assert.equal(fs.existsSync(leasePath), true);
    assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
    assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
    assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
    assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
    assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  } finally {
    killPgid(blocker.pid);
    await Promise.race([blockerExit, sleep(5000)]);
  }
});

test("unknown run id fails through resolveManifestRecord", () => {
  const fixture = setupRepo({ dirty: true });
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--run-id", "issue-999-20260424010000000-deadbeef",
    "--reason", "missing run",
    "--json",
  ], { cwd: fixture.repoRoot, encoding: "utf-8", env: fixture.env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run_resolution_failed/);
  assert.match(result.stderr, /No relay manifest found/);
});

test("dry-run previews commands and computed PR title without committing or mutating manifest", () => {
  const fixture = setupRepo({ dirty: true });
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  const result = runRecover(fixture, ["--reason", "preview only", "--dry-run", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.prTitle, "Recover commit should use the issue title (#281)");
  assert.equal(parsed.prTitleSource, "manifest_issue");
  assert.equal(parsed.prTitleIssueNumber, 281);
  assert.ok(parsed.commands.some((cmd) => cmd.argv.includes("add") && cmd.argv.includes("-A")));
  assert.ok(parsed.commands.some((cmd) => cmd.argv.includes("commit")));
  assert.ok(parsed.commands.some((cmd) => cmd.argv.includes("push")));
  assert.ok(parsed.commands.some((cmd) => cmd.argv.includes("create")));
  const prCreate = parsed.commands.find((cmd) => cmd.argv[1] === "pr" && cmd.argv[2] === "create");
  assert.equal(ghArg(prCreate.argv, "--title"), "Recover commit should use the issue title (#281)");
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, null);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
  assert.deepEqual(readJsonLines(fixture.ghLogPath), [["issue", "view", "281", "--json", "title,number"]]);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
});

test("missing --reason rejects before mutation", () => {
  const fixture = setupRepo({ dirty: true });
  const result = runRecover(fixture, ["--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason <text> is required/);
  assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("blank --reason rejects before commit or evidence rebrand", () => {
  const fixture = setupRepo({ dirty: true, evidence: true });
  const beforeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  const beforeEvidence = fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8");
  const result = runRecover(fixture, ["--reason", "   ", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason (?:<text> is required|requires a non-empty value)/);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(), beforeHead);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "?? recovered.txt");
  assert.equal(fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"), beforeEvidence);
  assert.equal(readJsonLines(fixture.ghLogPath).length, 0);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("merged terminal state rejection matches finalize-run force-finalize shape", () => {
  const fixture = setupRepo({ dirty: true, manifestState: STATES.MERGED });
  const result = runRecover(fixture, ["--reason", "terminal", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /force-finalize cannot be used from terminal state merged/);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.MERGED);
});

test("closed terminal state rejection matches finalize-run force-finalize shape", () => {
  const fixture = setupRepo({ dirty: true, manifestState: STATES.CLOSED });
  const result = runRecover(fixture, ["--reason", "terminal", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /force-finalize cannot be used from terminal state closed/);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.CLOSED);
});

test("existing PR reuse does not create or rename a PR", () => {
  const fixture = setupRepo({ dirty: true, ghState: { existingPrNumber: 333 } });
  const result = runRecover(fixture, ["--reason", "recover onto existing PR", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.existingPr, true);
  assert.equal(parsed.prCreated, false);
  assert.equal(parsed.prNumber, 333);

  const calls = readJsonLines(fixture.ghLogPath);
  assert.equal(calls.filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 0);
  assert.equal(calls.filter((argv) => argv[0] === "pr" && argv[1] === "edit").length, 0);
  assert.equal(calls.filter((argv) => argv[0] === "issue" && argv[1] === "view").length, 0);
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, 333);
});

test("idempotent re-run reuses existing PR without restamping or creating a second PR", () => {
  const fixture = setupRepo({ dirty: true });
  const first = runRecover(fixture, ["--reason", "first recovery", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runRecover(fixture, ["--reason", "audit rerun", "--json"]);
  assert.equal(second.status, 0, second.stderr);

  const secondParsed = JSON.parse(second.stdout);
  assert.equal(secondParsed.existingPr, true);
  assert.equal(secondParsed.prCreated, false);
  assert.equal(secondParsed.prNumber, 281);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.filter((entry) => entry.event === "pr_number_stamped").length, 1);
  assert.equal(events.filter((entry) => entry.event === "recover_commit").length, 2);
  assert.equal(readJsonLines(fixture.ghLogPath).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 1);
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, 281);
});
