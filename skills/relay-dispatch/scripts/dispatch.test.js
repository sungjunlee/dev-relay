const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  captureAttempt,
  getEventsPath,
  getRunDir,
  listManifestPaths,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const SCRIPT = path.join(__dirname, "dispatch.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { repoRoot, relayHome };
}

function writeFakeClaude(binDir) {
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("claude-fake\\n");
  process.exit(0);
}
if (args[0] !== "-p") {
  process.stderr.write("unsupported fake claude invocation");
  process.exit(1);
}
// CWD is set via spawn options, not --cwd flag
const cwd = process.cwd();
const fileName = fs.existsSync(cwd + "/first.txt") ? "resume.txt" : "first.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("ok\\n");
`, "utf-8");
  fs.chmodSync(claudePath, 0o755);
  return claudePath;
}

function writeFakeCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const fileName = fs.existsSync(cwd + "/first.txt") ? "resume.txt" : "first.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function withRequiredRubric(args) {
  if (args.includes("--rubric-file") || args.includes("--rubric-grandfathered")) {
    return args;
  }
  if (args.includes("--run-id") || args.includes("--manifest")) {
    return args;
  }

  const rubricFile = path.join(
    os.tmpdir(),
    `relay-dispatch-rubric-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`
  );
  fs.writeFileSync(rubricFile, [
    "rubric:",
    "  factors:",
    "    - name: default test rubric",
    "      target: exit 0",
  ].join("\n"), "utf-8");
  return [...args, "--rubric-file", rubricFile];
}

function runDispatch(repoRoot, args, env) {
  return execFileSync("node", [SCRIPT, repoRoot, ...withRequiredRubric(args)], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env,
  });
}

test("dispatch reuses the same run and worktree on resume", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-42",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const worktree = first.worktree;

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "--prompt", "resume pass",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, runId);
  assert.equal(second.worktree, worktree);
  assert.equal(second.runState, STATES.REVIEW_PENDING);
  assert.equal(listManifestPaths(repoRoot).length, 1);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.ok(manifest.git.head_sha);

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8");
  assert.match(events, /"event":"dispatch_start"/);
  assert.match(events, /"reason":"same_run_resume"/);
  assert.match(events, /"reason":"same_run_resume:completed"/);
});

test("dispatch resume fails loudly when the retained worktree is missing", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-42",
    "--prompt", "first pass",
    "--json",
  ], env));
  const manifestPath = first.manifestPath;
  const runId = first.runId;

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);
  execFileSync("git", ["worktree", "remove", "--force", first.worktree], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree is missing/);
  assert.equal(listManifestPaths(repoRoot).length, 1);
});

test("dispatch with --executor claude creates worktree and collects result", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  writeFakeClaude(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "claude-test",
    "-e", "claude",
    "--prompt", "test task",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.executor, "claude");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.ok(result.commits);
  assert.ok(fs.existsSync(result.resultFile));
  const resultText = fs.readFileSync(result.resultFile, "utf-8");
  assert.match(resultText, /ok/);
});

test("dispatch artifacts are persisted in the run directory", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-artifact",
    "--prompt", "artifact test task",
    "--json",
  ], env));
  assert.equal(result.status, "completed");

  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-prompt.md")));
  const promptText = fs.readFileSync(path.join(result.runDir, "dispatch-prompt.md"), "utf-8");
  assert.match(promptText, /artifact test task/);

  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-result.txt")));
  const resultText = fs.readFileSync(path.join(result.runDir, "dispatch-result.txt"), "utf-8");
  assert.match(resultText, /ok/);
});

test("dispatch with --executor claude supports resume", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  writeFakeClaude(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-99",
    "-e", "claude",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "-e", "claude",
    "--prompt", "resume pass",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.executor, "claude");
  assert.equal(second.runState, STATES.REVIEW_PENDING);
});

test("timeout with commits produces completed-with-warning", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  // Fake codex that commits a file then sleeps forever (killed by timeout)
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(cwd + "/timeout-work.txt", "partial\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "timeout-work.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "partial work"], { stdio: "pipe" });
fs.writeFileSync(output, "partial result\\n", "utf-8");
setTimeout(() => {}, 60000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-timeout-work",
    "--prompt", "slow task",
    "--timeout", "1",
    "--json",
  ], env));

  assert.equal(result.status, "completed-with-warning");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.match(result.error, /timed out/);
});

test("timeout without commits produces failed", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  // Fake codex that does nothing but sleep
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
setTimeout(() => {}, 60000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  // dispatch exits non-zero on failure but still writes JSON to stdout
  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-timeout-empty",
    "--prompt", "idle task",
    "--timeout", "1",
    "--json",
  ])], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /timed out/);
});

test("re-dispatch prompt includes previous iteration history", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-77",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const runId = first.runId;
  const manifestPath = first.manifestPath;

  // Simulate: reviewer captures attempt data, then transitions to changes_requested
  captureAttempt(repoRoot, runId, {
    score_log: "| Factor | Target | Final |\n| Perf | < 0.2s | 0.35s |",
    reviewer_feedback: "Timeout middleware missing on /api/orders endpoint",
    failed_approaches: ["Fixed-delay retry"],
  });

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);

  // Re-dispatch — should include history in prompt
  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "--prompt", "fix the issues",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runState, STATES.REVIEW_PENDING);

  // Verify the persisted dispatch prompt includes the history section
  const dispatchPrompt = fs.readFileSync(path.join(second.runDir, "dispatch-prompt.md"), "utf-8");
  assert.match(dispatchPrompt, /Previous Attempt \(dispatch #1\)/);
  assert.match(dispatchPrompt, /Score Log/);
  assert.match(dispatchPrompt, /0\.35s/);
  assert.match(dispatchPrompt, /Timeout middleware missing/);
  assert.match(dispatchPrompt, /Do NOT Repeat/);
  assert.match(dispatchPrompt, /Fixed-delay retry/);
  assert.match(dispatchPrompt, /fix the issues/);
});

test("new dispatch manifest includes environment snapshot", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-96-env",
    "--prompt", "test env snapshot",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const manifest = readManifest(result.manifestPath).data;
  assert.ok(manifest.environment);
  assert.equal(manifest.environment.node_version, process.version);
  assert.equal(typeof manifest.environment.dispatch_ts, "string");
  // No remote in test repo, so main_sha is null
  assert.equal(manifest.environment.main_sha, null);
});

test("re-dispatch detects environment drift and records event", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-drift",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  // Tamper with manifest environment to simulate drift
  const record = readManifest(first.manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch");
  updated.environment.lockfile_hash = "sha256:old_hash_that_will_differ";
  writeManifest(first.manifestPath, updated, record.body);

  // Create a package-lock.json so current snapshot has a hash
  fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume with drift",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runState, STATES.REVIEW_PENDING);

  // Check that environment_drift event was recorded
  const events = fs.readFileSync(getEventsPath(repoRoot, first.runId), "utf-8");
  assert.match(events, /"event":"environment_drift"/);
  assert.match(events, /lockfile_hash/);
});

test("dispatch copies rubric file to run dir and records path in manifest", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-test-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, "rubric:\n  factors:\n    - name: test factor\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-rubric",
    "--prompt", "rubric test",
    "--rubric-file", rubricFile,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.ok(result.rubricPath);
  assert.ok(fs.existsSync(result.rubricPath));
  assert.match(fs.readFileSync(result.rubricPath, "utf-8"), /test factor/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.anchor.rubric_path, "rubric.yaml");

  fs.unlinkSync(rubricFile);
});

test("dispatch dry-run includes rubric file info", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-dry-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, "rubric:\n  factors: []\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-dry",
    "--prompt", "dry run test",
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ], env));

  assert.equal(result.rubricFile, rubricFile);

  fs.unlinkSync(rubricFile);
});

test("dispatch stores request linkage and frozen done criteria anchor in manifest", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const doneCriteriaFile = path.join(repoRoot, "done-criteria.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Intake snapshot\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-intake-linkage",
    "--prompt", "linkage test",
    "--request-id", "req-20260409010101000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.requestId, "req-20260409010101000");
  assert.equal(result.leafId, "leaf-01");
  assert.equal(result.doneCriteriaPath, doneCriteriaFile);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.source.request_id, "req-20260409010101000");
  assert.equal(manifest.source.leaf_id, "leaf-01");
  assert.equal(manifest.anchor.done_criteria_path, doneCriteriaFile);
  assert.equal(manifest.anchor.done_criteria_source, "request_snapshot");
});

test("dispatch dry-run includes request linkage and frozen done criteria file info", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const doneCriteriaFile = path.join(repoRoot, "done-criteria-dry.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Dry run snapshot\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-intake-dry",
    "--prompt", "dry linkage test",
    "--request-id", "req-20260409020202000",
    "--leaf-id", "leaf-99",
    "--done-criteria-file", doneCriteriaFile,
    "--dry-run", "--json",
  ], env));

  assert.equal(result.requestId, "req-20260409020202000");
  assert.equal(result.leafId, "leaf-99");
  assert.equal(result.doneCriteriaFile, doneCriteriaFile);
});

test("dispatch resume rejects changes to immutable intake linkage", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const doneCriteriaFile = path.join(repoRoot, "done-criteria.md");
  const alternateDoneCriteriaFile = path.join(repoRoot, "done-criteria-v2.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Original intake snapshot\n", "utf-8");
  fs.writeFileSync(alternateDoneCriteriaFile, "# Done Criteria\n\n- Changed intake snapshot\n", "utf-8");

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-intake-resume-guard",
    "--prompt", "first pass",
    "--request-id", "req-20260409030303000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume pass",
    "--request-id", "req-20260409030303000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", alternateDoneCriteriaFile,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot change immutable anchor\.done_criteria_path/);

  const manifest = readManifest(first.manifestPath).data;
  assert.equal(manifest.anchor.done_criteria_path, doneCriteriaFile);
  assert.equal(manifest.source.request_id, "req-20260409030303000");
});

test("dispatch resume keeps the original intake linkage when the same immutable values are supplied", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const doneCriteriaFile = path.join(repoRoot, "done-criteria.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Preserve the intake snapshot\n", "utf-8");

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-intake-resume-stable",
    "--prompt", "first pass",
    "--request-id", "req-20260409050505000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume pass",
    "--request-id", "req-20260409050505000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  assert.equal(second.requestId, "req-20260409050505000");
  assert.equal(second.leafId, "leaf-01");
  assert.equal(second.doneCriteriaPath, doneCriteriaFile);

  const manifest = readManifest(first.manifestPath).data;
  assert.equal(manifest.source.request_id, "req-20260409050505000");
  assert.equal(manifest.source.leaf_id, "leaf-01");
  assert.equal(manifest.anchor.done_criteria_path, doneCriteriaFile);
});

test("dispatch resume rejects adding intake linkage to a run that started without it", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-intake-resume-addition",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const doneCriteriaFile = path.join(repoRoot, "done-criteria-late.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Late linkage must fail\n", "utf-8");

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume pass",
    "--request-id", "req-20260409060606000",
    "--leaf-id", "leaf-01",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot add immutable source\.request_id/);

  const manifest = readManifest(first.manifestPath).data;
  assert.equal(manifest.source, undefined);
  assert.equal(manifest.anchor.done_criteria_path, undefined);
});

test("dispatch fails when rubric file does not exist", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-norubric",
    "--prompt", "test",
    "--rubric-file", "/tmp/nonexistent-rubric-file.yaml",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rubric file not found/);
});

test("dispatch fails when done criteria file does not exist", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-nodonecriteria",
    "--prompt", "test",
    "--done-criteria-file", "/tmp/nonexistent-done-criteria-file.md",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /done criteria file not found/);
});

test("dispatch without --rubric-file fails loudly even in dry-run mode", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-norubric2",
    "--prompt", "no rubric test",
    "--dry-run",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--rubric-file/);
  assert.match(result.stderr, /relay-plan/);
});

test("dispatch allows missing --rubric-file only when --rubric-grandfathered is explicit", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(execFileSync("node", [SCRIPT, repoRoot,
    "-b", "issue-grandfathered",
    "--prompt", "migration dry run",
    "--rubric-grandfathered",
    "--dry-run",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe", env }));

  assert.equal(result.mode, "new");
  assert.equal(result.rubricFile, null);
  assert.equal(result.rubricGrandfathered, true);
});
