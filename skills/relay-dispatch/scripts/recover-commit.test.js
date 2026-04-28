// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
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
} = require("./relay-manifest");
const { readRunEvents } = require("./relay-events");
const {
  EXECUTION_EVIDENCE_FILENAME,
  writeExecutionEvidence,
} = require("./execution-evidence");

const SCRIPT = path.join(__dirname, "recover-commit.js");

function writeFakeGh(binDir, statePath, logPath, initialState = {}) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.RELAY_TEST_GH_STATE;
const logPath = process.env.RELAY_TEST_GH_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf-8");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {};
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
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
  const relayEventsPath = path.resolve(__dirname, "relay-events.js");
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
  unpushed = false,
  evidence = false,
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
  if (dirty) {
    fs.writeFileSync(path.join(worktreePath, "recovered.txt"), "completed but uncommitted\n", "utf-8");
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
    const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    writeExecutionEvidence(runDir, {
      schema_version: 1,
      head_sha: headSha,
      test_command: "node --test skills/relay-*/scripts/*.test.js",
      test_result_hash: "unspecified",
      test_result_summary: "unspecified",
      recorded_at: "2026-04-24T01:00:00.000Z",
      recorded_by: "dispatch-orchestrator-v1",
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

function findGhCall(fixture, command, subcommand) {
  return readJsonLines(fixture.ghLogPath).find((argv) => argv[0] === command && argv[1] === subcommand);
}

function ghArg(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
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

test("clean worktree with no unpushed commits rejects as nothing to recover", () => {
  const fixture = setupRepo();
  const result = runRecover(fixture, ["--reason", "no work", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing_to_recover/);
  assert.equal(readManifest(fixture.manifestPath).data.git.pr_number, null);
  assert.equal(readJsonLines(fixture.ghLogPath).filter((argv) => argv[0] === "pr" && argv[1] === "create").length, 0);
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
