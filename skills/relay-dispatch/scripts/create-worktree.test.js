const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "create-worktree.js");
const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "worktree-runtime");
const CANONICAL_ROOT = "/tmp/issue187-fixtures";
const CANONICAL_EXTERNAL_ROOT = "/tmp/issue187-fixtures-external";

function writeFakeCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
process.stderr.write("unsupported fake codex invocation");
process.exit(1);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function setupFixtureRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, "repo");
  const relayHome = path.join(root, "relay-home");
  const tmpDir = path.join(root, "tmp");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(relayHome, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Create Worktree Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "create-worktree@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "", "utf-8");
  return { root, repoRoot, relayHome, tmpDir, codexHome };
}

function writePreload(root, { relayHome, tmpDir, codexHome, randomHexes, fixedNow, extraSource = "" }) {
  const preloadPath = path.join(root, "preload.js");
  const source = `
const crypto = require("crypto");
const seq = ${JSON.stringify(randomHexes)};
let idx = 0;
const originalRandomBytes = crypto.randomBytes;
crypto.randomBytes = function patchedRandomBytes(size) {
  const next = seq[Math.min(idx++, seq.length - 1)];
  const buf = Buffer.from(next, "hex");
  return buf.length === size ? buf : originalRandomBytes(size);
};
const RealDate = Date;
const fixedNow = new RealDate(${JSON.stringify(fixedNow)}).valueOf();
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
process.env.CODEX_HOME = ${JSON.stringify(codexHome)};
${extraSource}
`;
  fs.writeFileSync(preloadPath, source, "utf-8");
  return preloadPath;
}

function buildEnv(root, preloadPath) {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeFakeCodex(binDir);
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NODE_OPTIONS: `--require ${preloadPath}`,
  };
}

function runCreateWorktree(args, env) {
  return execFileSync("node", [SCRIPT, ...args], {
    cwd: path.dirname(SCRIPT),
    encoding: "utf-8",
    stdio: "pipe",
    env,
  });
}

function normalizeOutput(text, actualRoot, canonicalRoot) {
  return text.split(actualRoot).join(canonicalRoot).trimEnd();
}

test("create-worktree dry-run json matches the frozen fixture", () => {
  const setup = setupFixtureRoot("relay-create-worktree-json-");
  const preloadPath = writePreload(setup.root, {
    relayHome: setup.relayHome,
    tmpDir: setup.tmpDir,
    codexHome: setup.codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
  });
  const stdout = runCreateWorktree([setup.repoRoot, "--dry-run", "--json"], buildEnv(setup.root, preloadPath));
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-dry-run.json"), "utf-8").trimEnd();
  assert.equal(normalizeOutput(stdout, setup.root, CANONICAL_ROOT), expected);
});

test("create-worktree dry-run text matches the frozen fixture", () => {
  const setup = setupFixtureRoot("relay-create-worktree-text-");
  const preloadPath = writePreload(setup.root, {
    relayHome: setup.relayHome,
    tmpDir: setup.tmpDir,
    codexHome: setup.codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
  });
  const stdout = runCreateWorktree([setup.repoRoot, "--dry-run"], buildEnv(setup.root, preloadPath));
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(normalizeOutput(stdout, setup.root, CANONICAL_ROOT), expected);
});

test("create-worktree register+pin dry-run json matches the frozen fixture", () => {
  const setup = setupFixtureRoot("relay-create-worktree-register-json-");
  const preloadPath = writePreload(setup.root, {
    relayHome: setup.relayHome,
    tmpDir: setup.tmpDir,
    codexHome: setup.codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
  });
  const stdout = runCreateWorktree([
    setup.repoRoot,
    "--branch", "feature-register",
    "--title", "Pinned Register",
    "--register",
    "--pin",
    "--dry-run",
    "--json",
  ], buildEnv(setup.root, preloadPath));
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-register-pin-dry-run.json"), "utf-8").trimEnd();
  assert.equal(normalizeOutput(stdout, setup.root, CANONICAL_ROOT), expected);
});

test("create-worktree register+pin dry-run text matches the frozen fixture", () => {
  const setup = setupFixtureRoot("relay-create-worktree-register-text-");
  const preloadPath = writePreload(setup.root, {
    relayHome: setup.relayHome,
    tmpDir: setup.tmpDir,
    codexHome: setup.codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
  });
  const stdout = runCreateWorktree([
    setup.repoRoot,
    "--branch", "feature-register",
    "--title", "Pinned Register",
    "--register",
    "--pin",
    "--dry-run",
  ], buildEnv(setup.root, preloadPath));
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-register-pin-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(normalizeOutput(stdout, setup.root, CANONICAL_ROOT), expected);
});

test("create-worktree external registration json matches the frozen fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-create-worktree-external-"));
  const repoRoot = path.join(root, "repo");
  const worktreePath = path.join(root, "worktree");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Create Worktree Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "create-worktree@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "ext-branch"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "", "utf-8");

  const preloadPath = writePreload(root, {
    relayHome: path.join(root, "relay-home"),
    tmpDir: path.join(root, "tmp"),
    codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
    extraSource: `
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./codex-app-register" || request.endsWith("/codex-app-register")) {
    return {
      registerCodexApp() {
        return { threadId: "thread-fixed" };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
`,
  });

  const stdout = runCreateWorktree([
    repoRoot,
    "--worktree-path", worktreePath,
    "--branch", "ext-branch",
    "--title", "External Title",
    "--json",
  ], buildEnv(root, preloadPath));

  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-external-register.json"), "utf-8").trimEnd();
  assert.equal(normalizeOutput(stdout, root, CANONICAL_EXTERNAL_ROOT), expected);
});

test("create-worktree cleans up a created worktree when registration fails after create", () => {
  const setup = setupFixtureRoot("relay-create-worktree-cleanup-");
  const preloadPath = writePreload(setup.root, {
    relayHome: setup.relayHome,
    tmpDir: setup.tmpDir,
    codexHome: setup.codexHome,
    randomHexes: ["11111111"],
    fixedNow: "2026-04-18T00:50:00.000Z",
    extraSource: `
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./codex-app-register" || request.endsWith("/codex-app-register")) {
    return {
      registerCodexApp() {
        throw new Error("simulated register failure");
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
`,
  });

  const env = buildEnv(setup.root, preloadPath);
  const result = spawnSync("node", [
    SCRIPT,
    setup.repoRoot,
    "--branch", "feature-register",
    "--title", "Pinned Register",
    "--register",
  ], {
    cwd: path.dirname(SCRIPT),
    encoding: "utf-8",
    stdio: "pipe",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated register failure/);
  assert.equal(fs.existsSync(path.join(setup.relayHome, "worktrees", "11111111", "repo")), false);
});
