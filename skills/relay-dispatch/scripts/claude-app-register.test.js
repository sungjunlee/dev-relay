const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withRelayHome(relayHome, fn) {
  const previous = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previous;
  }
}

function loadRegisterClaudeApp(execFileSyncImpl) {
  const childProcess = require("child_process");
  const originalExecFileSync = childProcess.execFileSync;
  delete require.cache[require.resolve("./claude-app-register")];
  childProcess.execFileSync = execFileSyncImpl;
  try {
    return require("./claude-app-register").registerClaudeApp;
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }
}

function createExecFileSyncStub({ claudeVersion = "Claude Code 1.2.3", failGit = false } = {}) {
  return function execFileSyncStub(command, args, options) {
    if (command === "claude") return `${claudeVersion}\n`;
    if (command === "git" && failGit) throw new Error("git unavailable");
    return execFileSync(command, args, options);
  };
}

function setupGitWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-register-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = path.join(root, "repo");
  const wtHash = "1234abcd";
  const wtPath = path.join(relayHome, "worktrees", wtHash, "repo");

  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Claude Register Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "claude-register@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/dev-relay.git"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  execFileSync("git", ["worktree", "add", wtPath, "-b", "issue-87"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  return { relayHome, repoRoot, wtPath, wtHash };
}

test("registerClaudeApp writes a relay-side registration receipt with expected fields", () => {
  const { relayHome, repoRoot, wtPath, wtHash } = setupGitWorktree();
  const registerClaudeApp = loadRegisterClaudeApp(createExecFileSyncStub());

  const result = withRelayHome(relayHome, () => registerClaudeApp({
    wtPath,
    repoPath: repoRoot,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: true,
  }));

  assert.match(result.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.metadataPath, path.join(relayHome, "worktrees", wtHash, "claude-registration.json"));
  assert.ok(fs.existsSync(result.metadataPath));

  const payload = JSON.parse(fs.readFileSync(result.metadataPath, "utf-8"));
  assert.deepEqual(payload, {
    version: "1",
    created_at: payload.created_at,
    session_id: result.sessionId,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: true,
    cli_version: "Claude Code 1.2.3",
    git: {
      commit_hash: execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim(),
      repository_url: "https://github.com/acme/dev-relay.git",
    },
    note: "Claude Code creates real session JSONL on first invocation under ~/.claude/projects/<slug>/; this file is a relay-side registration receipt.",
  });
  assert.match(payload.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
});

test("registerClaudeApp overwrites the existing receipt for the same worktree", () => {
  const { relayHome, repoRoot, wtPath } = setupGitWorktree();
  const registerClaudeApp = loadRegisterClaudeApp(createExecFileSyncStub());

  const first = withRelayHome(relayHome, () => registerClaudeApp({
    wtPath,
    repoPath: repoRoot,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: false,
  }));
  const second = withRelayHome(relayHome, () => registerClaudeApp({
    wtPath,
    repoPath: repoRoot,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: false,
  }));

  assert.equal(first.metadataPath, second.metadataPath);
  assert.notEqual(first.sessionId, second.sessionId);

  const payload = JSON.parse(fs.readFileSync(second.metadataPath, "utf-8"));
  assert.equal(payload.session_id, second.sessionId);
});

test("registerClaudeApp honors RELAY_HOME overrides and never targets the operator default path", () => {
  const { relayHome, repoRoot, wtPath } = setupGitWorktree();
  const registerClaudeApp = loadRegisterClaudeApp(createExecFileSyncStub());

  const result = withRelayHome(relayHome, () => registerClaudeApp({
    wtPath,
    repoPath: repoRoot,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: false,
  }));

  assert.ok(result.metadataPath.startsWith(path.join(relayHome, "worktrees") + path.sep));
  assert.ok(!result.metadataPath.startsWith(path.join(os.homedir(), ".relay", "worktrees") + path.sep));
});

test("registerClaudeApp tolerates missing git metadata and still writes the receipt", () => {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const wtPath = path.join(relayHome, "worktrees", "deadbeef", "repo");
  const registerClaudeApp = loadRegisterClaudeApp(createExecFileSyncStub({ failGit: true }));

  fs.mkdirSync(wtPath, { recursive: true });
  const result = withRelayHome(relayHome, () => registerClaudeApp({
    wtPath,
    repoPath: wtPath,
    branch: "issue-87",
    title: "Dispatch: issue-87",
    pin: false,
  }));

  assert.ok(fs.existsSync(result.metadataPath));
  const payload = JSON.parse(fs.readFileSync(result.metadataPath, "utf-8"));
  assert.equal(payload.cli_version, "Claude Code 1.2.3");
  assert.deepEqual(payload.git, {
    commit_hash: "",
    repository_url: "",
  });
});
