const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  captureAttempt,
  createRunId,
  getEventsPath,
  getRubricAnchorStatus,
  getRunDir,
  listManifestPaths,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { evaluateReviewGate } = require("../../relay-merge/scripts/review-gate");
const { createEnforcementFixture } = require("./test-support");

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

function createUnrelatedRelayOwnedWorktree(repoRoot, relayHome, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "foreign\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  const relayWorktrees = path.join(relayHome, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const attackerWorktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "foreign-"));
  const attackerWorktree = path.join(attackerWorktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", attackerWorktree, "-b", branch], {
    cwd: attackerRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(attackerWorktree, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, attackerWorktree };
}

function createUnrelatedGitRepo(prefix = "relay-dispatch-manifest-cwd-") {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Manifest"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch-manifest@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "manifest selector\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
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

function writePreloadScript(dir, name, source) {
  const preloadPath = path.join(dir, name);
  fs.writeFileSync(preloadPath, source, "utf-8");
  return preloadPath;
}

function withNodePreload(env, preloadPath) {
  return {
    ...env,
    NODE_OPTIONS: env.NODE_OPTIONS
      ? `${env.NODE_OPTIONS} --require ${preloadPath}`
      : `--require ${preloadPath}`,
  };
}

function createGitOnlyPath() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-git-only-bin-"));
  const gitShim = path.join(binDir, "git");
  const gitPath = execFileSync("which", ["git"], { encoding: "utf-8", stdio: "pipe" }).trim();
  fs.writeFileSync(gitShim, `#!/bin/sh\nexec ${JSON.stringify(gitPath)} \"$@\"\n`, "utf-8");
  fs.chmodSync(gitShim, 0o755);
  return binDir;
}

function withRequiredRubric(args) {
  // AUTO-INJECT ENFORCEMENT RUBRIC — this is the contract side, NOT a grandfather bypass.
  // Tests that specifically cover rubric-missing scenarios must NOT use this helper.
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

function tamperResumableRunRubricPath(repoRoot, env, rubricPath) {
  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-rubric-anchor",
    "--prompt", "first pass",
    "--json",
  ], env));

  const record = readManifest(first.manifestPath);
  const updated = {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    anchor: {
      ...(record.data.anchor || {}),
      rubric_path: rubricPath,
    },
  };
  writeManifest(first.manifestPath, updated, record.body);
  return first;
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

test("dispatch resumes rubric fail-closed recovery runs from changes_requested", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-163",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const fixedRubricPath = path.join(repoRoot, "fixed-rubric.yaml");
  fs.writeFileSync(fixedRubricPath, [
    "rubric:",
    "  factors:",
    "    - name: recovery rubric",
    "      target: pass",
  ].join("\n"), "utf-8");

  const record = readManifest(manifestPath);
  const updated = {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "repair_rubric_and_redispatch"),
    review: {
      ...(record.data.review || {}),
      latest_verdict: "rubric_state_failed_closed",
      last_gate: {
        status: "rubric_state_failed_closed",
        layer: "review-runner",
        rubric_state: "missing",
        rubric_status: "missing",
        recovery_command: `node skills/relay-dispatch/scripts/dispatch.js . --run-id ${runId} --prompt-file <task.md> --rubric-file <fixed-rubric.yaml>`,
        recovery: "Restore or replace the missing rubric, then re-dispatch.",
        reason: "Rubric file is missing.",
      },
    },
  };
  writeManifest(manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "--prompt", "resume rubric recovery",
    "--rubric-file", fixedRubricPath,
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runState, STATES.REVIEW_PENDING);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.review.latest_verdict, "rubric_state_failed_closed");
  assert.equal(manifest.review.last_gate.status, "rubric_state_failed_closed");
});

test("dispatch can resume from --manifest while invoked from an unrelated git repo", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const selectorRepo = createUnrelatedGitRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-manifest-resume",
    "--prompt", "first pass",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const second = JSON.parse(execFileSync("node", [SCRIPT, selectorRepo,
    "--manifest", first.manifestPath,
    "--prompt", "resume via manifest selector",
    "--json",
  ], {
    cwd: selectorRepo,
    encoding: "utf-8",
    stdio: "pipe",
    env,
  }));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.runState, STATES.REVIEW_PENDING);
  assert.equal(readManifest(first.manifestPath).data.state, STATES.REVIEW_PENDING);
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
  assert.match(result.stderr, /(retained worktree is missing|manifest paths\.worktree)/);
  assert.equal(listManifestPaths(repoRoot).length, 1);
});

test("dispatch resume fails when --run-id does not resolve", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const missingRunId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });

  const result = spawnSync("node", [
    SCRIPT,
    repoRoot,
    "--run-id", missingRunId,
    "--prompt", "resume",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`No relay manifest found for run_id '${missingRunId}'`));
});

test("dispatch resume rejects crafted manifest repo roots before touching an unrelated repo", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-160",
    "--prompt", "first pass",
    "--json",
  ], env));
  const manifestPath = first.manifestPath;
  const runId = first.runId;

  const attackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-attacker-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Attacker"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "attacker@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "attacker\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });

  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    paths: {
      ...(record.data.paths || {}),
      repo_root: attackerRoot,
      worktree: path.join(attackerRoot, "wt", "issue-160"),
    },
  }, record.body);

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.repo_root/);
  assert.equal(fs.existsSync(path.join(attackerRoot, "first.txt")), false, "dispatch must reject before writing into the attacker repo");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
});

test("dispatch resume rejects relay-base same-name worktrees from a different repo before reuse", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-160",
    "--prompt", "first pass",
    "--json",
  ], env));
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot, relayHome, "issue-160");
  const record = readManifest(first.manifestPath);
  writeManifest(first.manifestPath, {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", first.runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.worktree/);
  assert.equal(fs.existsSync(path.join(attackerWorktree, "resume.txt")), false, "dispatch must reject before reusing the foreign relay worktree");
  assert.equal(readManifest(first.manifestPath).data.state, STATES.CHANGES_REQUESTED);
});

test("dispatch refuses same-ms same-branch run-dir collisions for new runs", () => {
  // #158 anti-theater
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const preloadPath = writePreloadScript(binDir, "fixed-run-id-preload.js", `const crypto = require("crypto");
const fixedTime = new Date("2026-04-17T08:00:00.000Z");
const RealDate = Date;
let randomCallCount = 0;
global.Date = class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedTime.toISOString()]));
  }
  static now() {
    return fixedTime.valueOf();
  }
  static parse(value) {
    return RealDate.parse(value);
  }
  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};
crypto.randomBytes = function randomBytes(size) {
  randomCallCount += 1;
  if (size === 4 && randomCallCount === 1) {
    const wtSeed = Buffer.alloc(4);
    wtSeed.writeUInt32BE(process.pid >>> 0, 0);
    return wtSeed;
  }
  if (size === 4 && randomCallCount === 2) {
    return Buffer.from("a1b2c3d4", "hex");
  }
  return Buffer.alloc(size, 0x5a);
};`);
  const env = withNodePreload({ ...process.env, PATH: `${binDir}:${process.env.PATH}` }, preloadPath);

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-158",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.status, "completed");

  const second = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-158",
    "--prompt", "second pass",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite existing run dir:/);
  assert.match(second.stderr, new RegExp(first.runId));
  assert.match(second.stderr, /Pass --run-id <id> to resume, or --manifest <path> to resume from an explicit manifest\./);
});

test("dispatch cleans up tmp rubric files when atomic rubric persistence fails", () => {
  // #158 anti-theater
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const preloadPath = writePreloadScript(binDir, "rename-failure-preload.js", `const fs = require("fs");
const path = require("path");
const originalRenameSync = fs.renameSync;
fs.renameSync = function renameSync(sourcePath, destPath) {
  if (
    typeof sourcePath === "string"
    && typeof destPath === "string"
    && sourcePath.endsWith(\`\${path.sep}rubric.yaml.tmp\`)
    && destPath.endsWith(\`\${path.sep}rubric.yaml\`)
  ) {
    const error = new Error("simulated rubric rename failure");
    error.code = "EXDEV";
    throw error;
  }
  return originalRenameSync.call(this, sourcePath, destPath);
};`);
  const rubricFile = path.join(os.tmpdir(), `relay-dispatch-atomic-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, "rubric:\n  factors:\n    - name: atomic copy\n", "utf-8");
  const env = withNodePreload({ ...process.env, PATH: `${binDir}:${process.env.PATH}` }, preloadPath);

  const result = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-158-atomic",
    "--prompt", "atomic rubric copy",
    "--rubric-file", rubricFile,
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated rubric rename failure/);

  const manifestPath = listManifestPaths(repoRoot)[0];
  assert.ok(manifestPath, "dispatch should have persisted the manifest before rubric copy");
  const manifest = readManifest(manifestPath).data;
  const runDir = getRunDir(repoRoot, manifest.run_id);
  assert.equal(fs.existsSync(path.join(runDir, "rubric.yaml")), false);
  assert.equal(fs.existsSync(path.join(runDir, "rubric.yaml.tmp")), false);
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

test("dispatched run whose persisted rubric is empty fails closed at the review gate", () => {
  // #153 enforcement-path coverage — negative case the #147 suite missed
  // (originating findings: #148 file-existence/containment invariant,
  // #149 manifest resolution stricture, #151 grandfather-provenance scope).
  //
  // Contract: a dispatched run whose rubric.yaml is empty must NOT pass the
  // downstream review/merge gate. This test simulates post-dispatch rubric
  // truncation (operator tampering or stale state) and verifies
  // evaluateReviewGate returns status=empty_rubric_file / readyToMerge=false.
  // Dispatch-time rejection of empty --rubric-file is #148's territory and is
  // intentionally NOT re-tested here.
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const validRubricFile = path.join(os.tmpdir(), `relay-valid-rubric-${Date.now()}.yaml`);
  fs.writeFileSync(validRubricFile, "rubric:\n  factors:\n    - name: ok\n      target: pass\n", "utf-8");
  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-truncated-rubric",
    "--prompt", "truncation test",
    "--rubric-file", validRubricFile,
    "--json",
  ], env));
  assert.equal(result.status, "completed");
  fs.unlinkSync(validRubricFile);

  createEnforcementFixture({
    repoRoot,
    runId: result.runId,
    manifestPath: result.manifestPath,
    state: "empty",
  });
  const manifest = readManifest(result.manifestPath).data;
  const runDir = getRunDir(repoRoot, result.runId);
  const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
  const gate = evaluateReviewGate({
    prNumber: 123,
    comments: [],
    commits: [],
    manifestData: manifest,
    runDir,
  });

  assert.equal(rubricAnchor.status, "empty");
  assert.equal(gate.status, "empty_rubric_file");
  assert.equal(gate.readyToMerge, false);
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

test("dispatch resume rejects anchor.rubric_path values with parent traversal", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = tamperResumableRunRubricPath(repoRoot, env, "../escape.yaml");
  const result = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume with invalid rubric anchor",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.\./);
  assert.match(result.stderr, /inside the run directory/i);
});

test("dispatch resume rejects absolute anchor.rubric_path values", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = tamperResumableRunRubricPath(repoRoot, env, "/tmp/escape.yaml");
  const result = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume with invalid rubric anchor",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute paths are not allowed/i);
  assert.match(result.stderr, /\/tmp\/escape\.yaml/);
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

test("dispatch without --rubric-file fails loudly in non-dry-run mode", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-norubric3",
    "--prompt", "no rubric test",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--rubric-file/);
});

test("dispatch rejects --rubric-grandfathered on new dispatches", () => {
  // #151
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-grandfathered",
    "--prompt", "migration dry run",
    "--rubric-grandfathered",
    "--dry-run",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /relay-migrate-rubric\.js/);
  assert.match(result.stderr, /deprecated/i);
});

test("dispatch rejects --rubric-grandfathered on same-run resumes and points to the migration script", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-legacy-grandfathered",
    "--prompt", "first pass",
    "--json",
  ], env));

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  updated = {
    ...updated,
    anchor: {
      ...updated.anchor,
    },
    timestamps: {
      ...updated.timestamps,
      created_at: "2026-04-12T01:00:00.000Z",
    },
  };
  delete updated.anchor.rubric_path;
  delete updated.anchor.rubric_grandfathered;
  writeManifest(manifestPath, updated, record.body);

  const result = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", runId,
    "--prompt", "resume legacy migration",
    "--rubric-grandfathered",
    "--dry-run",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /relay-migrate-rubric\.js/);
});

test("dispatch rejects --rubric-grandfathered for review_pending legacy runs", () => {
  // LEGACY GRANDFATHER DISPATCH PATH — remove when deprecation completes
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-legacy-review-pending",
    "--prompt", "first pass",
    "--json",
  ], env));

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    anchor: {
      ...record.data.anchor,
    },
    timestamps: {
      ...record.data.timestamps,
      created_at: "2026-04-12T01:00:00.000Z",
    },
  };
  delete updated.anchor.rubric_path;
  delete updated.anchor.rubric_grandfathered;
  writeManifest(manifestPath, updated, record.body);

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot,
    "--run-id", runId,
    "--rubric-grandfathered",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...env, PATH: createGitOnlyPath() },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /relay-migrate-rubric\.js/);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.anchor.rubric_grandfathered, undefined);
});

test("dispatch rejects --rubric-grandfathered for ready_to_merge legacy runs", () => {
  // LEGACY GRANDFATHER DISPATCH PATH — remove when deprecation completes
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-legacy-ready",
    "--prompt", "first pass",
    "--json",
  ], env));

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.READY_TO_MERGE, "merge");
  updated = {
    ...updated,
    anchor: {
      ...updated.anchor,
    },
    timestamps: {
      ...updated.timestamps,
      created_at: "2026-04-12T01:00:00.000Z",
    },
  };
  delete updated.anchor.rubric_path;
  delete updated.anchor.rubric_grandfathered;
  writeManifest(manifestPath, updated, record.body);

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot,
    "--run-id", runId,
    "--rubric-grandfathered",
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...env, PATH: createGitOnlyPath() },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /relay-migrate-rubric\.js/);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.anchor.rubric_grandfathered, undefined);
});
