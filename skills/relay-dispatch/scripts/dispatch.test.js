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
const { buildPrBody, pushAndOpenPR } = require("./dispatch-publish");
const { evaluateReviewGate } = require("../../relay-merge/scripts/review-gate");
const { createEnforcementFixture } = require("./test-support");

const SCRIPT = path.join(__dirname, "dispatch.js");
const WORKTREE_RUNTIME_FIXTURE_DIR = path.join(__dirname, "__fixtures__", "worktree-runtime");
const CANONICAL_DRY_RUN_ROOT = "/tmp/issue187-fixtures";
const CANONICAL_DRY_RUN_SLUG = "repo-c079affd";

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-origin-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { repoRoot, relayHome, remoteRoot };
}

function setupRepoWithOrigin() {
  return setupRepo();
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
  ensureDefaultFakeGh(binDir);
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
  ensureDefaultFakeGh(binDir);
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

function writeNoOpCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeFakeGh(binDir) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.RELAY_TEST_GH_STATE;
const logPath = process.env.RELAY_TEST_GH_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}
const state = statePath && fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
  : {};
if (args[0] === "pr" && args[1] === "list") {
  if (state.failPrList) {
    process.stderr.write(state.failPrList + "\\n");
    process.exit(1);
  }
  if (state.prListNumber !== undefined && state.prListNumber !== null) {
    process.stdout.write(String(state.prListNumber) + "\\n");
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  if (state.failPrCreate) {
    process.stderr.write(state.failPrCreate + "\\n");
    process.exit(1);
  }
  process.stdout.write(String(state.prCreateUrl || "") + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function ensureDefaultFakeGh(binDir) {
  const ghPath = path.join(binDir, "gh");
  if (fs.existsSync(ghPath)) return ghPath;
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/acme/dev-relay/pull/123\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
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

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createExecFileMock({ existingPrNumber = null, prCreateUrl = null, gitPushError = null, prCreateError = null, gitLogOutput = "fake: dispatch publish" } = {}) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args: [...args], options });

    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return existingPrNumber === null ? "" : `${existingPrNumber}\n`;
    }
    if (command === "git" && args.includes("push")) {
      if (gitPushError) {
        const error = new Error(gitPushError);
        error.stderr = Buffer.from(`${gitPushError}\n`);
        throw error;
      }
      return "";
    }
    if (command === "git" && args.includes("log")) {
      return `${gitLogOutput}\n`;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      if (prCreateError) {
        const error = new Error(prCreateError);
        error.stderr = Buffer.from(`${prCreateError}\n`);
        throw error;
      }
      return `${prCreateUrl || ""}\n`;
    }

    throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
  };

  return { execFile, calls };
}

function createPushPrTestEnv({ relayHome, ghState = {}, failGitPush = false, codexMode = "commit" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-push-pr-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-push-pr-bin-"));
  if (codexMode === "noop") {
    writeNoOpCodex(binDir);
  } else {
    writeFakeCodex(binDir);
  }
  writeFakeGh(binDir);

  const ghStatePath = path.join(root, "gh-state.json");
  const ghLogPath = path.join(root, "gh-log.jsonl");
  const execLogPath = path.join(root, "exec-log.jsonl");
  fs.writeFileSync(ghStatePath, JSON.stringify(ghState), "utf-8");

  const preloadPath = writePreloadScript(root, "dispatch-push-pr-preload.js", `
const fs = require("fs");
const childProcess = require("child_process");
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const logPath = process.env.RELAY_TEST_EXEC_LOG;
  const ghLogPath = process.env.RELAY_TEST_GH_LOG;
  const statePath = process.env.RELAY_TEST_GH_STATE;
  const isPush = command === "git" && argv.includes("push");
  const isGh = command === "gh";
  if (logPath && (isPush || isGh)) {
    fs.appendFileSync(logPath, JSON.stringify({ command, args: argv }) + "\\n");
  }
  if (ghLogPath && isGh) {
    fs.appendFileSync(ghLogPath, JSON.stringify(argv) + "\\n");
  }
  if (process.env.RELAY_TEST_FAIL_GIT_PUSH === "1" && isPush) {
    const error = new Error("simulated git push failure");
    error.stderr = Buffer.from("simulated git push failure\\n");
    throw error;
  }
  if (isPush) {
    return "";
  }
  if (isGh) {
    const state = statePath && fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
      : {};
    if (argv[0] === "pr" && argv[1] === "list") {
      if (state.failPrList) {
        const error = new Error(state.failPrList);
        error.stderr = Buffer.from(state.failPrList + "\\n");
        throw error;
      }
      return state.prListNumber !== undefined && state.prListNumber !== null
        ? String(state.prListNumber) + "\\n"
        : "";
    }
    if (argv[0] === "pr" && argv[1] === "create") {
      if (state.failPrCreate) {
        const error = new Error(state.failPrCreate);
        error.stderr = Buffer.from(state.failPrCreate + "\\n");
        throw error;
      }
      return state.prCreateUrl ? String(state.prCreateUrl) + "\\n" : "";
    }
  }
  return originalExecFileSync.call(this, command, args, options);
};
`);

  const env = withNodePreload({
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_GH_STATE: ghStatePath,
    RELAY_TEST_GH_LOG: ghLogPath,
    RELAY_TEST_EXEC_LOG: execLogPath,
    ...(failGitPush ? { RELAY_TEST_FAIL_GIT_PUSH: "1" } : {}),
  }, preloadPath);

  return { env, ghLogPath, execLogPath, ghStatePath };
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

function setupDryRunFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-dry-run-"));
  const repoRoot = path.join(root, "repo");
  const relayHome = path.join(root, "relay-home");
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Dry Run"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch-dry-run@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const rubricFile = path.join(root, "rubric.yaml");
  fs.writeFileSync(rubricFile, "rubric:\n  factors:\n    - name: test\n      target: pass\n", "utf-8");

  const preloadPath = writePreloadScript(root, "dispatch-dry-run-preload.js", `
const crypto = require("crypto");
const seq = ["11111111", "22222222"];
let idx = 0;
const originalRandomBytes = crypto.randomBytes;
crypto.randomBytes = function patchedRandomBytes(size) {
  const next = seq[Math.min(idx++, seq.length - 1)];
  const buf = Buffer.from(next, "hex");
  return buf.length === size ? buf : originalRandomBytes(size);
};
const RealDate = Date;
const fixedNow = new RealDate("2026-04-18T00:50:00.000Z").valueOf();
class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]));
  }
  static now() {
    return fixedNow;
  }
}
global.Date = FixedDate;
process.env.RELAY_HOME = ${JSON.stringify(relayHome)};
process.env.TMPDIR = ${JSON.stringify(tmpDir)};
`);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-dry-run-bin-"));
  writeFakeCodex(binDir);
  const env = withNodePreload({
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    TMPDIR: tmpDir,
  }, preloadPath);

  return { root, repoRoot, rubricFile, env };
}

function normalizeDispatchDryRunOutput(output, { root }) {
  const normalizedRoot = output.split(root).join(CANONICAL_DRY_RUN_ROOT);
  return normalizedRoot.replace(/\/runs\/[^/]+\//g, `/runs/${CANONICAL_DRY_RUN_SLUG}/`).trimEnd();
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

test("dispatch with --register --executor claude does not emit the codex-only warning", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  const preloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-register-preload-"));
  writeFakeClaude(binDir);
  const preloadPath = writePreloadScript(preloadRoot, "dispatch-claude-register-preload.js", `
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./claude-app-register" || request.endsWith("/claude-app-register")) {
    return {
      registerClaudeApp() {
        return {
          sessionId: "claude-session-fixed",
          metadataPath: "/tmp/claude-registration.json",
        };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
`);
  const env = withNodePreload({
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  }, preloadPath);

  const result = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-87-claude-register",
    "-e", "claude",
    "--prompt", "register claude task",
    "--register",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /--register is only supported for codex executor/);
  assert.doesNotMatch(result.stdout, /--register is only supported for codex executor/);
  assert.doesNotMatch(result.stdout, /claude registration failed:/);
  assert.match(result.stdout, /Registered in claude app\./);
});

test("timeout with commits produces completed-with-warning", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  ensureDefaultFakeGh(binDir);
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
  assert.equal(result.prNumber, 123);
  assert.equal(result.prCreatedByUs, true);
  assert.match(result.error, /timed out/);

  const remoteBranch = execFileSync("git", ["ls-remote", "--heads", "origin", "issue-timeout-work"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  assert.match(remoteBranch, /\brefs\/heads\/issue-timeout-work$/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.github.pr_number, 123);
  assert.equal(manifest.github.pr_created_by_orchestrator, true);
});

test("timeout without commits produces failed", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  ensureDefaultFakeGh(binDir);
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

test("pushAndOpenPR uses the injected execFile seam for happy-path publication", async () => {
  const { execFile, calls } = createExecFileMock({
    prCreateUrl: "https://github.com/acme/dev-relay/pull/321",
    gitLogOutput: "feat: publish orchestrator PR",
  });

  const result = await pushAndOpenPR({
    repoRoot: "/tmp/repo",
    wtPath: "/tmp/repo-worktree",
    branch: "issue-198",
    baseBranch: "main",
    resultPreview: "Implemented orchestrator-side publication.",
    runId: "issue-198-run",
    executor: "codex",
    execFile,
  });

  assert.deepEqual(result, { prNumber: 321, createdByUs: true });
  assert.deepEqual(calls.map(({ command, args }) => [command, args.slice(0, 2)]), [
    ["gh", ["pr", "list"]],
    ["git", ["-C", "/tmp/repo-worktree"]],
    ["git", ["-C", "/tmp/repo-worktree"]],
    ["gh", ["pr", "create"]],
  ]);

  const createCall = calls.find(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create");
  assert.ok(createCall, "expected gh pr create call");
  assert.ok(createCall.args.includes("--title"));
  assert.ok(createCall.args.includes("feat: publish orchestrator PR"));
  assert.ok(createCall.args.includes("--body"));
  const body = buildPrBody({
    resultPreview: "Implemented orchestrator-side publication.",
    runId: "issue-198-run",
    executor: "codex",
    branch: "issue-198",
  });
  assert.ok(createCall.args.includes(body));
  assert.match(body, /^## Score Log$/m);
  assert.match(body, /^- Run: issue-198-run$/m);
  assert.match(body, /^- Executor: codex$/m);
  assert.match(body, /^- Branch: issue-198$/m);
});

test("pushAndOpenPR skips PR creation when the branch already has an open PR", async () => {
  const { execFile, calls } = createExecFileMock({
    existingPrNumber: 654,
  });

  const result = await pushAndOpenPR({
    repoRoot: "/tmp/repo",
    wtPath: "/tmp/repo-worktree",
    branch: "issue-198-existing-pr",
    baseBranch: "main",
    resultPreview: "Reuse existing PR.",
    runId: "issue-198-existing-pr-run",
    executor: "codex",
    execFile,
  });

  assert.deepEqual(result, { prNumber: 654, createdByUs: false });
  assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create").length, 0);
  assert.equal(calls.filter(({ command, args }) => command === "git" && args.includes("push")).length, 1);
});

test("pushAndOpenPR surfaces injected git push failures", async () => {
  const { execFile } = createExecFileMock({
    gitPushError: "simulated git push failure",
  });

  await assert.rejects(
    pushAndOpenPR({
      repoRoot: "/tmp/repo",
      wtPath: "/tmp/repo-worktree",
      branch: "issue-198-push-fail",
      baseBranch: "main",
      resultPreview: "Trigger push failure.",
      runId: "issue-198-push-fail-run",
      executor: "codex",
      execFile,
    }),
    /git_push_failed: simulated git push failure/
  );
});

test("pushAndOpenPR surfaces injected gh pr create failures", async () => {
  const { execFile } = createExecFileMock({
    prCreateError: "simulated gh pr create failure",
  });

  await assert.rejects(
    pushAndOpenPR({
      repoRoot: "/tmp/repo",
      wtPath: "/tmp/repo-worktree",
      branch: "issue-198-pr-fail",
      baseBranch: "main",
      resultPreview: "Trigger PR failure.",
      runId: "issue-198-pr-fail-run",
      executor: "codex",
      execFile,
    }),
    /gh_pr_create_failed: simulated gh pr create failure/
  );
});

test("dispatch pushes the branch and opens a PR from the orchestrator on success", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/321",
    },
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-198",
    "--prompt", "implement orchestrator PR creation",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 321);
  assert.equal(result.prCreatedByUs, true);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.git.pr_number, 321);
  assert.equal(manifest.github.pr_number, 321);
  assert.equal(manifest.github.pr_created_by_orchestrator, true);

  const ghCalls = readJsonLines(ghLogPath);
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["pr", "list"], ["pr", "create"]]);
  const execCalls = readJsonLines(execLogPath);
  assert.ok(execCalls.some((entry) => entry.command === "git" && entry.args.includes("push")));
});

test("dispatch dry-run never invokes orchestrator push or PR creation", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/322",
    },
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-198-dry-run",
    "--prompt", "preview only",
    "--dry-run",
    "--json",
  ], env));

  assert.equal(result.mode, "new");
  assert.equal(result.runState, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
});

test("dispatch escalates when orchestrator git push fails", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/323",
    },
    failGitPush: true,
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-198-push-fail",
    "--prompt", "trigger push failure",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /push_or_pr_failed: git_push_failed/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.git.pr_number, null);
});

test("dispatch escalates when orchestrator PR creation fails", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      failPrCreate: "simulated gh pr create failure",
    },
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-198-pr-fail",
    "--prompt", "trigger PR failure",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /push_or_pr_failed: gh_pr_create_failed/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.git.pr_number, null);
});

test("dispatch skips PR creation when the branch already has an open PR", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prListNumber: 654,
      prCreateUrl: "https://github.com/acme/dev-relay/pull/999",
    },
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-198-existing-pr",
    "--prompt", "reuse existing PR",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 654);
  assert.equal(result.prCreatedByUs, false);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.git.pr_number, 654);
  assert.equal(manifest.github.pr_number, 654);
  assert.equal(manifest.github.pr_created_by_orchestrator, false);

  const ghCalls = readJsonLines(ghLogPath);
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["pr", "list"]]);
});

test("dispatch silent-failure path skips orchestrator push and PR creation when no commits were made", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/324",
    },
    codexMode: "noop",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-198-no-commits",
    "--prompt", "do nothing",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /silent failure/);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
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
  assert.match(manifest.environment.main_sha, /^[0-9a-f]{40}$/);
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

test("dispatch dry-run json matches the frozen fixture", () => {
  const fixtureRun = setupDryRunFixtureRepo();
  const stdout = runDispatch(fixtureRun.repoRoot, [
    "-b", "test-branch",
    "--prompt", "task",
    "--rubric-file", fixtureRun.rubricFile,
    "--dry-run",
    "--json",
  ], fixtureRun.env);

  const expected = fs.readFileSync(path.join(WORKTREE_RUNTIME_FIXTURE_DIR, "dispatch-dry-run.json"), "utf-8").trimEnd();
  assert.equal(normalizeDispatchDryRunOutput(stdout, fixtureRun), expected);
});

test("dispatch dry-run text matches the frozen fixture", () => {
  const fixtureRun = setupDryRunFixtureRepo();
  const stdout = runDispatch(fixtureRun.repoRoot, [
    "-b", "test-branch",
    "--prompt", "task",
    "--rubric-file", fixtureRun.rubricFile,
    "--dry-run",
  ], fixtureRun.env);

  const expected = fs.readFileSync(path.join(WORKTREE_RUNTIME_FIXTURE_DIR, "dispatch-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(normalizeDispatchDryRunOutput(stdout, fixtureRun), expected);
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
  assert.match(result.stderr, /--rubric-grandfathered is retired/);
  assert.match(result.stderr, /Remove anchor\.rubric_grandfathered/);
  assert.doesNotMatch(result.stderr, /relay-migrate-rubric/);
});

test("dispatch rejects --rubric-grandfathered on same-run resumes", () => {
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
  assert.match(result.stderr, /--rubric-grandfathered is retired/);
});

test("dispatch rejects --rubric-grandfathered for review_pending legacy runs", () => {
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
  assert.match(result.stderr, /--rubric-grandfathered is retired/);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.anchor.rubric_grandfathered, undefined);
});

test("dispatch rejects --rubric-grandfathered for ready_to_merge legacy runs", () => {
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
  assert.match(result.stderr, /--rubric-grandfathered is retired/);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.anchor.rubric_grandfathered, undefined);
});

test("dispatch pre-flight applies the legacy-grandfather retirement matrix", async (t) => {
  const cases = [
    { label: "undefined", value: undefined, allowed: true },
    { label: "false", value: false, allowed: false },
    { label: "true", value: true, allowed: false },
    {
      label: "object",
      value: {
        from_migration: "rubric-mandatory.yaml",
        applied_at: "2026-04-17T08:00:05.000Z",
        actor: "dispatch-test",
      },
      allowed: false,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const { repoRoot, relayHome } = setupRepo();
      process.env.RELAY_HOME = relayHome;
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
      writeFakeCodex(binDir);
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

      const first = JSON.parse(runDispatch(repoRoot, [
        "-b", `issue-grandfather-matrix-${entry.label}`,
        "--prompt", "first pass",
        "--json",
      ], env));

      const record = readManifest(first.manifestPath);
      const updatedAnchor = { ...(record.data.anchor || {}) };
      if (entry.value === undefined) {
        delete updatedAnchor.rubric_grandfathered;
      } else {
        updatedAnchor.rubric_grandfathered = entry.value;
      }
      writeManifest(first.manifestPath, {
        ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
        anchor: updatedAnchor,
      }, record.body);

      const result = spawnSync("node", [SCRIPT, repoRoot,
        "--run-id", first.runId,
        "--prompt", "resume matrix",
        "--dry-run",
        "--json",
      ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe", env });

      if (entry.allowed) {
        assert.equal(result.status, 0);
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.runId, first.runId);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /anchor\.rubric_grandfathered is no longer supported/);
      }
    });
  }
});
