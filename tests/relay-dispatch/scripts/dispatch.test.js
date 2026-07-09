// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  captureAttempt,
  createRunId,
  getEventsPath,
  getManifestPath,
  getRubricAnchorStatus,
  getRunDir,
  listManifestPaths,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { buildPrBody, pushAndOpenPR, resolveBranchRemote } = require("../../../skills/relay-dispatch/scripts/dispatch-publish");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-dispatch/scripts/execution-evidence");
const { parseModelHints } = require("../../../skills/relay-dispatch/scripts/model-hints");
const {
  extractRubricSize,
  resolveReasoningEffort,
  RUBRIC_SIZE_MISSING,
  RUBRIC_SIZE_UNPARSEABLE,
} = require("../../../skills/relay-dispatch/scripts/rubric-size");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { appendRunEvent, EVENTS, readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { evaluateReviewGate } = require("../../../skills/relay-merge/scripts/review-gate");
const { createEnforcementFixture } = require("./test-support");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "dispatch.js");
const WORKTREE_RUNTIME_FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "worktree-runtime");
const CANONICAL_DRY_RUN_ROOT = "/tmp/issue187-fixtures";
const CANONICAL_DRY_RUN_SLUG = "repo-c079affd";
const SELF_REAPING_FIXTURE_MAX_MS = 120_000;

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

function revParse(repoRoot, ref) {
  return execFileSync("git", ["rev-parse", ref], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function mergeBase(repoRoot, left, right) {
  return execFileSync("git", ["merge-base", left, right], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function isAncestor(repoRoot, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function commitFile(repoRoot, fileName, content, message) {
  fs.writeFileSync(path.join(repoRoot, fileName), content, "utf-8");
  execFileSync("git", ["add", fileName], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return revParse(repoRoot, "HEAD");
}

function configureOriginHead(repoRoot, remoteRoot, branch) {
  if (branch !== "main") {
    execFileSync("git", ["checkout", "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["push", "-u", "origin", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  }
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
    cwd: remoteRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "set-head", "origin", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function detachHead(repoRoot) {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  execFileSync("git", ["checkout", "--detach", headSha], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function setupDetachedHeadRepo({ originHeadBranch } = {}) {
  const fixture = setupRepo();
  if (originHeadBranch) {
    configureOriginHead(fixture.repoRoot, fixture.remoteRoot, originHeadBranch);
  } else {
    try {
      execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/HEAD"], {
        cwd: fixture.repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {}
  }
  detachHead(fixture.repoRoot);
  return fixture;
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

function writeDelayedCompletionCodex(binDir, markerPath) {
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
const delayMs = Number(process.env.RELAY_TEST_DETACH_EXECUTOR_DELAY_MS || 2500);
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ pid: process.pid, ppid: process.ppid }), "utf-8");
  fs.writeFileSync(cwd + "/detached.txt", "detached completed\\n", "utf-8");
  execFileSync("git", ["-C", cwd, "add", "detached.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", cwd, "commit", "-m", "fake detached completion"], { stdio: "pipe" });
  fs.writeFileSync(output, "detached ok\\n", "utf-8");
  process.exit(0);
}, delayMs);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeArgCaptureCodex(binDir, capturePath) {
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
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const fileName = "captured.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeArgCaptureClaude(binDir, capturePath) {
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
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = process.cwd();
const fileName = "captured-claude.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("ok\\n");
`, "utf-8");
  fs.chmodSync(claudePath, 0o755);
  return claudePath;
}

function writeArgCaptureOpencode(binDir, capturePath) {
  ensureDefaultFakeGh(binDir);
  const oc = path.join(binDir, "opencode");
  fs.writeFileSync(oc, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("opencode-fake\\n"); process.exit(0); }
if (args[0] !== "run") { process.stderr.write("unsupported fake opencode invocation"); process.exit(1); }
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = process.cwd();
const fileName = "captured-opencode.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("ok\\n");
`, "utf-8");
  fs.chmodSync(oc, 0o755);
  return oc;
}

function writeArgCapturePi(binDir, capturePath) {
  ensureDefaultFakeGh(binDir);
  const piPath = path.join(binDir, "pi");
  fs.writeFileSync(piPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("pi 0.72.1\\n"); process.exit(0); }
if (!args.includes("--print")) { process.stderr.write("unsupported fake pi invocation"); process.exit(1); }
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = process.cwd();
const fileName = "captured-pi.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("pi completed\\n");
`, "utf-8");
  fs.chmodSync(piPath, 0o755);
  return piPath;
}

function writeArgCaptureAntigravity(binDir, capturePath) {
  ensureDefaultFakeGh(binDir);
  const agyPath = path.join(binDir, "agy");
  fs.writeFileSync(agyPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("agy 1.0.2\\n"); process.exit(0); }
if (args[0] !== "--prompt") { process.stderr.write("unsupported fake agy invocation"); process.exit(1); }
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = process.cwd();
const fileName = "captured-antigravity.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("antigravity completed\\n");
`, "utf-8");
  fs.chmodSync(agyPath, 0o755);
  return agyPath;
}

function writeArgCaptureCline(binDir, capturePath) {
  ensureDefaultFakeGh(binDir);
  const clinePath = path.join(binDir, "cline");
  fs.writeFileSync(clinePath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("3.0.36-test\\n"); process.exit(0); }
if (args[0] === "--help") { process.stdout.write("Usage: cline --json --cwd --provider -P --model -m --timeout --worktree\\n"); process.exit(0); }
if (!args.includes("--json")) { process.stderr.write("unsupported fake cline invocation"); process.exit(1); }
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
const cwd = args[args.indexOf("--cwd") + 1];
const fileName = "captured-cline.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write(JSON.stringify({ type: "agent_event", event: { type: "content_start", text: "ignored" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "run_result", text: "cline completed" }) + "\\n");
`, "utf-8");
  fs.chmodSync(clinePath, 0o755);
  return clinePath;
}

function writeMalformedResultCline(binDir) {
  ensureDefaultFakeGh(binDir);
  const clinePath = path.join(binDir, "cline");
  fs.writeFileSync(clinePath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("3.0.36-test\\n"); process.exit(0); }
if (args[0] === "--help") { process.stdout.write("Usage: cline --json --cwd --provider -P --model -m --timeout\\n"); process.exit(0); }
if (!args.includes("--json")) { process.stderr.write("unsupported fake cline invocation"); process.exit(1); }
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(cwd + "/cline-work.txt", "work before malformed result\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "cline-work.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake cline malformed result"], { stdio: "pipe" });
process.stdout.write("{not-json\\n");
`, "utf-8");
  fs.chmodSync(clinePath, 0o755);
  return clinePath;
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
fs.writeFileSync(output, "already applied\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeSilentCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeNetworkFailCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
process.stderr.write("curl: (6) Could not resolve host: api.github.com\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeCommittedNoResultCodex(binDir) {
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
const fileName = "commit-no-result.txt";
fs.writeFileSync(cwd + "/" + fileName, "commit without result\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "commit without result"], { stdio: "pipe" });
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeUncommittedCodex(binDir) {
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
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.appendFileSync(cwd + "/README.md", "dirty\\n", "utf-8");
fs.writeFileSync(output, "work completed without commit\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeUncommittedClaude(binDir) {
  ensureDefaultFakeGh(binDir);
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("claude-fake\\n");
  process.exit(0);
}
if (args[0] !== "-p") {
  process.stderr.write("unsupported fake claude invocation");
  process.exit(1);
}
const cwd = process.cwd();
fs.appendFileSync(cwd + "/README.md", "dirty\\n", "utf-8");
process.stdout.write("work completed without commit\\n");
`, "utf-8");
  fs.chmodSync(claudePath, 0o755);
  return claudePath;
}

function writeUncommittedAntigravity(binDir) {
  ensureDefaultFakeGh(binDir);
  const agyPath = path.join(binDir, "agy");
  fs.writeFileSync(agyPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("agy 1.0.2\\n");
  process.exit(0);
}
if (args[0] !== "--prompt") {
  process.stderr.write("unsupported fake agy invocation");
  process.exit(1);
}
const cwd = process.cwd();
fs.appendFileSync(cwd + "/README.md", "dirty from antigravity\\n", "utf-8");
process.stdout.write("antigravity completed without commit\\n");
`, "utf-8");
  fs.chmodSync(agyPath, 0o755);
  return agyPath;
}

function writeRuntimeOnlyAntigravity(binDir) {
  ensureDefaultFakeGh(binDir);
  const agyPath = path.join(binDir, "agy");
  fs.writeFileSync(agyPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("agy 1.0.2\\n");
  process.exit(0);
}
if (args[0] !== "--prompt") {
  process.stderr.write("unsupported fake agy invocation");
  process.exit(1);
}
const cwd = process.cwd();
const runtimeDir = path.join(cwd, ".antigravitycli");
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(path.join(runtimeDir, "session.json"), "{}\\n", "utf-8");
process.stdout.write("antigravity completed with runtime metadata only\\n");
`, "utf-8");
  fs.chmodSync(agyPath, 0o755);
  return agyPath;
}

function writePartialNoResultCodex(binDir) {
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
const cwd = args[args.indexOf("-C") + 1];
fs.appendFileSync(cwd + "/README.md", "partial without result\\n", "utf-8");
setTimeout(() => {}, 60000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeTimedOutUncommittedCodex(binDir) {
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
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.appendFileSync(cwd + "/README.md", "timed out uncommitted work\\n", "utf-8");
fs.writeFileSync(output, "partial result before timeout\\n", "utf-8");
setTimeout(() => {}, 60000);
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

function createExecFileMock({
  existingPrNumber = null,
  prCreateUrl = null,
  gitPushError = null,
  prCreateError = null,
  gitLogOutput = "fake: dispatch publish",
  branchRemote = "origin",
  branchRemoteError = false,
} = {}) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args: [...args], options });

    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return existingPrNumber === null ? "" : `${existingPrNumber}\n`;
    }
    if (command === "git" && args.includes("config")) {
      if (branchRemoteError) {
        const error = new Error("git config lookup failed");
        error.stderr = Buffer.from("branch has no configured remote\n");
        throw error;
      }
      return branchRemote ? `${branchRemote}\n` : "";
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

function createPushPrTestEnv({ relayHome, ghState = {}, failGitPush = false, codexMode = "commit", executor = "codex" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-push-pr-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-push-pr-bin-"));
  if (executor === "antigravity" && codexMode === "runtime-only") {
    writeRuntimeOnlyAntigravity(binDir);
  } else if (executor === "antigravity" && codexMode === "uncommitted") {
    writeUncommittedAntigravity(binDir);
  } else if (executor === "claude" && codexMode === "uncommitted") {
    writeUncommittedClaude(binDir);
  } else if (executor === "claude") {
    writeFakeClaude(binDir);
  } else if (codexMode === "noop") {
    writeNoOpCodex(binDir);
  } else if (codexMode === "silent") {
    writeSilentCodex(binDir);
  } else if (codexMode === "commit-no-result") {
    writeCommittedNoResultCodex(binDir);
  } else if (codexMode === "uncommitted") {
    writeUncommittedCodex(binDir);
  } else if (codexMode === "partial-no-result") {
    writePartialNoResultCodex(binDir);
  } else if (codexMode === "timeout-uncommitted-result") {
    writeTimedOutUncommittedCodex(binDir);
  } else {
    writeFakeCodex(binDir);
  }
  writeFakeGh(binDir);

  const ghStatePath = path.join(root, "gh-state.json");
  const ghLogPath = path.join(root, "gh-log.jsonl");
  const execLogPath = path.join(root, "exec-log.jsonl");
  const pushPrCountPath = path.join(root, "push-pr-count.txt");
  fs.writeFileSync(ghStatePath, JSON.stringify(ghState), "utf-8");
  fs.writeFileSync(pushPrCountPath, "0", "utf-8");

  const preloadPath = writePreloadScript(root, "dispatch-push-pr-preload.js", `
const fs = require("fs");
const Module = require("module");
const childProcess = require("child_process");
const originalLoad = Module._load;
const originalExecFileSync = childProcess.execFileSync;
Module._load = function patchedLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === "./dispatch-publish" || request.endsWith("/dispatch-publish")) {
    return {
      ...loaded,
      async pushAndOpenPR(...args) {
        const countPath = process.env.RELAY_TEST_PUSH_PR_COUNT;
        if (countPath) {
          const current = fs.existsSync(countPath)
            ? Number(fs.readFileSync(countPath, "utf-8")) || 0
            : 0;
          fs.writeFileSync(countPath, String(current + 1), "utf-8");
        }
        return loaded.pushAndOpenPR(...args);
      },
    };
  }
  return loaded;
};
childProcess.execFileSync = function patchedExecFileSync(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const logPath = process.env.RELAY_TEST_EXEC_LOG;
  const ghLogPath = process.env.RELAY_TEST_GH_LOG;
  const statePath = process.env.RELAY_TEST_GH_STATE;
  const isPush = command === "git" && argv.includes("push");
  const isGh = command === "gh";
  const isRecoverCommit = command === process.execPath && String(argv[0] || "").endsWith("recover-commit.js");
  if (process.env.RELAY_TEST_FAIL_RECOVER_COMMIT === "1" && isRecoverCommit) {
    const error = new Error("simulated recover-commit failure");
    error.stderr = Buffer.from("simulated recover-commit failure\\n");
    throw error;
  }
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
    RELAY_TEST_PUSH_PR_COUNT: pushPrCountPath,
    ...(failGitPush ? { RELAY_TEST_FAIL_GIT_PUSH: "1" } : {}),
  }, preloadPath);

  return { env, ghLogPath, execLogPath, ghStatePath, pushPrCountPath };
}

function createGitOnlyPath() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-git-only-bin-"));
  const gitShim = path.join(binDir, "git");
  const gitPath = fs.existsSync("/usr/bin/git")
    ? "/usr/bin/git"
    : execFileSync("which", ["git"], { encoding: "utf-8", stdio: "pipe" }).trim();
  fs.writeFileSync(gitShim, `#!/bin/sh\nexec ${JSON.stringify(gitPath)} \"$@\"\n`, "utf-8");
  fs.chmodSync(gitShim, 0o755);
  const nodeShim = path.join(binDir, "node");
  fs.writeFileSync(nodeShim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`, "utf-8");
  fs.chmodSync(nodeShim, 0o755);
  const bashShim = path.join(binDir, "bash");
  const bashPath = execFileSync("which", ["bash"], { encoding: "utf-8", stdio: "pipe" }).trim();
  fs.writeFileSync(bashShim, `#!/bin/sh\nexec ${JSON.stringify(bashPath)} \"$@\"\n`, "utf-8");
  fs.chmodSync(bashShim, 0o755);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 5000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ""}`);
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

function killPgid(pgid, signal = "SIGTERM") {
  if (!pgid) return;
  try {
    process.kill(-Number(pgid), signal);
  } catch {}
}

async function waitForPgidDead(pgid, options = {}) {
  await waitFor(() => !isPgidAlive(pgid), {
    timeoutMs: options.timeoutMs || 5000,
    message: options.message || `process group ${pgid} to exit`,
  });
}

function selfReapingFixturePrelude() {
  return `
const relayFixtureMaxMs = Number(process.env.RELAY_TEST_FIXTURE_MAX_MS || "${SELF_REAPING_FIXTURE_MAX_MS}");
const relayFixtureReaper = setTimeout(() => process.exit(124), relayFixtureMaxMs);
relayFixtureReaper.unref();
`;
}

function registerSignalFixtureCleanup(t, fixture) {
  if (!t || typeof t.after !== "function") return;
  t.after(async () => {
    const pgid = fixture.pgid ? fixture.pgid() : null;
    if (pgid && isPgidAlive(pgid)) {
      killPgid(pgid, "SIGKILL");
      try {
        await waitForPgidDead(pgid, { timeoutMs: 5000 });
      } catch {}
    }
    for (const cleanupPath of fixture.paths ? fixture.paths() : []) {
      try {
        fs.rmSync(cleanupPath, { recursive: true, force: true });
      } catch {}
    }
  });
}

function writeSleepingCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
${selfReapingFixturePrelude()}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const marker = process.env.RELAY_TEST_EXECUTOR_MARKER;
if (marker) {
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, pgid: process.pid }), "utf-8");
}
process.on("SIGTERM", () => {
  if (marker) {
    fs.writeFileSync(marker + ".terminated", JSON.stringify({ pid: process.pid, signal: "SIGTERM" }), "utf-8");
  }
  process.exit(143);
});
setInterval(() => {}, 1000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeLeaseCheckingCodex(binDir, markerPath) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
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
const leasePath = path.join(path.dirname(output), "lease.json");
if (!fs.existsSync(leasePath)) {
  process.stderr.write("lease missing while executor runs: " + leasePath + "\\n");
  process.exit(2);
}
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  output,
  leasePath,
  lease: JSON.parse(fs.readFileSync(leasePath, "utf-8")),
}), "utf-8");
fs.writeFileSync(path.join(cwd, "lease-checked.txt"), "lease was present\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "lease-checked.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake lease checked"], { stdio: "pipe" });
fs.writeFileSync(output, "lease ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeLeaseFreshnessCheckingCodex(binDir, markerPath) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
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
const leasePath = path.join(path.dirname(output), "lease.json");
const lease = JSON.parse(fs.readFileSync(leasePath, "utf-8"));
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  executorPid: process.pid,
  leasePath,
  lease,
}), "utf-8");
fs.writeFileSync(path.join(cwd, "lease-fresh.txt"), "fresh lease checked\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "lease-fresh.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake fresh lease checked"], { stdio: "pipe" });
fs.writeFileSync(output, "lease fresh\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeLeaderExitDescendantCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
${selfReapingFixturePrelude()}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const marker = process.env.RELAY_TEST_EXECUTOR_MARKER;
const childReady = marker ? marker + ".child-ready" : "";
const childAlive = marker ? marker + ".child-alive" : "";
const child = spawn("/bin/sh", ["-c", "trap '' TERM INT HUP; [ -n \\"$1\\" ] && : > \\"$1\\"; deadline=$(($(date +%s)+$3)); while [ \\"$(date +%s)\\" -lt \\"$deadline\\" ]; do [ -n \\"$2\\" ] && : > \\"$2\\"; sleep 1; done", "relay-child", childReady, childAlive, String(Math.ceil(relayFixtureMaxMs / 1000))], {
  stdio: "ignore",
});
child.unref();
if (marker) {
  const publishMarker = () => {
    if (fs.existsSync(childReady)) {
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, pgid: process.pid, childPid: child.pid, childAlive }), "utf-8");
      return;
    }
    setTimeout(publishMarker, 25);
  };
  publishMarker();
}
process.on("SIGTERM", () => {
  if (marker) {
    fs.writeFileSync(marker + ".terminated", JSON.stringify({ pid: process.pid, childPid: child.pid, signal: "SIGTERM" }), "utf-8");
  }
  process.exit(143);
});
setInterval(() => {}, 1000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function writeLeaderExitBackgroundCodex(binDir) {
  ensureDefaultFakeGh(binDir);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
${selfReapingFixturePrelude()}
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
const leasePath = path.join(path.dirname(output), "lease.json");
const marker = process.env.RELAY_TEST_EXECUTOR_MARKER;
const childReady = marker ? marker + ".child-ready" : "";
const child = spawn("/bin/sh", ["-c", ": > \\"$1\\"; deadline=$(($(date +%s)+$2)); while [ \\"$(date +%s)\\" -lt \\"$deadline\\" ]; do sleep 1; done", "relay-child", childReady, String(Math.ceil(relayFixtureMaxMs / 1000))], {
  stdio: "ignore",
});
child.unref();
const finishWhenReady = () => {
  if (fs.existsSync(childReady)) {
    const lease = fs.existsSync(leasePath) ? JSON.parse(fs.readFileSync(leasePath, "utf-8")) : null;
    fs.writeFileSync(marker, JSON.stringify({
      pid: process.pid,
      pgid: process.pid,
      childPid: child.pid,
      output,
      leasePath,
      lease,
    }), "utf-8");
    fs.writeFileSync(output, "background child still running\\n", "utf-8");
    process.exit(0);
  }
  setTimeout(finishWhenReady, 25);
};
finishWhenReady();
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

async function waitForDispatchExit(proc) {
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf-8");
  proc.stderr.setEncoding("utf-8");
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => {
    proc.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

function readExecutionEvidence(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"));
}

test("dispatch --detach returns a launch receipt while detached supervisor completes the run", async () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-detach-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-detach-${Date.now()}.json`);
  writeDelayedCompletionCodex(binDir, markerPath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_DETACH_EXECUTOR_DELAY_MS: "8000",
  };

  const started = Date.now();
  const launched = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-802-detach",
    "--prompt", "detached launch task",
    "--detach",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    timeout: 7000,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
  assert.ok(elapsedMs < 7000, `detach parent should return before delayed executor finishes; elapsed=${elapsedMs}`);
  assert.equal(fs.existsSync(markerPath), false, "executor should not have completed before detach receipt returned");
  const receipt = JSON.parse(launched.stdout);
  assert.equal(receipt.status, "detached");
  assert.match(receipt.runId, /^issue-802-/);
  assert.equal(receipt.manifestPath, getManifestPath(repoRoot, receipt.runId));
  assert.equal(Number.isInteger(receipt.supervisorPid), true);
  assert.ok(receipt.supervisorPid > 0);
  assert.equal(receipt.stdoutLog, path.join(getRunDir(repoRoot, receipt.runId), "dispatch-stdout.log"));
  assert.equal(receipt.stderrLog, path.join(getRunDir(repoRoot, receipt.runId), "dispatch-stderr.log"));
  assert.equal(fs.existsSync(receipt.stdoutLog), true);
  assert.equal(fs.existsSync(receipt.stderrLog), true);
  assert.match(receipt.reconcileCommand, new RegExp(`node skills/relay-dispatch/scripts/reconcile-run\\.js --repo .* --run-id ${receipt.runId}`));
  assert.doesNotMatch(receipt.reconcileCommand, /--dry-run/);
  assert.doesNotThrow(() => process.kill(receipt.supervisorPid, 0));

  await waitFor(() => fs.existsSync(markerPath), {
    timeoutMs: 15000,
    intervalMs: 100,
    message: "detached executor completion marker",
  });
  await waitFor(() => {
    const manifest = readManifest(receipt.manifestPath).data;
    return manifest.state === STATES.REVIEW_PENDING && !fs.existsSync(path.join(getRunDir(repoRoot, receipt.runId), "lease.json"));
  }, {
    timeoutMs: 15000,
    intervalMs: 100,
    message: "detached dispatch completion",
  });

  const reconcile = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "reconcile-run.js"),
    "--repo", repoRoot,
    "--run-id", receipt.runId,
    "--dry-run",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env }));
  assert.equal(reconcile.rowName, "not_dispatched");
  assert.equal(reconcile.state, STATES.REVIEW_PENDING);
});

test("dispatch --detach returns a receipt during slow pre-executor setup while supervisor continues", async (t) => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-detach-slow-setup-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-detach-slow-setup-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => {
      if (!fs.existsSync(markerPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(markerPath, "utf-8")).pgid || null;
      } catch {
        return null;
      }
    },
    paths: () => [binDir, markerPath, `${markerPath}.terminated`],
  });
  writeSleepingCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_BEFORE_EXECUTOR_SPAWN_PAUSE_MS: "9000",
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };

  const launched = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-802-detach-slow-setup",
    "--prompt", "detached launch pauses before executor spawn",
    "--detach",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    timeout: 12000,
  });

  let receipt = null;
  try {
    assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
    assert.equal(launched.error, undefined);
    assert.equal(fs.existsSync(markerPath), false, "executor should not spawn before detach receipt returned");
    receipt = JSON.parse(launched.stdout);
    assert.equal(receipt.status, "detached");
    assert.match(receipt.runId, /^issue-802-/);
    assert.equal(receipt.manifestPath, getManifestPath(repoRoot, receipt.runId));
    assert.equal(receipt.runDir, getRunDir(repoRoot, receipt.runId));
    assert.equal(receipt.stdoutLog, path.join(getRunDir(repoRoot, receipt.runId), "dispatch-stdout.log"));
    assert.equal(receipt.stderrLog, path.join(getRunDir(repoRoot, receipt.runId), "dispatch-stderr.log"));
    assert.equal(fs.existsSync(receipt.stdoutLog), true);
    assert.equal(fs.existsSync(receipt.stderrLog), true);
    assert.match(receipt.reconcileCommand, new RegExp(`node skills/relay-dispatch/scripts/reconcile-run\\.js --repo .* --run-id ${receipt.runId}`));
    assert.equal(Number.isInteger(receipt.supervisorPid), true);
    assert.ok(receipt.supervisorPid > 0);
    assert.doesNotThrow(() => process.kill(receipt.supervisorPid, 0));
  } finally {
    if (receipt?.supervisorPid) {
      try {
        process.kill(receipt.supervisorPid, "SIGTERM");
      } catch {}
      await waitFor(() => {
        try {
          process.kill(receipt.supervisorPid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }, { timeoutMs: 5000, message: "detached supervisor to exit after slow setup test" });
    }
  }
});

test("dispatch --detach fails if the detached supervisor exits before writing its receipt", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const missingManifest = path.join(repoRoot, "missing-manifest.md");
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
  };

  const result = spawnSync(process.execPath, [
    SCRIPT,
    repoRoot,
    "--manifest", missingManifest,
    "--prompt", "resume missing manifest",
    "--detach",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    timeout: 7000,
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed");
  assert.match(payload.error, /detached dispatch exited before receipt/);
  assert.match(result.stderr, /detached dispatch exited before receipt/);
});

test("dispatch --manifest --detach returns a launch receipt while detached resume completes the run", async () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-detach-resume-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-802-detach-resume",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const markerPath = path.join(os.tmpdir(), `relay-dispatch-detach-resume-${process.pid}-${Date.now()}.json`);
  writeDelayedCompletionCodex(binDir, markerPath);
  const resumeEnv = {
    ...env,
    RELAY_TEST_DETACH_EXECUTOR_DELAY_MS: "5000",
  };

  const started = Date.now();
  const launched = spawnSync(process.execPath, [
    SCRIPT,
    repoRoot,
    "--manifest", first.manifestPath,
    "--prompt", "detached resume task",
    "--detach",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: resumeEnv,
    timeout: 7000,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
  assert.ok(elapsedMs < 7000, `detach parent should return before delayed resume finishes; elapsed=${elapsedMs}`);
  assert.equal(fs.existsSync(markerPath), false, "resume executor should not have completed before detach receipt returned");
  const receipt = JSON.parse(launched.stdout);
  assert.equal(receipt.status, "detached");
  assert.equal(receipt.runId, first.runId);
  assert.equal(receipt.manifestPath, first.manifestPath);
  assert.equal(receipt.runDir, first.runDir);
  assert.equal(Number.isInteger(receipt.supervisorPid), true);
  assert.ok(receipt.supervisorPid > 0);
  assert.equal(receipt.stdoutLog, path.join(first.runDir, "dispatch-stdout.log"));
  assert.equal(receipt.stderrLog, path.join(first.runDir, "dispatch-stderr.log"));
  assert.equal(fs.existsSync(receipt.stdoutLog), true);
  assert.equal(fs.existsSync(receipt.stderrLog), true);
  assert.match(receipt.reconcileCommand, new RegExp(`node skills/relay-dispatch/scripts/reconcile-run\\.js --repo .* --run-id ${first.runId}`));
  assert.doesNotThrow(() => process.kill(receipt.supervisorPid, 0));

  await waitFor(() => fs.existsSync(markerPath), {
    timeoutMs: 12000,
    intervalMs: 100,
    message: "detached resume executor completion marker",
  });
  await waitFor(() => {
    const manifest = readManifest(first.manifestPath).data;
    return manifest.state === STATES.REVIEW_PENDING && !fs.existsSync(path.join(first.runDir, "lease.json"));
  }, {
    timeoutMs: 12000,
    intervalMs: 100,
    message: "detached resume dispatch completion",
  });
});

function guidancePrompt({ task = "guidance test task", reviewAssurance = null } = {}) {
  const reviewAssuranceLines = reviewAssurance ? [`  review_assurance: ${reviewAssurance}`] : [];
  return [
    "# Dispatch: Guidance persistence",
    "",
    task,
    "",
    "## Task Profile",
    "",
    "This is advisory planner metadata for executor working style. It is not a reviewer verdict field, manifest role binding, or merge gate.",
    "",
    "```yaml",
    "task_profile:",
    "  size: M",
    "  change_type: feature",
    "  domains:",
    "    - relay-dispatch",
    "    - tests",
    "  risk_tags:",
    "    - trust-boundary",
    "    - prompt-contract",
    "  execution_mode: fresh-context",
    ...reviewAssuranceLines,
    "  guidance_packs:",
    "    - surgical-change",
    "    - verification-evidence",
    "    - trust-boundary",
    "  derivation_inputs:",
    "    - github_issue_398",
    "    - issue_394_reference_doc",
    "```",
    "",
    "## Working Guidance",
    "",
    "These instructions guide execution style. They do not override Done Criteria, rubric commands, or scope boundaries.",
    "",
    "### surgical-change",
    "- Keep the diff narrow.",
    "",
    "### verification-evidence",
    "- Record changed artifacts and checks.",
    "",
    "### trust-boundary",
    "- Name the trust root and protected decision.",
  ].join("\n");
}

function readyLightPrompt({ task = "ready-light dispatch validation" } = {}) {
  return [
    "# Dispatch: Ready-light validation",
    "",
    task,
    "",
    "## Task Profile",
    "",
    "```yaml",
    "task_profile:",
    "  planning_profile: ready_light",
    "  size: S",
    "  change_type: feature",
    "  domains:",
    "    - relay-plan",
    "  risk_tags: []",
    "  execution_mode: quick",
    "  review_assurance: standard",
    "  guidance_packs:",
    "    - surgical-change",
    "    - verification-evidence",
    "```",
  ].join("\n");
}

function invalidReviewAssuranceTaskProfilePrompt() {
  return [
    "# Dispatch: Invalid task profile metadata",
    "",
    "## Task Profile",
    "",
    "```yaml",
    "task_profile:",
    "  planning_profile: ready_light",
    "  size: S",
    "  change_type: feature",
    "  domains:",
    "    - relay-plan",
    "  risk_tags: []",
    "  execution_mode: quick",
    "  review_assurance: hardend",
    "  guidance_packs:",
    "    - surgical-change",
    "```",
  ].join("\n");
}

function plannerReadyLightPromptWithoutExplicitMarker() {
  return [
    "# Dispatch: Planner ready-light validation",
    "",
    "Planner-rendered prompt from an existing ready-light route.",
    "",
    "## Task Profile",
    "",
    "```yaml",
    "task_profile:",
    "  size: S",
    "  change_type: feature",
    "  domains:",
    "    - relay-plan",
    "  risk_tags: []",
    "  execution_mode: quick",
    "  review_assurance: standard",
    "  guidance_packs:",
    "    - surgical-change",
    "    - verification-evidence",
    "```",
  ].join("\n");
}

function standardPromptWithReadyLightExample() {
  return [
    "# Dispatch: Standard docs task",
    "",
    "Update docs that include this example metadata:",
    "",
    "```yaml",
    "planning_profile: ready_light",
    "route_decision: ready_light",
    "```",
    "",
    "This example is content, not the active task profile.",
  ].join("\n");
}

function standardPromptWithTaskProfileExampleBeforeActiveProfile() {
  return [
    "# Dispatch: Standard docs task",
    "",
    "Update docs that include this example metadata:",
    "",
    "```yaml",
    "task_profile:",
    "  planning_profile: ready_light",
    "  size: S",
    "  guidance_packs:",
    "    - surgical-change",
    "```",
    "",
    "The example above is content, not the active task profile.",
    "",
    "## Task Profile",
    "",
    "```yaml",
    "task_profile:",
    "  planning_profile: standard",
    "  size: M",
    "  change_type: docs",
    "  domains:",
    "    - docs",
    "  risk_tags: []",
    "  execution_mode: standard",
    "  review_assurance: standard",
    "  guidance_packs:",
    "    - docs-reader-success",
    "```",
  ].join("\n");
}

function readyLightRubricYaml() {
  return [
    "rubric:",
    "  factors:",
    "    - name: Task-specific check passes",
    "      tier: contract",
    "      type: automated",
    "      command: \"node --test tests/task-specific.test.js\"",
    "      target: \"exit 0\"",
  ].join("\n");
}

function threeFactorRubricYaml() {
  return [
    "rubric:",
    "  factors:",
    "    - name: Parser path passes",
    "      tier: contract",
    "      type: automated",
    "      command: \"node --test tests/parser.test.js\"",
    "      target: \"exit 0\"",
    "    - name: CLI path passes",
    "      tier: contract",
    "      type: automated",
    "      command: \"node --test tests/cli.test.js\"",
    "      target: \"exit 0\"",
    "    - name: Error copy remains actionable",
    "      tier: quality",
    "      type: evaluated",
    "      target: \">= 8/10\"",
  ].join("\n");
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

  return { root, repoRoot, relayHome, rubricFile, env };
}

function normalizeDispatchDryRunOutput(output, { root }) {
  const normalizedRoot = output.split(root).join(CANONICAL_DRY_RUN_ROOT);
  return normalizedRoot
    .replace(/\/runs\/[^/]+\//g, `/runs/${CANONICAL_DRY_RUN_SLUG}/`)
    .replace(/\/projects\/[^/]+\//g, `/projects/${CANONICAL_DRY_RUN_SLUG}/`)
    .trimEnd();
}

function buildDispatchExecPrompt(taskPrompt) {
  return "[NON-INTERACTIVE DISPATCH] This is an automated, non-interactive execution. "
    + "Do not present plans for approval or wait for user confirmation. "
    + "Execute the task fully and autonomously.\n\n"
    + taskPrompt;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertOpencodeDispatchCommand(capturedArgs, { model, taskPrompt }) {
  assert.deepEqual(capturedArgs.slice(0, 2), ["run", "--dir"]);
  assert.ok(path.isAbsolute(capturedArgs[2]), `expected absolute worktree path, got ${capturedArgs[2]}`);
  assert.deepEqual(capturedArgs.slice(3, 5), ["-m", model]);
  assert.equal(capturedArgs.length, 6);
  assert.match(capturedArgs[5], /^\[RELAY WORKTREE BOUNDARY\]\n/);
  assert.match(capturedArgs[5], new RegExp(`Repository worktree: ${escapeRegExp(capturedArgs[2])}`));
  assert.match(capturedArgs[5], /Run every shell command from that repository worktree\./);
  assert.match(capturedArgs[5], /Do not read, write, git add, git commit, or create files outside that repository worktree\./);
  assert.ok(capturedArgs[5].endsWith(buildDispatchExecPrompt(taskPrompt)));
}

function worktreeCommonGitDir(worktree) {
  const raw = execFileSync("git", ["-C", worktree, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  return path.resolve(worktree, raw);
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

test("dispatch resume clears stale structured result before executor attempt", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-812-stale-result-resume",
    "--prompt", "first pass writes a result",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);
  assert.equal(fs.readFileSync(first.resultFile, "utf-8"), "ok\n");

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);
  writeSilentCodex(binDir);

  const resume = spawnSync(process.execPath, [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume attempt exits without writing result",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
    stdio: "pipe",
  });

  assert.notEqual(resume.status, 0);
  const result = JSON.parse(resume.stdout);
  assert.equal(result.mode, "resume");
  assert.equal(result.runId, first.runId);
  assert.equal(result.resultFile, first.resultFile);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /silent failure/);
  assert.equal(result.resultPreview, "");
  assert.equal(fs.existsSync(first.resultFile), false);
  assert.equal(readManifest(first.manifestPath).data.state, STATES.ESCALATED);
});

test("dispatch resume clears stale structured result before entering dispatched pre-spawn window", async () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-812-stale-result-pre-spawn",
    "--prompt", "first pass writes a result",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);
  assert.equal(fs.readFileSync(first.resultFile, "utf-8"), "ok\n");

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);
  writeSleepingCodex(binDir);
  const resumeEnv = {
    ...env,
    RELAY_TEST_BEFORE_EXECUTOR_SPAWN_PAUSE_MS: "30000",
  };

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "--run-id", first.runId,
    "--prompt", "resume attempt pauses before spawn",
    "--json",
  ])], {
    cwd: repoRoot,
    env: resumeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    await waitFor(() => {
      const events = readRunEvents(repoRoot, first.runId);
      return events.some((event) => event.event === "dispatch_start" && event.reason === "same_run_resume");
    }, { timeoutMs: 30000, message: "resume dispatch_start before executor spawn" });

    assert.equal(fs.existsSync(first.resultFile), false);
  } finally {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
    await exitPromise;
  }
});

async function runInterruptedDispatchSignalTest(t, signalName) {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-sleep-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-sleep-${process.pid}-${Date.now()}-${signalName}.json`);
  const cleanup = {
    pgid: () => interruptedEvent?.executor_pgid || marker?.pgid || null,
    paths: () => [binDir, markerPath, `${markerPath}.terminated`],
  };
  registerSignalFixtureCleanup(t, cleanup);
  writeSleepingCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let marker = null;
  let interruptedEvent = null;

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", `issue-800-${signalName.toLowerCase()}`,
    "--prompt", "sleep until interrupted",
    "--json",
  ])], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    try {
      const markerPromise = waitFor(() => {
        if (!fs.existsSync(markerPath)) return null;
        return JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      }, { timeoutMs: 30000, message: "fake executor marker" });
      const markerOrExit = await Promise.race([
        markerPromise.then((value) => ({ marker: value })),
        exitPromise.then((value) => ({ earlyExit: value })),
      ]);
      if (markerOrExit.earlyExit) {
        assert.fail(`dispatch exited before fake executor marker\nstdout:\n${markerOrExit.earlyExit.stdout}\nstderr:\n${markerOrExit.earlyExit.stderr}`);
      }
      marker = markerOrExit.marker;
    } catch (error) {
      const manifestPath = listManifestPaths(repoRoot)[0];
      const manifest = manifestPath && fs.existsSync(manifestPath) ? readManifest(manifestPath).data : null;
      const stdoutLog = manifest?.paths?.dispatch_stdout;
      const stderrLog = manifest?.paths?.dispatch_stderr;
      const executorStdout = stdoutLog && fs.existsSync(stdoutLog) ? fs.readFileSync(stdoutLog, "utf-8") : "";
      const executorStderr = stderrLog && fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, "utf-8") : "";
      assert.fail(`${error.message}\nexecutor stdout:\n${executorStdout}\nexecutor stderr:\n${executorStderr}`);
    }
    const manifestPath = await waitFor(() => listManifestPaths(repoRoot)[0], {
      timeoutMs: 30000,
      message: "dispatch manifest path",
    });

    proc.kill(signalName);
    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, new RegExp(`Dispatch interrupted by ${signalName}`));
    assert.match(result.stderr, /Resume with: node skills\/relay-dispatch\/scripts\/dispatch\.js --manifest /);
    if (signalName === "SIGTERM") {
      assert.match(result.stderr, /executor may still be running/);
    }

    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, STATES.DISPATCHED);
    assert.ok(fs.existsSync(manifest.paths.worktree), "signal handling must preserve the retained worktree");

    const events = readRunEvents(repoRoot, manifest.run_id);
    interruptedEvent = events.at(-1);
    assert.equal(interruptedEvent.event, "dispatch_interrupted");
    assert.equal(interruptedEvent.signal, signalName);
    assert.equal(interruptedEvent.executor_pid, marker.pid);
    assert.equal(interruptedEvent.executor_pgid, marker.pgid);
    assert.equal(interruptedEvent.timeout_s, 2400);
    assert.equal(typeof interruptedEvent.elapsed_s, "number");
    assert.ok(interruptedEvent.elapsed_s >= 0);
    assert.equal(interruptedEvent.worktree, manifest.paths.worktree);
    assert.equal(interruptedEvent.state_from, STATES.DISPATCHED);
    assert.equal(interruptedEvent.state_to, STATES.DISPATCHED);

    if (signalName === "SIGTERM") {
      assert.equal(interruptedEvent.executor_terminated, false);
      assert.equal(isPgidAlive(marker.pgid), true, "SIGTERM must not kill the detached executor process group");
    } else {
      assert.equal(interruptedEvent.executor_terminated, true);
      await waitForPgidDead(marker.pgid);
    }
  } finally {
    const pgid = interruptedEvent?.executor_pgid || marker?.pgid;
    if (signalName === "SIGTERM" && pgid) {
      killPgid(pgid);
      await waitForPgidDead(pgid);
    }
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
}

test("dispatch SIGTERM preserves executor and worktree while journaling dispatch_interrupted", async (t) => {
  await runInterruptedDispatchSignalTest(t, "SIGTERM");
});

test("dispatch SIGINT terminates executor group and preserves worktree while journaling dispatch_interrupted", async (t) => {
  await runInterruptedDispatchSignalTest(t, "SIGINT");
});

test("dispatch SIGINT does not treat leader exit as process-group termination while a descendant remains", async (t) => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-leader-exit-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-leader-exit-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => marker?.pgid || null,
    paths: () => [binDir, markerPath, `${markerPath}.terminated`, `${markerPath}.child-ready`, `${markerPath}.child-alive`],
  });
  writeLeaderExitDescendantCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let marker = null;

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-800-sigint-descendant",
    "--prompt", "leader exits but descendant ignores sigterm",
    "--json",
  ])], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    marker = await waitFor(() => {
      if (!fs.existsSync(markerPath)) return null;
      return JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    }, { timeoutMs: 30000, message: "fake executor marker" });
    await waitFor(() => marker.childAlive && fs.existsSync(marker.childAlive), {
      timeoutMs: 30000,
      message: "fake executor descendant liveness marker",
    });
    const manifestPath = await waitFor(() => listManifestPaths(repoRoot)[0], {
      timeoutMs: 30000,
      message: "dispatch manifest path",
    });

    proc.kill("SIGINT");
    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Executor termination was requested, but the process group may still be running/);

    const manifest = readManifest(manifestPath).data;
    const interruptedEvent = readRunEvents(repoRoot, manifest.run_id).at(-1);
    assert.equal(interruptedEvent.event, "dispatch_interrupted");
    assert.equal(interruptedEvent.signal, "SIGINT");
    assert.equal(interruptedEvent.executor_pid, marker.pid);
    assert.equal(interruptedEvent.executor_pgid, marker.pgid);
    assert.equal(interruptedEvent.executor_terminated, false);
    assert.equal(isPgidAlive(marker.pgid), true, "descendant keeps the executor process group alive");
  } finally {
    if (marker?.pgid) {
      try {
        process.kill(-Number(marker.pgid), "SIGKILL");
      } catch {}
      await waitForPgidDead(marker.pgid);
    }
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
});

test("dispatch interruption immediately after worktree creation preserves delayed publication on resume", async (t) => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-after-worktree-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-after-worktree-${process.pid}-${Date.now()}.json`);
  const pauseMarkerPath = path.join(os.tmpdir(), `relay-dispatch-after-worktree-pause-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => null,
    paths: () => [binDir, markerPath, `${markerPath}.terminated`, pauseMarkerPath],
  });
  writeSleepingCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_AFTER_WORKTREE_CREATE_PAUSE_MS: "30000",
    RELAY_TEST_AFTER_WORKTREE_CREATE_MARKER: pauseMarkerPath,
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let manifestPath = null;

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-800-after-worktree-signal",
    "--prompt", "pause immediately after worktree create",
    "--publish-policy", "after-internal-review",
    "--json",
  ])], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    await waitFor(() => fs.existsSync(pauseMarkerPath), {
      timeoutMs: 30000,
      message: "after-worktree create pause marker",
    });
    const repoRootReal = fs.realpathSync(repoRoot);
    const worktreePath = await waitFor(() => {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      const paths = output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      return paths.find((candidate) => fs.realpathSync(candidate) !== repoRootReal) || null;
    }, { timeoutMs: 30000, message: "created dispatch worktree" });

    proc.kill("SIGTERM");
    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Dispatch interrupted by SIGTERM/);
    assert.match(result.stderr, /Resume with: node skills\/relay-dispatch\/scripts\/dispatch\.js --manifest /);
    assert.equal(fs.existsSync(markerPath), false, "executor must not spawn in the after-worktree pause");

    manifestPath = await waitFor(() => listManifestPaths(repoRoot)[0], {
      timeoutMs: 5000,
      message: "signal-written dispatch manifest path",
    });
    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, STATES.DRAFT);
    assert.equal(fs.realpathSync(manifest.paths.worktree), fs.realpathSync(worktreePath));
    assert.ok(fs.existsSync(manifest.paths.worktree), "after-worktree signal must preserve the retained worktree");
    assert.ok(manifest.anchor?.rubric_path, "signal-written manifest must retain the rubric anchor for resume");
    assert.equal(manifest.dispatch?.publish_policy, "after-internal-review");
    assert.equal(manifest.environment.node_version, null);
    assert.equal(manifest.environment.dispatch_ts, null);

    const interruptedEvent = readRunEvents(repoRoot, manifest.run_id).at(-1);
    assert.equal(interruptedEvent.event, "dispatch_interrupted");
    assert.equal(interruptedEvent.signal, "SIGTERM");
    assert.equal(interruptedEvent.executor_pid, null);
    assert.equal(interruptedEvent.executor_pgid, null);
    assert.equal(interruptedEvent.executor_terminated, false);
    assert.equal(interruptedEvent.worktree, manifest.paths.worktree);
    assert.equal(interruptedEvent.state_from, STATES.DRAFT);
    assert.equal(interruptedEvent.state_to, STATES.DRAFT);

    writeFakeCodex(binDir);
    const resume = JSON.parse(runDispatch(repoRoot, [
      "--manifest", manifestPath,
      "--prompt", "resume after early interruption",
      "--json",
    ], {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    }));
    assert.equal(resume.mode, "resume");
    assert.equal(resume.publishPolicy, "after-internal-review");
    assert.equal(resume.runId, manifest.run_id);
    assert.equal(resume.worktree, manifest.paths.worktree);
    assert.equal(resume.runState, STATES.INTERNAL_REVIEW_PENDING);

    const resumedManifest = readManifest(manifestPath).data;
    assert.equal(resumedManifest.dispatch.publish_policy, "after-internal-review");
    assert.equal(resumedManifest.state, STATES.INTERNAL_REVIEW_PENDING);
    assert.equal(resumedManifest.next_action, "run_internal_review");
    assert.equal(resumedManifest.git.pr_number, null);
    assert.equal(resumedManifest.environment.node_version, process.version);
    assert.equal(typeof resumedManifest.environment.dispatch_ts, "string");
    assert.match(resumedManifest.environment.main_sha, /^[0-9a-f]{40}$/);
    assert.equal(resumedManifest.environment.lockfile_hash, null);
    const resumeEvents = readRunEvents(repoRoot, manifest.run_id);
    assert.equal(resumeEvents.some((event) => event.event === "environment_drift"), false);
  } finally {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
});

test("dispatch handles interruption before executor spawn without removing the worktree", async (t) => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-pre-spawn-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-pre-spawn-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => null,
    paths: () => [binDir, markerPath, `${markerPath}.terminated`],
  });
  writeSleepingCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_BEFORE_EXECUTOR_SPAWN_PAUSE_MS: "30000",
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let manifestPath = null;

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-800-pre-spawn-signal",
    "--prompt", "pause before spawn",
    "--json",
  ])], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    manifestPath = await waitFor(() => {
      const candidate = listManifestPaths(repoRoot)[0];
      if (!candidate) return null;
      const manifest = readManifest(candidate).data;
      const events = readRunEvents(repoRoot, manifest.run_id);
      return events.some((event) => event.event === "dispatch_start") ? candidate : null;
    }, { timeoutMs: 30000, message: "dispatch_start before executor spawn" });

    proc.kill("SIGINT");
    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Dispatch interrupted by SIGINT/);

    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, STATES.DISPATCHED);
    assert.ok(fs.existsSync(manifest.paths.worktree), "pre-spawn signal must preserve the retained worktree");
    assert.equal(fs.existsSync(markerPath), false, "executor must not have spawned before the pre-spawn signal");

    const interruptedEvent = readRunEvents(repoRoot, manifest.run_id).at(-1);
    assert.equal(interruptedEvent.event, "dispatch_interrupted");
    assert.equal(interruptedEvent.signal, "SIGINT");
    assert.equal(interruptedEvent.executor_pid, null);
    assert.equal(interruptedEvent.executor_pgid, null);
    assert.equal(interruptedEvent.executor_terminated, false);
    assert.equal(interruptedEvent.worktree, manifest.paths.worktree);
    assert.equal(interruptedEvent.state_from, STATES.DISPATCHED);
    assert.equal(interruptedEvent.state_to, STATES.DISPATCHED);
  } finally {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
});

test("dispatch exits and preserves worktree when interruption journaling fails", async (t) => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-journal-fail-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-journal-fail-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => marker?.pgid || null,
    paths: () => [binDir, markerPath, `${markerPath}.terminated`],
  });
  writeSleepingCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let marker = null;
  let manifestPath = null;
  let manifest = null;

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-800-journal-failure",
    "--prompt", "sleep until journal failure interruption",
    "--json",
  ])], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);

  try {
    marker = await waitFor(() => {
      if (!fs.existsSync(markerPath)) return null;
      return JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    }, { timeoutMs: 30000, message: "fake executor marker" });
    manifestPath = await waitFor(() => listManifestPaths(repoRoot)[0], {
      timeoutMs: 30000,
      message: "dispatch manifest path",
    });
    manifest = readManifest(manifestPath).data;
    const eventsPath = getEventsPath(repoRoot, manifest.run_id);
    fs.rmSync(eventsPath, { force: true });
    fs.symlinkSync(path.join(os.tmpdir(), `relay-dispatch-events-target-${process.pid}-${Date.now()}`), eventsPath);

    proc.kill("SIGTERM");
    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Dispatch interrupted by SIGTERM/);

    const updatedManifest = readManifest(manifestPath).data;
    assert.equal(updatedManifest.state, STATES.DISPATCHED);
    assert.ok(fs.existsSync(updatedManifest.paths.worktree), "journal failure signal path must preserve the retained worktree");
    assert.equal(isPgidAlive(marker.pgid), true, "SIGTERM must still leave the executor process group alive when journaling fails");
  } finally {
    const pgid = marker?.pgid;
    if (pgid) {
      killPgid(pgid);
      await waitForPgidDead(pgid);
    }
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
});

function makeDispatchedResumeFixture(repoRoot, env, { appendInterruptedEvent, pgid = 987654, pid = pgid } = {}) {
  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", `issue-800-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "--prompt", "first pass",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  const dispatchedManifest = {
    ...record.data,
    state: STATES.DISPATCHED,
    next_action: "await_dispatch_result",
  };
  writeManifest(first.manifestPath, dispatchedManifest, record.body);
  if (appendInterruptedEvent) {
    appendRunEvent(repoRoot, first.runId, {
      event: EVENTS.DISPATCH_INTERRUPTED,
      state_from: STATES.DISPATCHED,
      state_to: STATES.DISPATCHED,
      reason: "signal",
      signal: "SIGTERM",
      executor_pid: pid,
      executor_pgid: pgid,
      elapsed_s: 1,
      timeout_s: 2400,
      executor_terminated: false,
      worktree: first.worktree,
    });
  }
  return first;
}

test("dispatch resumes from dispatched when latest event is dispatch_interrupted and recorded pgid is dead", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const first = makeDispatchedResumeFixture(repoRoot, env, { appendInterruptedEvent: true });

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume interrupted dispatch",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.runState, STATES.REVIEW_PENDING);
  const events = readRunEvents(repoRoot, first.runId);
  assert.equal(events.at(-2).event, "dispatch_start");
  assert.equal(events.at(-2).state_from, STATES.DISPATCHED);
  assert.equal(events.at(-2).state_to, STATES.DISPATCHED);
  assert.equal(events.at(-1).event, "dispatch_result");
});

test("dispatch refuses interrupted resume while recorded pgid is still alive", async () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  const blockerExit = new Promise((resolve) => blocker.on("close", resolve));
  blocker.unref();

  try {
    const first = makeDispatchedResumeFixture(repoRoot, env, {
      appendInterruptedEvent: true,
      pid: blocker.pid,
      pgid: blocker.pid,
    });

    const result = spawnSync(process.execPath, [SCRIPT, repoRoot,
      "--run-id", first.runId,
      "--prompt", "resume interrupted dispatch",
      "--json",
    ], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
      stdio: "pipe",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interrupted executor process group is still alive/);
    assert.match(result.stderr, new RegExp(`pid=${blocker.pid}`));
    assert.match(result.stderr, /Wait for it to finish, or kill that process group before resuming/);
    assert.equal(readManifest(first.manifestPath).data.state, STATES.DISPATCHED);
  } finally {
    killPgid(blocker.pid);
    await Promise.race([blockerExit, sleep(5000)]);
  }
});

test("dispatch refuses interrupted resume when pgid probe returns EPERM", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const epermPgid = 424242;
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_PROCESS_GROUP_ALIVE_EPERM: String(epermPgid),
  };
  const first = makeDispatchedResumeFixture(repoRoot, env, {
    appendInterruptedEvent: true,
    pid: epermPgid,
    pgid: epermPgid,
  });

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume interrupted dispatch",
    "--json",
  ], {
    cwd: repoRoot,
    env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interrupted executor process group is still alive/);
  assert.match(result.stderr, new RegExp(`pid=${epermPgid}`));
  assert.match(result.stderr, /Wait for it to finish, or kill that process group before resuming/);
  assert.equal(readManifest(first.manifestPath).data.state, STATES.DISPATCHED);
});

test("dispatch still refuses resume from non-interrupted dispatched state", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const first = makeDispatchedResumeFixture(repoRoot, env, { appendInterruptedEvent: false });

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", "resume non-interrupted dispatch",
    "--json",
  ], {
    cwd: repoRoot,
    env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same-run resume requires state='changes_requested', got 'dispatched'/);
  assert.equal(readManifest(first.manifestPath).data.state, STATES.DISPATCHED);
});

function writeResumeCaptureCodex(binDir, capturePath) {
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
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args), "utf-8");
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

test("dispatch resume auto-discovers latest review-round-N-redispatch.md when no prompt is given (#387)", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-redispatch-auto.json`);
  writeResumeCaptureCodex(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-387-auto",
    "--prompt", "first pass",
    "--json",
  ], env));

  const record = readManifest(first.manifestPath);
  writeManifest(
    first.manifestPath,
    updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    record.body
  );

  const runDir = getRunDir(repoRoot, first.runId);
  fs.writeFileSync(path.join(runDir, "review-round-1-redispatch.md"), "ROUND ONE BODY\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-redispatch.md"), "ROUND TWO BODY\n", "utf-8");

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--json",
  ], env));
  assert.equal(second.mode, "resume");

  const captured = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  const finalPrompt = captured[captured.length - 1];
  assert.match(finalPrompt, /ROUND TWO BODY/);
  assert.doesNotMatch(finalPrompt, /ROUND ONE BODY/);
});

test("dispatch resume --prompt-file wins over redispatch auto-discovery (#387)", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-redispatch-explicit.json`);
  writeResumeCaptureCodex(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-387-explicit",
    "--prompt", "first pass",
    "--json",
  ], env));

  const record = readManifest(first.manifestPath);
  writeManifest(
    first.manifestPath,
    updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    record.body
  );

  const runDir = getRunDir(repoRoot, first.runId);
  fs.writeFileSync(path.join(runDir, "review-round-1-redispatch.md"), "AUTO_DISCOVERED_BODY\n", "utf-8");

  const explicitPath = path.join(os.tmpdir(), `relay-dispatch-explicit-${Date.now()}.md`);
  fs.writeFileSync(explicitPath, "EXPLICIT_BODY\n", "utf-8");

  runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt-file", explicitPath,
    "--json",
  ], env);

  const captured = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  const finalPrompt = captured[captured.length - 1];
  assert.match(finalPrompt, /EXPLICIT_BODY/);
  assert.doesNotMatch(finalPrompt, /AUTO_DISCOVERED_BODY/);
});

test("dispatch resume without redispatch artifact still errors with auto-discovery hint (#387)", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-387-missing",
    "--prompt", "first pass",
    "--json",
  ], env));

  const record = readManifest(first.manifestPath);
  writeManifest(
    first.manifestPath,
    updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    record.body
  );

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", first.runId, "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--prompt or --prompt-file is required/);
  assert.match(result.stderr, /Auto-discovery looked for review-round-<N>-redispatch\.md/);
});

test("dispatch stores model_hints for configured phases verbatim", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-model-hints-new",
    "--prompt", "persist new-run model hints",
    "--model-hints", "plan=X,dispatch=Y,review=Z,merge=W",
    "--json",
  ], env));

  assert.deepEqual(readManifest(result.manifestPath).data.model_hints, {
    plan: "X",
    dispatch: "Y",
    review: "Z",
    merge: "W",
  });
});

test("dispatch resume replaces model_hints and records model_hints_updated before redispatch", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-model-hints-resume",
    "--prompt", "initial dispatch",
    "--model-hints", "dispatch=opus,review=haiku",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  writeManifest(first.manifestPath, {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
  }, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume dispatch",
    "--model-hints", "dispatch=sonnet,merge=gpt-5.4",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.deepEqual(readManifest(first.manifestPath).data.model_hints, {
    dispatch: "sonnet",
    merge: "gpt-5.4",
  });

  const events = readJsonLines(getEventsPath(repoRoot, first.runId));
  const updatedEvent = events.find((event) => event.event === "model_hints_updated");
  assert.deepEqual(updatedEvent.before, {
    dispatch: "opus",
    review: "haiku",
  });
  assert.deepEqual(updatedEvent.after, {
    dispatch: "sonnet",
    merge: "gpt-5.4",
  });
});

test("dispatch resume without --model-hints preserves stored hints and emits no model_hints_updated event", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-model-hints-preserve",
    "--prompt", "initial dispatch",
    "--model-hints", "dispatch=opus,review=haiku",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  writeManifest(first.manifestPath, {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
  }, record.body);

  const expectedHints = JSON.stringify(readManifest(first.manifestPath).data.model_hints);
  runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume dispatch",
    "--json",
  ], env);

  assert.equal(JSON.stringify(readManifest(first.manifestPath).data.model_hints), expectedHints);
  const events = readJsonLines(getEventsPath(repoRoot, first.runId));
  assert.equal(events.filter((event) => event.event === "model_hints_updated").length, 0);
});

const INVALID_MODEL_HINTS = [
  { label: "unknown phase", raw: "foo=bar", pattern: /unknown phase 'foo'/ },
  { label: "missing '='", raw: "dispatch", pattern: /missing '='/ },
  { label: "empty phase", raw: "=opus", pattern: /empty phase/ },
  { label: "empty value", raw: "dispatch=", pattern: /empty value/ },
  { label: "empty pair", raw: "dispatch=sonnet,,review=opus", pattern: /empty pair/ },
  { label: "duplicate phase", raw: "dispatch=opus,dispatch=sonnet", pattern: /duplicate phase 'dispatch'/ },
];

test("parseModelHints rejects invalid model-hints tokens", () => {
  for (const row of INVALID_MODEL_HINTS) {
    assert.throws(() => parseModelHints(row.raw), (error) => {
      assert.match(error.message, row.pattern);
      return true;
    }, row.label);
  }
});

test("dispatch model-hints parse error skips manifest write", () => {
  const { repoRoot, relayHome } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  assert.throws(() => runDispatch(repoRoot, [
    "-b", "issue-318-parse-error-no-manifest",
    "--prompt", "invalid model hints",
    "--model-hints", "foo=bar",
  ], env), (error) => {
    assert.match(String(error.stderr), /invalid --model-hints token/);
    return true;
  });
  assert.equal(listManifestPaths(repoRoot).length, 0);
});

test("dispatch precedence D1 regression: CLI override beats manifest hint in executor argv", () => {
  const { repoRoot, relayHome } = setupRepo();
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-d1.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "dispatch matrix d1";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-d1",
    "--prompt", taskPrompt,
    "--model", "sonnet",
    "--model-hints", "dispatch=opus",
    "--json",
  ], env));
  const commonGitDir = worktreeCommonGitDir(result.worktree);

  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf-8")), [
    "exec",
    "-C", result.worktree,
    "--color", "never",
    "-o", result.resultFile,
    "-c", "model_reasoning_effort=xhigh",
    "-m", "sonnet",
    "--sandbox", "workspace-write",
    "--add-dir", commonGitDir,
    buildDispatchExecPrompt(taskPrompt),
  ]);
  assert.equal(result.codexGitCommonDir, commonGitDir);
});

test("dispatch precedence D2 regression: CLI override works when manifest hint is absent", () => {
  const { repoRoot, relayHome } = setupRepo();
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-d2.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "dispatch matrix d2";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-d2",
    "--prompt", taskPrompt,
    "--model", "sonnet",
    "--json",
  ], env));
  const commonGitDir = worktreeCommonGitDir(result.worktree);

  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf-8")), [
    "exec",
    "-C", result.worktree,
    "--color", "never",
    "-o", result.resultFile,
    "-c", "model_reasoning_effort=xhigh",
    "-m", "sonnet",
    "--sandbox", "workspace-write",
    "--add-dir", commonGitDir,
    buildDispatchExecPrompt(taskPrompt),
  ]);
  assert.equal(result.codexGitCommonDir, commonGitDir);
});

test("dispatch precedence D3 regression: manifest hint supplies the effective model when CLI is unset", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-d3.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "dispatch matrix d3";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-d3",
    "--prompt", taskPrompt,
    "--model-hints", "dispatch=opus",
    "--json",
  ], env));
  const commonGitDir = worktreeCommonGitDir(result.worktree);

  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf-8")), [
    "exec",
    "-C", result.worktree,
    "--color", "never",
    "-o", result.resultFile,
    "-c", "model_reasoning_effort=xhigh",
    "-m", "opus",
    "--sandbox", "workspace-write",
    "--add-dir", commonGitDir,
    buildDispatchExecPrompt(taskPrompt),
  ]);
  assert.equal(result.codexGitCommonDir, commonGitDir);

  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const dispatchStart = events.find((event) => event.event === "dispatch_start");
  assert.equal(dispatchStart.model, "opus");
});

test("dispatch precedence D4 regression: executor argv stays byte-identical when CLI and manifest hint are both absent", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-d4.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "dispatch matrix d4";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-d4",
    "--prompt", taskPrompt,
    "--json",
  ], env));
  const commonGitDir = worktreeCommonGitDir(result.worktree);

  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf-8")), [
    "exec",
    "-C", result.worktree,
    "--color", "never",
    "-o", result.resultFile,
    "-c", "model_reasoning_effort=xhigh",
    "--sandbox", "workspace-write",
    "--add-dir", commonGitDir,
    buildDispatchExecPrompt(taskPrompt),
  ]);
  assert.equal(result.codexGitCommonDir, commonGitDir);

  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const dispatchStart = events.find((event) => event.event === "dispatch_start");
  assert.equal(dispatchStart.model, null);
});

test("dispatch network-access enabled adds codex workspace-write network override and audit stamps", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-network.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "dispatch with network";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-network-enabled",
    "--prompt", taskPrompt,
    "--network-access", "enabled",
    "--json",
  ], env));

  const capturedArgs = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  const commonGitDir = worktreeCommonGitDir(result.worktree);
  assert.deepEqual(capturedArgs.slice(0, 9), [
    "exec",
    "-C", result.worktree,
    "--color", "never",
    "-o", result.resultFile,
    "-c", "model_reasoning_effort=xhigh",
  ]);
  assert.ok(capturedArgs.includes("sandbox_workspace_write.network_access=true"));
  assert.deepEqual(capturedArgs.slice(-3), ["--add-dir", commonGitDir, buildDispatchExecPrompt(taskPrompt)]);
  assert.equal(result.codexGitCommonDir, commonGitDir);
  assert.equal(result.executorNetwork.access, "enabled");
  assert.equal(result.executorNetwork.mechanism, "sandbox_workspace_write.network_access");
  assert.equal(result.executorPolicy.sandbox.enforcement_level, "native");
  assert.equal(result.executorPolicy.network.enforcement_level, "native");
  assert.deepEqual(result.executorPolicy.network.flags, ["-c sandbox_workspace_write.network_access=true"]);

  const manifest = readManifest(result.manifestPath).data;
  assert.deepEqual(manifest.policy.executor_network, {
    access: "enabled",
    mechanism: "sandbox_workspace_write.network_access",
    domains: null,
  });
  assert.equal(manifest.policy.executor_policy.sandbox.enforcement_level, "native");
  assert.equal(manifest.policy.executor_policy.network.enforcement_level, "native");

  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const dispatchStart = events.find((event) => event.event === "dispatch_start");
  const dispatchResult = events.find((event) => event.event === "dispatch_result");
  assert.equal(dispatchStart.executor_network.access, "enabled");
  assert.equal(dispatchResult.executor_network.access, "enabled");
  assert.equal(dispatchStart.executor_policy.sandbox.enforcement_level, "native");
  assert.equal(dispatchStart.executor_policy.network.enforcement_level, "native");
  assert.equal(dispatchResult.executor_policy.sandbox.enforcement_level, "native");
  assert.equal(dispatchResult.executor_policy.network.enforcement_level, "native");
});

test("dispatch widens codex sandbox via --add-dir <common-git-dir> for worktree (#389 sandbox-widening)", () => {
  // The common git dir (`<main-repo>/.git`) is the canonical writable area for
  // linked-worktree git operations: it contains both the per-worktree admin dir
  // (`worktrees/<name>/index.lock`) AND the shared `objects/` (blob writes from
  // git add) and `refs/heads/<branch>` (ref updates from git commit). The fix
  // passes the common git dir, not just the per-worktree admin dir, so codex
  // can complete the full add+commit cycle inside the sandbox.
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-389.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-389-add-dir",
    "--prompt", "issue-389 add-dir sandbox-widening",
    "--json",
  ], env));

  const expectedCommonDir = worktreeCommonGitDir(result.worktree);
  assert.equal(result.codexGitCommonDir, expectedCommonDir);

  const captured = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  const addDirIdx = captured.indexOf("--add-dir");
  assert.notEqual(addDirIdx, -1, "captured argv must contain --add-dir");
  assert.equal(captured[addDirIdx + 1], expectedCommonDir);

  const sandboxIdx = captured.indexOf("--sandbox");
  assert.ok(sandboxIdx >= 0 && addDirIdx > sandboxIdx, "--add-dir must follow --sandbox in argv");

  // Common git dir ends in `.git` (non-bare repo) — covers worktrees/, objects/, refs/, logs/
  assert.match(expectedCommonDir, /\.git$/, "common git dir must end in .git");
  // Sanity check: the worktree's admin dir should be a subdir of the common dir,
  // proving the common-dir grant subsumes the per-worktree admin dir.
  const adminDir = execFileSync("git", ["-C", result.worktree, "rev-parse", "--git-dir"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const resolvedAdminDir = path.resolve(result.worktree, adminDir);
  assert.ok(
    resolvedAdminDir.startsWith(`${expectedCommonDir}${path.sep}`),
    `worktree admin dir ${resolvedAdminDir} should be inside common dir ${expectedCommonDir}`
  );
});

test("dispatch rejects network-access enabled outside codex workspace-write", () => {
  const { repoRoot, relayHome } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  writeFakeClaude(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  assert.throws(() => runDispatch(repoRoot, [
    "-b", "issue-network-readonly",
    "--prompt", "bad network readonly",
    "--network-access", "enabled",
    "--sandbox", "read-only",
  ], env), (error) => {
    assert.match(String(error.stderr), /--network-access enabled requires --sandbox workspace-write/);
    return true;
  });

  assert.throws(() => runDispatch(repoRoot, [
    "-b", "issue-network-claude",
    "--prompt", "bad network claude",
    "--network-access", "enabled",
    "--executor", "claude",
  ], env), (error) => {
    assert.match(String(error.stderr), /--network-access enabled is only supported for codex executor/);
    return true;
  });
});

test("dispatch classifies sandbox network failures for audit events", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeNetworkFailCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-network-fail",
    "--prompt", "trigger network failure",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Could not resolve host: api\.github\.com/);
  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const dispatchResult = events.find((event) => event.event === "dispatch_result");
  assert.equal(dispatchResult.failure_class, "network_blocked_or_unavailable");
});

function writeTempRubric(contents) {
  const rubricFile = path.join(os.tmpdir(), `relay-rubric-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  fs.writeFileSync(rubricFile, contents, "utf-8");
  return rubricFile;
}

function writeRelayPolicy(relayHome, overrides = {}) {
  fs.mkdirSync(relayHome, { recursive: true });
  fs.writeFileSync(path.join(relayHome, "policy.json"), JSON.stringify({
    ...buildDefaultRelayPolicy(),
    ...overrides,
  }, null, 2), "utf-8");
}

function allowCodexDispatchModels(relayHome) {
  writeRelayPolicy(relayHome, {
    profile: "allow-codex-dispatch-models",
    allowed_model_routes: [{ route: "*", phases: ["dispatch"], executors: ["codex"] }],
  });
}

test("dispatch opencode executor records provider metadata", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "openai/*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "test prompt";
  const rubricFile = writeTempRubric("size: \"S\"\nrubric:\n  factors: []\n");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-test",
    "-p", taskPrompt,
    "-e", "opencode",
    "-m", "openai/gpt-5",
    "--rubric-file", rubricFile,
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stderr, /opencode executor is experimental/);
  assert.match(proc.stderr, /reviewer-policy-opencode\.md/);
  const result = JSON.parse(proc.stdout);

  assertOpencodeDispatchCommand(JSON.parse(fs.readFileSync(capturePath, "utf-8")), {
    model: "openai/gpt-5",
    taskPrompt,
  });

  const events = readJsonLines(path.join(result.runDir, "events.jsonl"));
  const dispatchStart = events.find((event) => event.event === "dispatch_start");
  assert.equal(dispatchStart.executor, "opencode");
  assert.equal(dispatchStart.model, "openai/gpt-5");
  assert.equal(dispatchStart.provider, "openai");

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.dispatch.last_executor, "opencode");
  assert.equal(manifest.dispatch.last_model, "openai/gpt-5");
  assert.equal(manifest.dispatch.last_provider, "openai");
});

test("dispatch denies disallowed executor route before spawning the executor", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "strict-deny-unknown",
    deny_unknown_model_routes: true,
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-policy-denied-${Date.now()}.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const rubricFile = writeTempRubric("size: \"S\"\nrubric:\n  factors: []\n");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-policy-denied",
    "-p", "must not spawn opencode",
    "-e", "opencode",
    "-m", "example/opencode-model-fast",
    "--rubric-file", rubricFile,
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(capturePath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.policy_decision.allowed, false);
  assert.equal(result.policy_decision.phase, "dispatch");
  assert.equal(result.policy_decision.actor_field, "executor");
  assert.equal(result.policy_decision.executor, "opencode");
  assert.equal(result.policy_decision.model, "example/opencode-model-fast");
  assert.equal(result.policy_decision.reason, "unknown_model_route");
  assert.match(result.error, /reason=unknown_model_route/);
  assert.equal(result.hint, "run relay-config to register this route");
  assert.equal(result.adapter_capability.adapter, "opencode");
  assert.equal(result.adapter_capability.phase, "dispatch");
  assert.equal(result.adapter_capability.safe, true);
  assert.equal(result.executor_policy.adapter, "opencode");
});

test("dispatch prints relay-config route hint for text route denial", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "strict-deny-unknown",
    deny_unknown_model_routes: true,
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-policy-denied-text-${Date.now()}.json`);
  writeArgCaptureOpencode(binDir, capturePath);

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-policy-denied-text",
    "-p", "must not spawn opencode",
    "-e", "opencode",
    "-m", "example/opencode-model-fast",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(capturePath), false);
  assert.match(proc.stderr, /Error: relay policy denied model route.*reason=unknown_model_route/);
  assert.match(proc.stderr, /hint: run relay-config to register this route/);
});

test("dispatch reports adapter-capability denial before model-route policy", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-antigravity-dispatch",
    allowed_model_routes: [{ route: "google/*", phases: ["dispatch"], executors: ["antigravity"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-antigravity-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-capability-denied-${Date.now()}.json`);
  writeArgCaptureAntigravity(binDir, capturePath);
  const rubricFile = writeTempRubric("size: \"S\"\nrubric:\n  factors: []\n");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-capability-denied",
    "-p", "must not spawn antigravity",
    "-e", "antigravity",
    "-m", "google/gemini-cli",
    "--sandbox", "read-only",
    "--rubric-file", rubricFile,
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(capturePath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.executor, "antigravity");
  assert.equal(result.adapter_capability.adapter, "antigravity");
  assert.equal(result.adapter_capability.phase, "dispatch");
  assert.equal(result.adapter_capability.safe, false);
  assert.match(result.adapter_capability.fail_closed_reasons.join("\n"), /read-only dispatch is not safely representable/);
  assert.equal(result.policy_decision, undefined);
});

test("dispatch opencode executor fails closed when no model route is supplied", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode-bundled-default.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "test missing opencode model route";

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-opencode-bundled-default",
    "-p", taskPrompt,
    "-e", "opencode",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(capturePath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.policy_decision.reason, "missing_model_route");
  assert.equal(result.policy_decision.model, null);
  assert.equal(result.hint, "run relay-config to set a default model for this route");
});

test("dispatch prints relay-config default-model hint for text unresolved model", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-missing-model-text-${Date.now()}.json`);
  writeArgCaptureOpencode(binDir, capturePath);

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-opencode-missing-model-text",
    "-p", "test missing opencode model route",
    "-e", "opencode",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });

  assert.notEqual(proc.status, 0);
  assert.equal(fs.existsSync(capturePath), false);
  assert.match(proc.stderr, /Error: relay policy denied model route.*reason=missing_model_route/);
  assert.match(proc.stderr, /hint: run relay-config to set a default model for this route/);
});

test("dispatch reports install hint when executor CLI is missing in JSON and text modes", () => {
  for (const jsonOut of [true, false]) {
    const { repoRoot, relayHome } = setupRepo();
    process.env.RELAY_HOME = relayHome;
    writeRelayPolicy(relayHome, {
      profile: "allow-opencode-dispatch",
      allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
    });
    const args = [
      "-b", `issue-opencode-missing-cli-${jsonOut ? "json" : "text"}`,
      "-p", "test missing opencode cli",
      "-e", "opencode",
      "-m", "example/opencode-model-fast",
    ];
    if (jsonOut) args.push("--json");

    const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric(args)], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: createGitOnlyPath(),
        RELAY_HOME: relayHome,
      },
    });

    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /Error: opencode CLI not found\./);
    assert.match(proc.stderr, /hint: install the opencode CLI and ensure it is on PATH/);
    if (jsonOut) {
      const result = JSON.parse(proc.stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.error, "opencode CLI not found.");
      assert.equal(result.hint, "install the opencode CLI and ensure it is on PATH");
    } else {
      assert.equal(proc.stdout, "");
    }
  }
});

test("dispatch opencode executor lets RELAY_HOME executors config override bundled model", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  fs.writeFileSync(path.join(relayHome, "executors.json"), JSON.stringify({
    executors: {
      opencode: {
        default_model: "example/opencode-model-local",
        candidate_models: ["example/opencode-model-local"],
      },
    },
  }, null, 2), "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode-local-default.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "test local opencode default";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-opencode-local-default",
    "-p", taskPrompt,
    "-e", "opencode",
    "--json",
  ], env));

  assertOpencodeDispatchCommand(JSON.parse(fs.readFileSync(capturePath, "utf-8")), {
    model: "example/opencode-model-local",
    taskPrompt,
  });

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.dispatch.last_model, "example/opencode-model-local");
  assert.equal(manifest.dispatch.last_provider, "example");
});

test("dispatch lets local executor config define defaults for executors absent from bundled config", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  fs.writeFileSync(path.join(relayHome, "executors.json"), JSON.stringify({
    executors: {
      codex: {
        default_model: "gpt-5.5",
      },
    },
  }, null, 2), "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-codex-local-default.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-codex-local-default",
    "-p", "codex local default model",
    "--json",
  ], env));
  const args = JSON.parse(fs.readFileSync(capturePath, "utf-8"));

  assert.equal(result.status, "completed");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.5");
});

test("dispatch codex executor ignores malformed local executor model config", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  fs.writeFileSync(path.join(relayHome, "executors.json"), "{not-json", "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-codex-malformed-local-model-config.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "codex should ignore unrelated malformed executor config";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-codex-ignore-malformed-model-config",
    "-p", taskPrompt,
    "--json",
  ], env));
  const args = JSON.parse(fs.readFileSync(capturePath, "utf-8"));

  assert.equal(result.status, "completed");
  assert.equal(args.includes("-m"), false);
});

test("dispatch opencode invalid local default fails closed without bundled fallback", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  fs.writeFileSync(path.join(relayHome, "executors.json"), JSON.stringify({
    executors: {
      opencode: {
        default_model: 123,
      },
    },
  }), "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode-invalid-local-default.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "invalid local config should not invent an opencode default";

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-opencode-invalid-local-default",
    "-p", taskPrompt,
    "-e", "opencode",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /Warning: ignoring optional executor model config/);
  assert.match(proc.stderr, /default_model must be a non-empty string/);
  assert.equal(fs.existsSync(capturePath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.policy_decision.reason, "missing_model_route");
  assert.equal(result.policy_decision.model, null);
});

test("dispatch opencode explicit --model skips malformed local executor model config", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  fs.writeFileSync(path.join(relayHome, "executors.json"), "{not-json", "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode-explicit-malformed-local.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "explicit opencode model should ignore malformed default config";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-opencode-explicit-ignore-malformed-model-config",
    "-p", taskPrompt,
    "-e", "opencode",
    "-m", "example/opencode-model-local",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assertOpencodeDispatchCommand(JSON.parse(fs.readFileSync(capturePath, "utf-8")), {
    model: "example/opencode-model-local",
    taskPrompt,
  });
});

test("dispatch opencode malformed local default fails closed without bundled fallback", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-opencode-dispatch",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  fs.writeFileSync(path.join(relayHome, "executors.json"), "{not-json", "utf-8");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-opencode-malformed-local-default.json`);
  writeArgCaptureOpencode(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const taskPrompt = "malformed local config should not invent an opencode default";

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-opencode-malformed-local-default",
    "-p", taskPrompt,
    "-e", "opencode",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /Warning: ignoring optional executor model config/);
  assert.equal(fs.existsSync(capturePath), false);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.policy_decision.reason, "missing_model_route");
  assert.equal(result.policy_decision.model, null);
});

function reasoningArgValue(args) {
  const index = args.indexOf("-c");
  return index === -1 ? null : args[index + 1];
}

function captureCodexReasoning({ branch, rubricText = null, extraArgs = [] }) {
  const { repoRoot, relayHome } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-${branch}.json`);
  writeArgCaptureCodex(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const rubricArgs = [];
  if (rubricText !== null) {
    rubricArgs.push("--rubric-file", writeTempRubric(rubricText));
  }
  runDispatch(repoRoot, [
    "-b", branch,
    "--prompt", `reasoning dispatch ${branch}`,
    ...rubricArgs,
    ...extraArgs,
    "--json",
  ], env);
  return JSON.parse(fs.readFileSync(capturePath, "utf-8"));
}

test("dispatch scales codex reasoning effort by rubric size", () => {
  for (const [size, expected] of [
    ["S", "medium"],
    ["M", "high"],
    ["L", "xhigh"],
    ["XL", "xhigh"],
  ]) {
    const args = captureCodexReasoning({
      branch: `issue-reasoning-size-${size.toLowerCase()}`,
      rubricText: `size: "${size}"\nrubric:\n  factors: []\n`,
    });
    assert.equal(reasoningArgValue(args), `model_reasoning_effort=${expected}`);
  }
});

test("dispatch --reasoning overrides rubric-size codex reasoning effort", () => {
  const args = captureCodexReasoning({
    branch: "issue-reasoning-override",
    rubricText: "size: \"L\"\nrubric:\n  factors: []\n",
    extraArgs: ["--reasoning", "low"],
  });
  assert.equal(reasoningArgValue(args), "model_reasoning_effort=low");
});

test("dispatch falls back to xhigh codex reasoning when rubric size is missing or unrecognized", () => {
  const injectedRubricWithoutSize = captureCodexReasoning({
    branch: "issue-reasoning-injected-rubric-without-size",
  });
  const noSize = captureCodexReasoning({
    branch: "issue-reasoning-no-size",
    rubricText: "rubric:\n  factors: []\n",
  });
  const weirdSize = captureCodexReasoning({
    branch: "issue-reasoning-weird-size",
    rubricText: "size: \"WEIRD\"\nrubric:\n  factors: []\n",
  });

  assert.equal(reasoningArgValue(injectedRubricWithoutSize), "model_reasoning_effort=xhigh");
  assert.equal(reasoningArgValue(noSize), "model_reasoning_effort=xhigh");
  assert.equal(reasoningArgValue(weirdSize), "model_reasoning_effort=xhigh");
});

test("dispatch leaves claude executor argv untouched by rubric-size reasoning", () => {
  const { repoRoot, relayHome } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-claude-reasoning.json`);
  writeArgCaptureClaude(binDir, capturePath);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };
  const rubricFile = writeTempRubric("size: \"S\"\nrubric:\n  factors: []\n");

  runDispatch(repoRoot, [
    "-b", "issue-reasoning-claude",
    "--executor", "claude",
    "--prompt", "claude reasoning dispatch",
    "--rubric-file", rubricFile,
    "--json",
  ], env);

  const args = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  assert.equal(args.includes("-c"), false);
  assert.equal(args.some((arg) => arg.startsWith("model_reasoning_effort=")), false);
});

test("dispatch dry-run resolves effective_dispatch_model from model hints and emits zero events", () => {
  const { repoRoot, relayHome, rubricFile } = setupDryRunFixtureRepo();
  writeRelayPolicy(relayHome, {
    profile: "allow-codex-hint",
    allowed_model_routes: [{ route: "opus", phases: ["dispatch"], executors: ["codex"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-dry-run-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const stdout = execFileSync("node", [SCRIPT, repoRoot,
    "-b", "issue-109-dry-run-model-hints",
    "--prompt", "dry run model hints",
    "--rubric-file", rubricFile,
    "--model-hints", "dispatch=opus",
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env,
  });
  const result = JSON.parse(stdout);

  assert.equal(result.effective_dispatch_model, "opus");
  assert.equal(result.policy_decision.allowed, true);
  assert.equal(result.policy_decision.reason, "allowed_model_route");
  assert.equal(result.policy_decision.matched_route, "opus");
  assert.equal(listManifestPaths(repoRoot).length, 0);
});

test("dispatch dry-run includes managed default policy decision details", () => {
  const { repoRoot, relayHome, rubricFile } = setupDryRunFixtureRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-dry-run-bin-"));
  writeFakeCodex(binDir);
  const stdout = execFileSync("node", [SCRIPT, repoRoot,
    "-b", "issue-policy-dry-run",
    "--prompt", "dry run policy decision",
    "--rubric-file", rubricFile,
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });
  const result = JSON.parse(stdout);

  assert.deepEqual({
    ...result.policy_decision,
    policy: {
      ...result.policy_decision.policy,
      sources: {
        ...result.policy_decision.policy.sources,
        project: "<project-policy>",
      },
    },
  }, {
    allowed: true,
    reason: "managed_cli",
    phase: "dispatch",
    actor_field: "executor",
    actor: "codex",
    executor: "codex",
    reviewer: null,
    model: null,
    matched_route: null,
    policy: {
      status: "defaulted",
      sources: {
        global: path.join(relayHome, "policy.json"),
        repo: path.join(repoRoot, ".relay", "policy.json"),
        project: "<project-policy>",
      },
    },
  });
  assert.ok(result.policy_decision.policy.sources.project.startsWith(path.join(relayHome, "projects")));
  assert.equal(path.basename(result.policy_decision.policy.sources.project), "policy.json");
});

test("dispatch routing dry-run JSON explains CLI tags and selected advisory defaults", () => {
  const { repoRoot, relayHome, rubricFile, env } = setupDryRunFixtureRepo();
  writeRelayPolicy(relayHome, {
    profile: "routing-dry-run",
    routing_rules: [
      {
        name: "docs",
        match: { tags: ["docs"] },
        advisory_review: { reviewer: "claude", profile: "blindspot" },
      },
    ],
  });

  const stdout = runDispatch(repoRoot, [
    "-b", "issue-routing-dry-run",
    "--prompt", "dry run routing decision",
    "--rubric-file", rubricFile,
    "--tags", "docs",
    "--dry-run",
    "--json",
  ], env);
  const result = JSON.parse(stdout);

  assert.equal(result.routing_decision.effective_source, "cli");
  assert.deepEqual(result.routing_decision.source_tags.cli, ["docs"]);
  assert.equal(result.routing_decision.matched_rule.name, "docs");
  assert.deepEqual(result.routing_decision.selected.advisory_review, [{
    reviewer: "claude",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);
});

test("explicit empty routed advisory selection survives preset injection", () => {
  const { repoRoot, relayHome, rubricFile, env } = setupDryRunFixtureRepo();
  writeRelayPolicy(relayHome, {
    profile: "routing-empty-advisory",
    routing_rules: [
      {
        name: "docs",
        match: { tags: ["docs"] },
        advisory_review: [],
      },
    ],
    presets: {
      light: {
        advisory_review: { reviewer: "pi", model: "example/pi-model-fast", profile: "blindspot" },
      },
    },
    allowed_model_routes: [
      { route: "example/pi-model-*", phases: ["advisory_review"], reviewers: ["pi"] },
    ],
  });

  const stdout = runDispatch(repoRoot, [
    "-b", "issue-routing-empty-advisory",
    "--prompt", "dry run empty advisory selection",
    "--rubric-file", rubricFile,
    "--tags", "docs",
    "--route-preset", "light",
    "--dry-run",
    "--json",
  ], env);
  const result = JSON.parse(stdout);

  assert.equal(result.routing_decision.matched_rule.name, "docs");
  // [] is a selection ("no advisory lanes"), not absence: the preset's
  // advisory lanes must not overwrite it.
  assert.deepEqual(result.routing_decision.selected.advisory_review, []);
});

test("dispatch routing dry-run text explains no-match decisions", () => {
  const { repoRoot, relayHome, rubricFile, env } = setupDryRunFixtureRepo();
  writeRelayPolicy(relayHome, {
    profile: "routing-no-match",
    routing_rules: [
      {
        name: "docs",
        match: { tags: ["docs"] },
        advisory_review: { reviewer: "opencode" },
      },
    ],
  });

  const stdout = runDispatch(repoRoot, [
    "-b", "issue-routing-no-match",
    "--prompt", "dry run routing no match",
    "--rubric-file", rubricFile,
    "--tags", "security",
    "--dry-run",
  ], env);

  assert.match(stdout, /Routing:\s+no match/);
  assert.match(stdout, /Tags:\s+cli=security .*effective=security/);
  assert.match(stdout, /Selected:\s+advisory_review=\(none\)/);
});

test("dispatch resume --dry-run with new --model-hints reports the new hint in effective_dispatch_model and does NOT write the manifest or emit events", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  allowCodexDispatchModels(relayHome);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-109-model-hints-dry-run-resume",
    "--prompt", "initial dispatch",
    "--model-hints", "dispatch=opus",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  writeManifest(first.manifestPath, {
    ...updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
  }, record.body);

  const beforeManifest = readManifest(first.manifestPath).data;
  const result = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume dispatch dry-run",
    "--model-hints", "dispatch=sonnet",
    "--dry-run",
    "--json",
  ], env));

  assert.equal(result.effective_dispatch_model, "sonnet");
  const afterManifest = readManifest(first.manifestPath).data;
  assert.equal(afterManifest.model_hints.dispatch, "opus");
  const events = readJsonLines(getEventsPath(repoRoot, first.runId));
  assert.equal(events.filter((event) => event.event === "model_hints_updated").length, 0);
  assert.deepEqual(afterManifest.model_hints, beforeManifest.model_hints);
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

test("dispatch remaps detached HEAD to origin default branch before manifest creation (#253)", () => {
  const { repoRoot, relayHome } = setupDetachedHeadRepo({ originHeadBranch: "trunk" });
  const { env, ghLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/253",
    },
  });

  const result = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-253-fallback",
    "--prompt", "exercise detached HEAD fallback",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[relay-dispatch\] base_branch fallback:/);
  assert.match(result.stderr, /using origin default 'trunk'/);

  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(parsed.manifestPath).data;
  assert.equal(manifest.git.base_branch, "trunk");
  assert.notEqual(manifest.git.base_branch, "HEAD");

  const ghCreateCall = readJsonLines(ghLogPath).find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(ghCreateCall, "expected gh pr create call");
  const baseFlagIndex = ghCreateCall.indexOf("--base");
  assert.notEqual(baseFlagIndex, -1, "expected --base flag");
  assert.equal(ghCreateCall[baseFlagIndex + 1], "trunk");
});

test("dispatch remaps a local-only linked-worktree checkout branch to origin default before manifest creation (#809)", () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const localBranch = "worktree-809-local";
  const linkedPath = path.join(os.tmpdir(), `relay-dispatch-linked-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["worktree", "add", "-b", localBranch, linkedPath, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const localOnlySha = commitFile(linkedPath, "linked-local-only.txt", "local only\n", "linked local-only");
  const originMainSha = revParse(linkedPath, "refs/remotes/origin/main");
  const { env, ghLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/809",
    },
  });

  const result = spawnSync(process.execPath, [SCRIPT, linkedPath, ...withRequiredRubric([
    "-b", "issue-809-linked-worktree",
    "--prompt", "exercise local-only linked worktree fallback",
    "--json",
  ])], {
    cwd: linkedPath,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[relay-dispatch\] base_branch fallback:/);
  assert.match(result.stderr, new RegExp(`rev-parse returned '${localBranch}'`));
  assert.match(result.stderr, /using origin default 'main'/);

  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(parsed.manifestPath).data;
  assert.equal(manifest.git.base_branch, "main");
  assert.notEqual(manifest.git.base_branch, localBranch);
  assert.equal(mergeBase(linkedPath, parsed.branch, "refs/remotes/origin/main"), originMainSha);
  assert.equal(isAncestor(linkedPath, localOnlySha, parsed.branch), false);
  assert.equal(fs.existsSync(path.join(parsed.worktree, "linked-local-only.txt")), false);

  const ghCreateCall = readJsonLines(ghLogPath).find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(ghCreateCall, "expected gh pr create call");
  const baseFlagIndex = ghCreateCall.indexOf("--base");
  assert.notEqual(baseFlagIndex, -1, "expected --base flag");
  assert.equal(ghCreateCall[baseFlagIndex + 1], "main");
});

test("dispatch names new relay worktrees after recorded canonical repo root from linked checkout (#857)", () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const linkedPath = path.join(os.tmpdir(), `krill-857-linked-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["worktree", "add", "-b", "worktree-857-source", linkedPath, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.notEqual(path.basename(linkedPath), path.basename(repoRoot));
  const worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-base-857-"));
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/857",
    },
  });

  const result = spawnSync(process.execPath, [SCRIPT, linkedPath, ...withRequiredRubric([
    "-b", "issue-857-linked-name",
    "--prompt", "exercise linked checkout relay worktree naming",
    "--json",
  ])], {
    cwd: linkedPath,
    encoding: "utf-8",
    env: {
      ...env,
      RELAY_WORKTREE_BASE: worktreeBase,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(parsed.manifestPath).data;
  const expectedRepoRoot = fs.realpathSync(repoRoot);
  assert.equal(manifest.paths.repo_root, expectedRepoRoot);
  assert.equal(path.basename(manifest.paths.worktree), path.basename(manifest.paths.repo_root));
  assert.equal(path.basename(manifest.paths.worktree), path.basename(expectedRepoRoot));
  assert.notEqual(path.basename(manifest.paths.worktree), path.basename(linkedPath));
  assert.equal(path.dirname(path.dirname(manifest.paths.worktree)), worktreeBase);
  assert.equal(parsed.worktree, manifest.paths.worktree);
});

test("dispatch keeps a checkout branch that exists on origin as base_branch (#809)", () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const remoteBranch = "release-809";
  execFileSync("git", ["checkout", "-b", remoteBranch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["push", "-u", "origin", remoteBranch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const remoteTrackingRef = `refs/remotes/origin/${remoteBranch}`;
  execFileSync("git", ["update-ref", "-d", remoteTrackingRef], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.throws(() => execFileSync("git", ["rev-parse", "--verify", "--quiet", remoteTrackingRef], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }));
  const { env, ghLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/810",
    },
  });

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-809-origin-branch",
    "--prompt", "exercise origin branch base resolution",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /\[relay-dispatch\] base_branch fallback:/);

  const parsed = JSON.parse(result.stdout);
  const manifest = readManifest(parsed.manifestPath).data;
  assert.equal(manifest.git.base_branch, remoteBranch);
  assert.match(execFileSync("git", ["rev-parse", "--verify", "--quiet", remoteTrackingRef], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim(), /^[0-9a-f]{40}$/);

  const ghCreateCall = readJsonLines(ghLogPath).find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(ghCreateCall, "expected gh pr create call");
  const baseFlagIndex = ghCreateCall.indexOf("--base");
  assert.notEqual(baseFlagIndex, -1, "expected --base flag");
  assert.equal(ghCreateCall[baseFlagIndex + 1], remoteBranch);
});

test("dispatch starts new branches at origin base when local base is ahead (#795)", () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const originMainSha = revParse(repoRoot, "refs/remotes/origin/main");
  const localAheadSha = commitFile(repoRoot, "local-ahead.txt", "local ahead\n", "local ahead");
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/795",
    },
  });

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-795-local-ahead",
    "--prompt", "exercise local ahead base contamination",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(mergeBase(repoRoot, parsed.branch, "refs/remotes/origin/main"), originMainSha);
  assert.equal(isAncestor(repoRoot, localAheadSha, parsed.branch), false);
  assert.equal(fs.existsSync(path.join(parsed.worktree, "local-ahead.txt")), false);
});

test("dispatch starts new branches at origin base when local base is behind (#795)", async () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const localMainSha = revParse(repoRoot, "HEAD");
  const remoteOnlySha = commitFile(repoRoot, "remote-only.txt", "remote only\n", "remote only");
  execFileSync("git", ["push", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["reset", "--hard", localMainSha], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const pauseMarkerPath = path.join(os.tmpdir(), `relay-dispatch-behind-pause-${process.pid}-${Date.now()}.json`);
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/796",
    },
  });
  const dispatchEnv = {
    ...env,
    RELAY_TEST_AFTER_WORKTREE_CREATE_PAUSE_MS: "1500",
    RELAY_TEST_AFTER_WORKTREE_CREATE_MARKER: pauseMarkerPath,
  };

  const proc = spawn(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-795-local-behind",
    "--prompt", "exercise local behind base content",
    "--json",
  ])], {
    cwd: repoRoot,
    env: dispatchEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForDispatchExit(proc);
  let result;
  try {
    await waitFor(() => fs.existsSync(pauseMarkerPath), {
      timeoutMs: 30000,
      message: "local-behind after-worktree create pause marker",
    });
    assert.equal(revParse(repoRoot, "issue-795-local-behind"), remoteOnlySha);
  } finally {
    result = await exitPromise;
  }

  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(mergeBase(repoRoot, parsed.branch, "refs/remotes/origin/main"), remoteOnlySha);
  assert.equal(isAncestor(repoRoot, remoteOnlySha, parsed.branch), true);
  assert.equal(fs.readFileSync(path.join(parsed.worktree, "remote-only.txt"), "utf-8"), "remote only\n");
});

test("dispatch falls back to local base with a loud warning when origin base fetch fails (#795)", () => {
  const { repoRoot, relayHome, remoteRoot } = setupRepo();
  configureOriginHead(repoRoot, remoteRoot, "main");
  const localAheadSha = commitFile(repoRoot, "offline-local.txt", "offline local\n", "offline local");
  const missingRemote = path.join(os.tmpdir(), `relay-dispatch-missing-origin-${process.pid}-${Date.now()}`);
  execFileSync("git", ["remote", "set-url", "origin", missingRemote], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/797",
    },
  });

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-795-offline-fallback",
    "--prompt", "exercise offline base fallback",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[relay-dispatch\] WARNING: unable to fetch origin\/main before worktree creation/);
  assert.match(result.stderr, /falling back to local refs\/heads\/main/);
  assert.match(result.stderr, /unpushed local commits may contaminate the dispatch PR diff/);

  const parsed = JSON.parse(result.stdout);
  assert.equal(isAncestor(repoRoot, localAheadSha, parsed.branch), true);
  assert.equal(fs.readFileSync(path.join(parsed.worktree, "offline-local.txt"), "utf-8"), "offline local\n");
});

test("dispatch fails closed on detached HEAD when origin HEAD is unresolved before worktree creation (#253)", () => {
  const { repoRoot, relayHome } = setupDetachedHeadRepo();
  const env = {
    ...process.env,
    PATH: createGitOnlyPath(),
    RELAY_HOME: relayHome,
  };

  const result = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-253-fail-closed",
    "--prompt", "exercise detached HEAD failure",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unable to determine base branch for new dispatch when repository HEAD is detached/i);
  assert.match(result.stderr, /git remote set-head origin --auto/);
  assert.equal(listManifestPaths(repoRoot).length, 0);
  assert.equal(fs.existsSync(path.join(relayHome, "runs")), false);
  assert.equal(fs.existsSync(path.join(relayHome, "worktrees")), false);
});

test("dispatch resume missing-worktree error reprovisions an existing branch without recreating it", () => {
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
  execFileSync("git", ["show-ref", "--verify", "refs/heads/issue-42"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree is missing/);
  assert.match(result.stderr, new RegExp(escapeRegExp(first.worktree)));
  assert.match(result.stderr, /git worktree add /);
  assert.match(result.stderr, new RegExp(`git worktree remove --force '${escapeRegExp(first.worktree)}' 2>/dev/null \\|\\| git worktree prune`));
  assert.match(result.stderr, new RegExp(`git worktree add '${escapeRegExp(first.worktree)}' 'issue-42'`));
  assert.doesNotMatch(result.stderr, / -b 'issue-42'/);
  assert.equal(listManifestPaths(repoRoot).length, 1);
});

test("dispatch resume missing-worktree hint stays runnable when the deleted directory is still registered", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-43",
    "--prompt", "first pass",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  writeManifest(first.manifestPath, updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"), record.body);
  fs.rmSync(first.worktree, { recursive: true, force: true });
  const registered = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
  assert.match(registered, new RegExp(escapeRegExp(first.worktree)));

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", first.runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree is missing/);
  assert.match(result.stderr, new RegExp(`git worktree remove --force '${escapeRegExp(first.worktree)}' 2>/dev/null \\|\\| git worktree prune`));
  assert.match(result.stderr, new RegExp(`git worktree add '${escapeRegExp(first.worktree)}' 'issue-43'`));
});

test("dispatch resume missing-worktree error creates the branch only when it is absent", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-42-absent",
    "--prompt", "first pass",
    "--json",
  ], env));
  const manifestPath = first.manifestPath;
  const runId = first.runId;

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);
  execFileSync("git", ["worktree", "remove", "--force", first.worktree], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["branch", "-D", "issue-42-absent"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree is missing/);
  assert.match(result.stderr, new RegExp(escapeRegExp(first.worktree)));
  assert.match(result.stderr, /git worktree add /);
  assert.match(result.stderr, / -b 'issue-42-absent' 'main'/);
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

test("dispatch resume validateManifestPaths wire rejects crafted manifest repo roots", () => {
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
  // #408 in-flight check fires before the runDir-collision check when the branch carries
  // an issue-N pattern; the runDir guard remains as a defense for non-issue branches.
  assert.match(second.stderr, /Refusing to dispatch: 1 non-terminal run\(s\) already own issue-158/);
  assert.match(second.stderr, new RegExp(first.runId));
  assert.match(second.stderr, /--allow-conflicting-run/);
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

test("dispatch with --executor pi invokes Pi and copies stdout into the result file", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-pi-dispatch",
    allowed_model_routes: [{ route: "openai/*", phases: ["dispatch"], executors: ["pi"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pi-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-pi.json`);
  writeArgCapturePi(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const taskPrompt = "test pi task";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "pi-test",
    "-e", "pi",
    "--model", "openai/gpt-5",
    "--prompt", taskPrompt,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.executor, "pi");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.ok(result.commits);
  assert.equal(fs.readFileSync(result.resultFile, "utf-8"), "pi completed\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf-8")), [
    "--no-session",
    "--model", "openai/gpt-5",
    "--thinking", "high",
    "--print", buildDispatchExecPrompt(taskPrompt),
  ]);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.dispatch.last_executor, "pi");
  assert.equal(manifest.dispatch.last_model, "openai/gpt-5");
  assert.equal(manifest.dispatch.last_provider, "openai");
});

test("dispatch with --executor antigravity invokes agy and copies stdout into the result file", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-antigravity-dispatch",
    allowed_model_routes: [{ route: "google/*", phases: ["dispatch"], executors: ["antigravity"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-antigravity-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-antigravity.json`);
  writeArgCaptureAntigravity(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const taskPrompt = "test antigravity task";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "antigravity-test",
    "-e", "antigravity",
    "--model", "google/antigravity-cli",
    "--timeout", "31",
    "--prompt", taskPrompt,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.executor, "antigravity");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.ok(result.commits);
  assert.equal(fs.readFileSync(result.resultFile, "utf-8"), "antigravity completed\n");
  const capturedArgs = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  assert.equal(capturedArgs[0], "--prompt");
  assert.match(capturedArgs[1], /^\[RELAY WORKTREE BOUNDARY\]\n/);
  assert.match(capturedArgs[1], new RegExp(`Repository worktree: ${escapeRegExp(result.worktree)}`));
  assert.match(capturedArgs[1], new RegExp(`Before doing anything, run: cd ${escapeRegExp(result.worktree)}`));
  assert.match(capturedArgs[1], /Do not create, edit, git add, git commit, or report source files under ~\/\.gemini/);
  assert.ok(capturedArgs[1].endsWith(buildDispatchExecPrompt(taskPrompt)));
  assert.deepEqual(capturedArgs.slice(2, 5), ["--print-timeout", "31s", "--sandbox"]);
  assert.deepEqual(capturedArgs.slice(5, 7), ["--add-dir", worktreeCommonGitDir(result.worktree)]);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.dispatch.last_executor, "antigravity");
  assert.equal(manifest.dispatch.last_model, "google/antigravity-cli");
  assert.equal(manifest.dispatch.last_provider, "google");
  assert.equal(manifest.policy.executor_policy.cli.binary, "agy");
  assert.equal(manifest.policy.executor_policy.cli.version, "agy 1.0.2");
  assert.deepEqual(manifest.policy.executor_policy.sandbox.flags, ["--sandbox", "--add-dir <git-common-dir>"]);
});

test("dispatch with --executor cline invokes Cline and extracts run_result.text into the result file", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-cline-dispatch",
    allowed_model_routes: [{ route: "cline-pass/*", phases: ["dispatch"], executors: ["cline"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cline-bin-"));
  const capturePath = path.join(os.tmpdir(), `relay-dispatch-argv-${Date.now()}-cline.json`);
  writeArgCaptureCline(binDir, capturePath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const taskPrompt = "test cline task";

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "cline-test",
    "-e", "cline",
    "--model", "cline-pass/glm-5.2",
    "--timeout", "31",
    "--prompt", taskPrompt,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.executor, "cline");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.ok(result.commits);
  assert.equal(fs.readFileSync(result.resultFile, "utf-8"), "cline completed\n");
  const capturedArgs = JSON.parse(fs.readFileSync(capturePath, "utf-8"));
  assert.deepEqual(capturedArgs.slice(0, 9), [
    "--json",
    "-P", "cline-pass",
    "-m", "cline-pass/glm-5.2",
    "--cwd", result.worktree,
    "--timeout", "31",
  ]);
  assert.match(capturedArgs[9], /^\[RELAY WORKTREE BOUNDARY\]\n/);
  assert.match(capturedArgs[9], new RegExp(`Repository worktree: ${escapeRegExp(result.worktree)}`));
  assert.match(capturedArgs[9], /Do not use cline --worktree/);
  assert.ok(capturedArgs[9].endsWith(buildDispatchExecPrompt(taskPrompt)));
  assert.equal(capturedArgs.includes("--worktree"), false);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.dispatch.last_executor, "cline");
  assert.equal(manifest.dispatch.last_model, "cline-pass/glm-5.2");
  assert.equal(manifest.dispatch.last_provider, "cline-pass");
});

test("dispatch with --executor cline escalates malformed JSONL through the manifest failure path", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-cline-dispatch",
    allowed_model_routes: [{ route: "cline-pass/*", phases: ["dispatch"], executors: ["cline"] }],
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cline-bin-"));
  writeMalformedResultCline(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "cline-malformed-result",
    "-e", "cline",
    "--model", "cline-pass/glm-5.2",
    "--prompt", "test cline malformed result",
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
  assert.match(result.error, /executor_result_finalize_failed: .*Cline JSONL line 1 must be valid JSON/);
  assert.equal(fs.existsSync(result.resultFile), false);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.dispatch.last_executor, "cline");
  assert.equal(manifest.dispatch.last_model, "cline-pass/glm-5.2");
  const commitLog = execFileSync("git", ["-C", result.worktree, "log", "--oneline", "-1"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  assert.match(commitLog, /fake cline malformed result/);
  assert.equal(fs.readFileSync(path.join(result.worktree, "cline-work.txt"), "utf-8"), "work before malformed result\n");
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

  assert.equal(result.resultFile, path.join(result.runDir, "dispatch-result.txt"));
  assert.equal(result.stdoutLog, path.join(result.runDir, "dispatch-stdout.log"));
  assert.equal(result.stderrLog, path.join(result.runDir, "dispatch-stderr.log"));
  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-result.txt")));
  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-stdout.log")));
  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-stderr.log")));
  const resultText = fs.readFileSync(path.join(result.runDir, "dispatch-result.txt"), "utf-8");
  assert.match(resultText, /ok/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.paths.dispatch_result, path.join(result.runDir, "dispatch-result.txt"));
  assert.equal(manifest.paths.dispatch_stdout, path.join(result.runDir, "dispatch-stdout.log"));
  assert.equal(manifest.paths.dispatch_stderr, path.join(result.runDir, "dispatch-stderr.log"));
  assert.equal(manifest.paths.lease, path.join(result.runDir, "lease.json"));
  assert.equal(fs.existsSync(path.join(result.runDir, "lease.json")), false);
});

test("dispatch creates a run lease while executor runs and removes it on normal completion", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-lease-${Date.now()}.json`);
  writeLeaseCheckingCodex(binDir, markerPath);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-lease",
    "--prompt", "lease lifecycle task",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.equal(marker.output, path.join(result.runDir, "dispatch-result.txt"));
  assert.equal(marker.leasePath, path.join(result.runDir, "lease.json"));
  assert.equal(Number.isInteger(marker.lease.pid), true);
  assert.ok(marker.lease.pid > 0);
  assert.equal(Number.isInteger(marker.lease.pgid), true);
  assert.equal(marker.lease.host, os.hostname());
  assert.equal(marker.lease.timeout_s, 2400);
  assert.equal(fs.existsSync(marker.leasePath), false);
});

test("dispatch keeps lease and leaves run dispatched when executor leader exits with a live process group", async (t) => {
  if (process.platform === "win32") return;

  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bg-bin-"));
  const markerPath = path.join(os.tmpdir(), `relay-dispatch-bg-${process.pid}-${Date.now()}.json`);
  registerSignalFixtureCleanup(t, {
    pgid: () => marker?.pgid || null,
    paths: () => [binDir, markerPath, `${markerPath}.child-ready`],
  });
  writeLeaderExitBackgroundCodex(binDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
    RELAY_TEST_EXECUTOR_MARKER: markerPath,
  };
  let marker = null;

  try {
    const result = spawnSync(process.execPath, [SCRIPT, repoRoot, ...withRequiredRubric([
      "-b", "issue-801-leader-close-live-pgid",
      "--prompt", "leader exits while background child keeps pgid alive",
      "--json",
    ])], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30000,
    });

    marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /executor process group .*still alive after executor leader exited/);
    assert.equal(fs.existsSync(marker.leasePath), true);
    const lease = JSON.parse(fs.readFileSync(marker.leasePath, "utf-8"));
    assert.equal(lease.pgid, marker.pgid);

    const manifestPath = listManifestPaths(repoRoot)[0];
    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, STATES.DISPATCHED);
    const interruptedEvent = readRunEvents(repoRoot, manifest.run_id).at(-1);
    assert.equal(interruptedEvent.event, "dispatch_interrupted");
    assert.equal(interruptedEvent.reason, "executor_group_unsettled_after_leader_close");
    assert.equal(interruptedEvent.executor_pgid, marker.pgid);
    assert.equal(interruptedEvent.executor_terminated, false);
  } finally {
    if (marker?.pgid) {
      try {
        process.kill(-Number(marker.pgid), "SIGKILL");
      } catch {}
      try {
        await waitFor(() => !isPgidAlive(marker.pgid), {
          timeoutMs: 1000,
          message: `process group ${marker.pgid} to exit`,
        });
      } catch {}
    }
  }
});

test("dispatch resume waits for the fresh run lease when stale lease.json exists", () => {
  if (process.platform === "win32") return;

  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RELAY_HOME: relayHome };
  const first = makeDispatchedResumeFixture(repoRoot, env, { appendInterruptedEvent: true });
  const staleLease = {
    pid: 111111,
    pgid: 222222,
    host: os.hostname(),
    started_at: new Date(Date.now() - 60_000).toISOString(),
    timeout_s: 2400,
  };
  fs.writeFileSync(path.join(first.runDir, "lease.json"), `${JSON.stringify(staleLease, null, 2)}\n`, "utf-8");

  const markerPath = path.join(os.tmpdir(), `relay-dispatch-lease-fresh-${Date.now()}.json`);
  writeLeaseFreshnessCheckingCodex(binDir, markerPath);
  const preloadPath = writePreloadScript(binDir, "delay-lease-write-preload.js", `
const fs = require("fs");
const path = require("path");
const originalWriteFileSync = fs.writeFileSync;
const isDispatch = String(process.argv[1] || "").endsWith("dispatch.js");
fs.writeFileSync = function patchedWriteFileSync(filePath, data, options) {
  if (
    isDispatch &&
    path.basename(String(filePath)) === "lease.json" &&
    process.env.RELAY_TEST_DELAY_LEASE_WRITE_MS
  ) {
    const delayMs = Number(process.env.RELAY_TEST_DELAY_LEASE_WRITE_MS);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  return originalWriteFileSync.call(this, filePath, data, options);
};
`);
  const delayedEnv = withNodePreload({
    ...env,
    RELAY_TEST_DELAY_LEASE_WRITE_MS: "750",
  }, preloadPath);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume with stale lease present",
    "--json",
  ], delayedEnv));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.equal(marker.leasePath, path.join(first.runDir, "lease.json"));
  assert.equal(marker.lease.pgid, marker.executorPid);
  assert.notEqual(marker.lease.pgid, staleLease.pgid);
  assert.equal(fs.existsSync(marker.leasePath), false);
});

test("dispatch persists selected guidance metadata in run artifacts and events", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-398-guidance",
    "--prompt", guidancePrompt(),
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const manifest = readManifest(result.manifestPath).data;
  assert.deepEqual(manifest.advisory.guidance.guidance_packs, [
    "surgical-change",
    "verification-evidence",
    "trust-boundary",
  ]);
  assert.deepEqual(manifest.advisory.guidance.task_profile_summary, {
    size: "M",
    change_type: "feature",
    domains: ["relay-dispatch", "tests"],
    risk_tags: ["trust-boundary", "prompt-contract"],
    execution_mode: "fresh-context",
    derivation_inputs: ["github_issue_398", "issue_394_reference_doc"],
  });
  assert.equal(manifest.advisory.guidance.artifact_path, "guidance-metadata.json");
  assert.equal(manifest.roles.executor, "codex");
  assert.equal(manifest.review.latest_verdict, "pending");

  const artifact = JSON.parse(fs.readFileSync(path.join(result.runDir, "guidance-metadata.json"), "utf-8"));
  assert.equal(artifact.dispatch_prompt_path, "dispatch-prompt.md");
  assert.equal(artifact.rubric_path, "rubric.yaml");
  assert.deepEqual(artifact.guidance_packs, manifest.advisory.guidance.guidance_packs);
  assert.deepEqual(artifact.task_profile_summary, manifest.advisory.guidance.task_profile_summary);

  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const guidanceEvent = events.find((event) => event.event === "guidance_selected");
  assert.ok(guidanceEvent, "guidance_selected event should be appended");
  assert.equal(typeof guidanceEvent.ts, "string");
  assert.equal(guidanceEvent.run_id, result.runId);
  assert.deepEqual(guidanceEvent.guidance_packs, artifact.guidance_packs);
  assert.deepEqual(guidanceEvent.task_profile_summary, artifact.task_profile_summary);
});

test("dispatch derives review assurance from task_profile when CLI policy is unset", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-profile-assurance",
    "--prompt", guidancePrompt({ reviewAssurance: "hardened" }),
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.policy.review_assurance, "hardened");
  assert.equal(manifest.advisory.guidance.task_profile_summary.review_assurance, "hardened");
});

test("dispatch resume preserves guidance metadata without injecting stale Working Guidance blocks", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-398-guidance-resume",
    "--prompt", guidancePrompt({ task: "initial guided dispatch" }),
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  writeManifest(
    first.manifestPath,
    updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"),
    record.body
  );

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "fix review feedback without a new task profile",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  const manifest = readManifest(first.manifestPath).data;
  assert.deepEqual(manifest.advisory.guidance.guidance_packs, [
    "surgical-change",
    "verification-evidence",
    "trust-boundary",
  ]);

  const artifact = JSON.parse(fs.readFileSync(path.join(second.runDir, "guidance-metadata.json"), "utf-8"));
  assert.equal(artifact.source, "manifest-preserved");
  assert.deepEqual(artifact.guidance_packs, manifest.advisory.guidance.guidance_packs);

  const dispatchPrompt = fs.readFileSync(path.join(second.runDir, "dispatch-prompt.md"), "utf-8");
  assert.match(dispatchPrompt, /fix review feedback without a new task profile/);
  assert.doesNotMatch(dispatchPrompt, /## Working Guidance/);

  const guidanceEvents = readJsonLines(getEventsPath(repoRoot, first.runId))
    .filter((event) => event.event === "guidance_selected");
  assert.equal(guidanceEvents.length, 2);
  assert.deepEqual(guidanceEvents[1].guidance_packs, guidanceEvents[0].guidance_packs);
  assert.equal(guidanceEvents[1].guidance_source, "manifest-preserved");
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
  assert.equal(result.commitMode, "committed in-sandbox");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 123);
  assert.equal(result.prCreatedByUs, true);
  assert.match(result.error, /total_timeout|timed out/);

  const remoteBranch = execFileSync("git", ["ls-remote", "--heads", "origin", "issue-timeout-work"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  assert.match(remoteBranch, /\brefs\/heads\/issue-timeout-work$/);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.github.pr_created_by_orchestrator, true);
  assert.equal(manifest.github.pr_number, undefined);
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
  assert.match(result.error, /total_timeout|timed out/);
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
    ["git", ["-C", "/tmp/repo-worktree"]],
    ["gh", ["pr", "create"]],
  ]);
  const pushCall = calls.find(({ command, args }) => command === "git" && args.includes("push"));
  assert.ok(pushCall, "expected git push call");
  assert.deepEqual(pushCall.args, ["-C", "/tmp/repo-worktree", "push", "-u", "origin", "issue-198"]);

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

test("pushAndOpenPR pushes to the branch-configured remote when it is not origin (#229)", async () => {
  const { execFile, calls } = createExecFileMock({
    prCreateUrl: "https://github.com/acme/dev-relay/pull/400",
    gitLogOutput: "fix: resolve upstream remote",
    branchRemote: "upstream",
  });

  const result = await pushAndOpenPR({
    wtPath: "/tmp/repo-worktree",
    branch: "issue-229-fork",
    baseBranch: "main",
    resultPreview: "Fork-remote publication.",
    runId: "issue-229-fork-run",
    executor: "codex",
    execFile,
  });

  assert.deepEqual(result, { prNumber: 400, createdByUs: true });

  const configCall = calls.find(({ command, args }) => command === "git" && args.includes("config"));
  assert.ok(configCall, "expected git config lookup for branch remote");
  assert.deepEqual(configCall.args, [
    "-C", "/tmp/repo-worktree",
    "config", "--get", "branch.issue-229-fork.remote",
  ]);

  const pushCall = calls.find(({ command, args }) => command === "git" && args.includes("push"));
  assert.ok(pushCall, "expected git push call");
  assert.deepEqual(pushCall.args, ["-C", "/tmp/repo-worktree", "push", "-u", "upstream", "issue-229-fork"]);
});

test("pushAndOpenPR falls back to origin when the branch has no configured remote (#229)", async () => {
  const { execFile, calls } = createExecFileMock({
    prCreateUrl: "https://github.com/acme/dev-relay/pull/401",
    branchRemote: "",
  });

  await pushAndOpenPR({
    wtPath: "/tmp/repo-worktree",
    branch: "issue-229-no-config",
    baseBranch: "main",
    resultPreview: "No branch.<name>.remote configured.",
    runId: "issue-229-no-config-run",
    executor: "codex",
    execFile,
  });

  const pushCall = calls.find(({ command, args }) => command === "git" && args.includes("push"));
  assert.ok(pushCall, "expected git push call");
  assert.deepEqual(pushCall.args, ["-C", "/tmp/repo-worktree", "push", "-u", "origin", "issue-229-no-config"]);
});

test("pushAndOpenPR falls back to origin when git config lookup fails (#229)", async () => {
  const { execFile, calls } = createExecFileMock({
    prCreateUrl: "https://github.com/acme/dev-relay/pull/402",
    branchRemoteError: true,
  });

  await pushAndOpenPR({
    wtPath: "/tmp/repo-worktree",
    branch: "issue-229-config-fail",
    baseBranch: "main",
    resultPreview: "git config exits non-zero.",
    runId: "issue-229-config-fail-run",
    executor: "codex",
    execFile,
  });

  const pushCall = calls.find(({ command, args }) => command === "git" && args.includes("push"));
  assert.ok(pushCall, "expected git push call");
  assert.deepEqual(pushCall.args, ["-C", "/tmp/repo-worktree", "push", "-u", "origin", "issue-229-config-fail"]);
});

test("resolveBranchRemote returns origin when branch is missing or empty (#229)", () => {
  const { execFile, calls } = createExecFileMock();
  assert.equal(resolveBranchRemote(execFile, "/tmp/repo-worktree", ""), "origin");
  assert.equal(resolveBranchRemote(execFile, "/tmp/repo-worktree", null), "origin");
  assert.equal(calls.length, 0, "no git config lookup for empty branch name");
});

test("dispatch pushes the branch and opens a PR from the orchestrator on success", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/321",
    },
  });
  const dispatchEnv = {
    ...env,
    RELAY_ORCHESTRATOR: "",
    RELAY_REVIEWER: "",
  };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-198",
    "--prompt", "implement orchestrator PR creation",
    "--json",
  ], dispatchEnv));

  assert.equal(result.status, "completed");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 321);
  assert.equal(result.prCreatedByUs, true);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.git.pr_number, 321);
  assert.equal(manifest.github.pr_created_by_orchestrator, true);
  assert.equal(manifest.github.pr_number, undefined);
  assert.equal(manifest.roles.orchestrator, "unknown");
  assert.equal(manifest.roles.reviewer, "unknown");

  const ghCalls = readJsonLines(ghLogPath);
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["pr", "list"], ["pr", "create"]]);
  const execCalls = readJsonLines(execLogPath);
  assert.ok(execCalls.some((entry) => entry.command === "git" && entry.args.includes("push")));
});

test("dispatch can defer PR publication until internal review passes", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/421",
    },
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-421-delayed-publication",
    "--prompt", "implement delayed publication",
    "--publish-policy", "after-internal-review",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.runState, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(result.publishPolicy, "after-internal-review");
  assert.equal(result.prNumber, null);
  assert.equal(result.prCreatedByUs, null);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_internal_review");
  assert.equal(manifest.git.pr_number, null);

  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.ok(!readJsonLines(execLogPath).some((entry) => entry.command === "git" && entry.args.includes("push")));
});

test("dispatch preserves delayed publication policy across same-run redispatch", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/422",
    },
  });

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-422-delayed-redispatch",
    "--prompt", "first delayed attempt",
    "--publish-policy", "after-internal-review",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.INTERNAL_REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume delayed attempt",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.publishPolicy, "after-internal-review");
  assert.equal(second.runState, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(second.prNumber, null);

  const manifest = readManifest(first.manifestPath).data;
  assert.equal(manifest.dispatch.publish_policy, "after-internal-review");
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.ok(!readJsonLines(execLogPath).some((entry) => entry.command === "git" && entry.args.includes("push")));
});

test("dispatch rejects same-run redispatch publish policy changes", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/423",
    },
  });

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-423-delayed-redispatch-conflict",
    "--prompt", "first delayed attempt",
    "--publish-policy", "after-internal-review",
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "--run-id", first.runId,
    "--prompt", "resume with conflicting policy",
    "--publish-policy", "immediate",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /same-run resume cannot change dispatch\.publish_policy/);
});

test("dispatch lets explicit role env vars override the unknown defaults", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/325",
    },
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-198-role-override",
    "--prompt", "respect explicit role bindings",
    "--review-assurance", "hardened",
    "--json",
  ], {
    ...env,
    RELAY_ORCHESTRATOR: "claude",
    RELAY_REVIEWER: "claude",
  }));

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.roles.orchestrator, "claude");
  assert.equal(manifest.roles.reviewer, "claude");
  assert.equal(manifest.policy.review_assurance, "hardened");
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
  assert.equal(manifest.github.pr_created_by_orchestrator, false);
  assert.equal(manifest.github.pr_number, undefined);

  const ghCalls = readJsonLines(ghLogPath);
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["pr", "list"]]);
});

test("dispatch silent failure escalates when executor exits cleanly without stdout or result file", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/324",
    },
    codexMode: "silent",
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
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(fs.existsSync(result.resultFile), false);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch escalates committed work when the executor omits the structured result file", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/325",
    },
    codexMode: "commit-no-result",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-263-commit-no-result",
    "--prompt", "commit work but skip the structured result file",
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
  assert.match(result.error, /structured result|silent failure/i);
  assert.match(result.commits, /commit without result/);
  assert.equal(result.uncommitted, null);
  assert.equal(fs.existsSync(result.resultFile), false);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch escalates partial timed-out work when the executor omits the structured result file", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/326",
    },
    codexMode: "partial-no-result",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-263-partial-no-result",
    "--prompt", "leave partial work without a structured result file",
    "--timeout", "1",
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
  assert.match(result.error, /total_timeout|timed out/);
  assert.equal(result.commits, "");
  assert.match(result.uncommitted, /README\.md/);
  assert.match(result.uncommittedDiff, /README\.md/);
  assert.equal(fs.existsSync(result.resultFile), false);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch marks verified no-op runs as completed-no-op and skips orchestrator publication", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/325",
    },
    codexMode: "noop",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-263-noop",
    "--prompt", "nothing to do",
    "--json",
  ], env));

  assert.equal(result.status, "completed-no-op");
  assert.equal(result.commitMode, "completed-no-op");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.commits, "");
  assert.equal(result.uncommitted, null);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch auto-recovers uncommitted codex runs by default", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  process.env.RELAY_HOME = relayHome;
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/508",
    },
    codexMode: "uncommitted",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-508-codex-default-auto-recover",
    "--prompt", "work without commit",
    "--json",
  ], env));

  assert.equal(result.status, "completed-uncommitted");
  assert.equal(result.commitMode, "auto-recovered");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 508);
  assert.match(result.commits, /Recover relay run/);
  assert.equal(result.uncommitted, null);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.pr_number, 508);
  assert.equal(manifest.git.head_sha, result.headSha);
  const ghCalls = readJsonLines(ghLogPath);
  assert(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));
  assert(readJsonLines(execLogPath).some(({ command, args }) => command === "git" && args.includes("push")));
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const recoveryEvent = events.find((event) => event.event === "recover_commit");
  assert(recoveryEvent, JSON.stringify(events, null, 2));
  assert.match(recoveryEvent.reason, /auto-recover-commit enabled/);
});

test("dispatch leaves uncommitted non-codex runs unrecovered by default", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/509",
    },
    codexMode: "uncommitted",
    executor: "claude",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-508-claude-default-no-recover",
    "--prompt", "work without commit",
    "--executor", "claude",
    "--json",
  ], env));

  assert.equal(result.status, "completed-uncommitted");
  assert.equal(result.commitMode, "completed-uncommitted, recover-commit required");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.commits, "");
  assert.match(result.uncommitted, /README\.md/);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch blocks delayed publication internal review when work is uncommitted", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/510",
    },
    codexMode: "uncommitted",
    executor: "claude",
  });

  let dispatchError;
  try {
    runDispatch(repoRoot, [
      "-b", "issue-510-delayed-uncommitted",
      "--prompt", "work without commit",
      "--publish-policy", "after-internal-review",
      "--executor", "claude",
      "--json",
    ], env);
  } catch (caught) {
    dispatchError = caught;
  }
  assert.ok(dispatchError, "expected delayed uncommitted dispatch to exit nonzero");
  const result = JSON.parse(String(dispatchError.stdout || ""));

  assert.equal(result.status, "failed");
  assert.match(result.error, /recover-commit required before internal review/);
  assert.equal(result.commitMode, "completed-uncommitted, recover-commit required");
  assert.equal(result.runState, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(result.prNumber, null);
  assert.match(result.uncommitted, /README\.md/);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(manifest.next_action, "recover_commit_before_internal_review");
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch blocks delayed publication internal review when timed-out work is uncommitted", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/511",
    },
    codexMode: "timeout-uncommitted-result",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-511-delayed-timeout-uncommitted",
    "--prompt", "time out with uncommitted work",
    "--publish-policy", "after-internal-review",
    "--no-auto-recover-commit",
    "--timeout", "1",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.match(result.error, /recover-commit required before internal review/);
  assert.equal(result.runState, STATES.INTERNAL_REVIEW_PENDING);
  assert.match(result.uncommitted, /README\.md/);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(manifest.next_action, "recover_commit_before_internal_review");
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch escalates delayed internal review when auto recover-commit fails", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/512",
    },
    codexMode: "uncommitted",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-512-delayed-auto-recover-fails",
    "--prompt", "work without commit",
    "--publish-policy", "after-internal-review",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...env,
      RELAY_TEST_FAIL_RECOVER_COMMIT: "1",
    },
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.match(result.error, /auto_recover_commit_failed/);
  assert.equal(result.commitMode, "auto-recover failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.equal(result.prNumber, null);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch escalates Antigravity zero-exit runs with only runtime metadata dirt", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-antigravity-dispatch",
    allowed_model_routes: [{ route: "google/*", phases: ["dispatch"], executors: ["antigravity"] }],
  });
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/593",
    },
    codexMode: "runtime-only",
    executor: "antigravity",
  });

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-593-antigravity-runtime-only",
    "--prompt", "leave only antigravity runtime metadata",
    "--executor", "antigravity",
    "--model", "google/antigravity-cli",
    "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.commitMode, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /no reviewable repository changes/i);
  assert.match(result.error, /\.antigravitycli\//);
  assert.equal(result.commits, "");
  assert.equal(result.uncommitted, null);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch preserves Antigravity completed-uncommitted for non-runtime repository dirt", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  process.env.RELAY_HOME = relayHome;
  writeRelayPolicy(relayHome, {
    profile: "allow-antigravity-dispatch",
    allowed_model_routes: [{ route: "google/*", phases: ["dispatch"], executors: ["antigravity"] }],
  });
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/594",
    },
    codexMode: "uncommitted",
    executor: "antigravity",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-593-antigravity-real-dirt",
    "--prompt", "leave real repository dirt",
    "--executor", "antigravity",
    "--model", "google/antigravity-cli",
    "--json",
  ], env));

  assert.equal(result.status, "completed-uncommitted");
  assert.equal(result.commitMode, "completed-uncommitted, recover-commit required");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.commits, "");
  assert.match(result.uncommitted, /README\.md/);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch --auto-recover-commit enables recovery for non-codex completed-uncommitted runs (#393)", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  process.env.RELAY_HOME = relayHome;
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/393",
    },
    codexMode: "uncommitted",
    executor: "claude",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-393-non-codex-auto-recover",
    "--prompt", "work without commit, then auto recover",
    "--executor", "claude",
    "--auto-recover-commit",
    "--json",
  ], env));

  assert.equal(result.status, "completed-uncommitted");
  assert.equal(result.commitMode, "auto-recovered");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.prNumber, 393);
  assert.match(result.commits, /Recover relay run/);
  assert.equal(result.uncommitted, null);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.pr_number, 393);
  assert.equal(manifest.git.head_sha, result.headSha);
  const ghCalls = readJsonLines(ghLogPath);
  assert(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"));
  assert(readJsonLines(execLogPath).some(({ command, args }) => command === "git" && args.includes("push")));
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
  const events = readJsonLines(getEventsPath(repoRoot, result.runId));
  const recoveryEvent = events.find((event) => event.event === "recover_commit");
  assert(recoveryEvent, JSON.stringify(events, null, 2));
  assert.match(recoveryEvent.reason, /auto-recover-commit enabled/);
});

test("dispatch --no-auto-recover-commit disables codex default recovery", () => {
  const { repoRoot, relayHome } = setupRepoWithOrigin();
  const { env, ghLogPath, execLogPath, pushPrCountPath } = createPushPrTestEnv({
    relayHome,
    ghState: {
      prCreateUrl: "https://github.com/acme/dev-relay/pull/510",
    },
    codexMode: "uncommitted",
  });

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-508-codex-no-auto-recover",
    "--prompt", "work without commit",
    "--no-auto-recover-commit",
    "--json",
  ], env));

  assert.equal(result.status, "completed-uncommitted");
  assert.equal(result.commitMode, "completed-uncommitted, recover-commit required");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.equal(result.commits, "");
  assert.match(result.uncommitted, /README\.md/);
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.deepEqual(readJsonLines(ghLogPath), []);
  assert.deepEqual(readJsonLines(execLogPath), []);
  assert.equal(Number(fs.readFileSync(pushPrCountPath, "utf-8")), 0);
});

test("dispatch uses result-file presence to distinguish silent failure from verified no-op", () => {
  const silentFixture = setupRepoWithOrigin();
  const silentEnv = createPushPrTestEnv({
    relayHome: silentFixture.relayHome,
    codexMode: "silent",
  });
  const silentProc = spawnSync("node", [SCRIPT, silentFixture.repoRoot, ...withRequiredRubric([
    "-b", "issue-263-silent-pair",
    "--prompt", "same inputs without result file",
    "--json",
  ])], {
    cwd: silentFixture.repoRoot,
    encoding: "utf-8",
    env: silentEnv.env,
  });
  assert.notEqual(silentProc.status, 0);
  const silentResult = JSON.parse(silentProc.stdout);

  const noOpFixture = setupRepoWithOrigin();
  const noOpEnv = createPushPrTestEnv({
    relayHome: noOpFixture.relayHome,
    codexMode: "noop",
  });
  const noOpResult = JSON.parse(runDispatch(noOpFixture.repoRoot, [
    "-b", "issue-263-noop-pair",
    "--prompt", "same inputs with result file",
    "--json",
  ], noOpEnv.env));

  assert.equal(silentResult.status, "failed");
  assert.equal(noOpResult.status, "completed-no-op");
  assert.equal(fs.existsSync(silentResult.resultFile), false);
  assert.equal(fs.existsSync(noOpResult.resultFile), true);
});

test("dispatch writes execution evidence with the post-dispatch HEAD and the caller test command", () => {
  const fixture = setupRepoWithOrigin();
  const env = createPushPrTestEnv({
    relayHome: fixture.relayHome,
    codexMode: "commit",
    ghState: {
      prCreateUrl: "https://example.test/acme/dev-relay/pull/261",
    },
  });
  const startHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  const result = JSON.parse(runDispatch(fixture.repoRoot, [
    "-b", "issue-261-execution-evidence",
    "--prompt", "record execution evidence",
    "--test-command", "node --test tests/relay-review/scripts/*.test.js",
    "--json",
  ], env.env));
  const evidence = readExecutionEvidence(result.runDir);

  assert.equal(result.status, "completed");
  assert.equal(result.commitMode, "committed in-sandbox");
  assert.notEqual(result.headSha, startHead);
  assert.equal(evidence.head_sha, result.headSha);
  assert.equal(evidence.test_command, "node --test tests/relay-review/scripts/*.test.js");
  assert.match(evidence.test_result_hash, /^[0-9a-f]{64}$/);
  assert.equal(evidence.test_result_summary, "codex result.txt hashed");
  assert.equal(evidence.test_exit_code, 0);
  assert.equal(evidence.recorded_by, "dispatch-orchestrator-v1");
});

test("dispatch writes execution evidence for no-op runs with the stable start head", () => {
  const fixture = setupRepoWithOrigin();
  const env = createPushPrTestEnv({
    relayHome: fixture.relayHome,
    codexMode: "noop",
  });
  const startHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  const result = JSON.parse(runDispatch(fixture.repoRoot, [
    "-b", "issue-261-execution-evidence-noop",
    "--prompt", "record noop execution evidence",
    "--json",
  ], env.env));
  const evidence = readExecutionEvidence(result.runDir);

  assert.equal(result.status, "completed-no-op");
  assert.equal(result.headSha, startHead);
  assert.equal(evidence.head_sha, startHead);
  assert.equal(evidence.test_command, "unspecified");
  assert.match(evidence.test_result_hash, /^[0-9a-f]{64}$/);
});

test("dispatch rejects blank test-command values before writing execution evidence", () => {
  const fixture = setupRepoWithOrigin();
  const env = createPushPrTestEnv({
    relayHome: fixture.relayHome,
    codexMode: "commit",
    ghState: {
      prCreateUrl: "https://example.test/acme/dev-relay/pull/261",
    },
  });

  for (const blankValue of ["", "   "]) {
    assert.throws(() => runDispatch(fixture.repoRoot, [
      "-b", "issue-261-empty-test-command",
      "--prompt", "record empty execution evidence",
      "--test-command", blankValue,
      "--json",
    ], env.env), /--test-command requires a non-empty value/);
  }
});

test("dispatch writes execution evidence with a flag-like test command verbatim", () => {
  const fixture = setupRepoWithOrigin();
  const env = createPushPrTestEnv({
    relayHome: fixture.relayHome,
    codexMode: "commit",
    ghState: {
      prCreateUrl: "https://example.test/acme/dev-relay/pull/261",
    },
  });

  const result = JSON.parse(runDispatch(fixture.repoRoot, [
    "-b", "issue-261-flaglike-test-command",
    "--prompt", "record flag-like execution evidence",
    "--test-command", "--grep smoke",
    "--json",
  ], env.env));
  const evidence = readExecutionEvidence(result.runDir);

  assert.equal(result.status, "completed");
  assert.equal(evidence.head_sha, result.headSha);
  assert.equal(evidence.test_command, "--grep smoke");
});

test("dispatch writes execution evidence with an exact reserved-token test command verbatim", () => {
  const fixture = setupRepoWithOrigin();
  const env = createPushPrTestEnv({
    relayHome: fixture.relayHome,
    codexMode: "commit",
    ghState: {
      prCreateUrl: "https://example.test/acme/dev-relay/pull/261",
    },
  });

  const result = JSON.parse(runDispatch(fixture.repoRoot, [
    "-b", "issue-261-reserved-token-test-command",
    "--prompt", "record reserved-token execution evidence",
    "--test-command", "--json",
    "--json",
  ], env.env));
  const evidence = readExecutionEvidence(result.runDir);

  assert.equal(result.status, "completed");
  assert.equal(evidence.head_sha, result.headSha);
  assert.equal(evidence.test_command, "--json");
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

test("dispatch rejects invalid ready-light rubric before accepting rubric file", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-ready-light-invalid-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, "rubric:\n  factors: []\n", "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-ready-light-invalid-rubric",
    "--prompt", readyLightPrompt(),
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "ready_light_factor_count");
  assert.match(result.error, /Ready-light S rubrics require 1-2 substantive factors/);

  fs.unlinkSync(rubricFile);
});

test("dispatch reports invalid task_profile metadata through failEarly", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-invalid-task-profile-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, readyLightRubricYaml(), "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-invalid-task-profile",
    "--prompt", invalidReviewAssuranceTaskProfilePrompt(),
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "task_profile_parse_failed");
  assert.match(result.error, /Invalid task_profile metadata/);

  fs.unlinkSync(rubricFile);
});

test("dispatch ignores ready-light examples outside structured task profile metadata", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-standard-example-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, threeFactorRubricYaml(), "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-standard-ready-light-example",
    "--prompt", standardPromptWithReadyLightExample(),
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.mode, "new");

  fs.unlinkSync(rubricFile);
});

test("dispatch ignores task_profile examples before active Task Profile metadata", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-standard-task-profile-example-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, threeFactorRubricYaml(), "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot, ...withRequiredRubric([
    "-b", "issue-standard-task-profile-example",
    "--prompt", standardPromptWithTaskProfileExampleBeforeActiveProfile(),
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ])], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.mode, "new");

  fs.unlinkSync(rubricFile);
});

test("dispatch validates retained ready-light rubric on resume", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-ready-light-valid-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, readyLightRubricYaml(), "utf-8");

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-ready-light-resume-invalid-retained",
    "--prompt", readyLightPrompt(),
    "--rubric-file", rubricFile,
    "--json",
  ], env));

  const record = readManifest(first.manifestPath);
  const updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);
  fs.writeFileSync(path.join(getRunDir(repoRoot, first.runId), "rubric.yaml"), "rubric:\n  factors: []\n", "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", readyLightPrompt({ task: "resume ready-light validation" }),
    "--dry-run", "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "ready_light_factor_count");

  fs.unlinkSync(rubricFile);
});

test("dispatch preserves manifest ready-light marker when prompt profile omits it", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const rubricFile = path.join(os.tmpdir(), `rubric-ready-light-manifest-marker-${Date.now()}.yaml`);
  fs.writeFileSync(rubricFile, readyLightRubricYaml(), "utf-8");

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-ready-light-manifest-marker",
    "--prompt", readyLightPrompt(),
    "--rubric-file", rubricFile,
    "--json",
  ], env));
  const record = readManifest(first.manifestPath);
  const manifest = {
    ...record.data,
    advisory: {
      ...(record.data.advisory || {}),
      guidance: {
        guidance_packs: ["surgical-change", "verification-evidence"],
        task_profile_summary: {
          route_decision: "ready_light",
          size: "S",
          guidance_packs: ["surgical-change", "verification-evidence"],
        },
      },
    },
  };
  writeManifest(first.manifestPath, updateManifestState(manifest, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes"), record.body);
  fs.writeFileSync(rubricFile, "rubric:\n  factors: []\n", "utf-8");

  const proc = spawnSync("node", [SCRIPT, repoRoot,
    "--run-id", first.runId,
    "--prompt", plannerReadyLightPromptWithoutExplicitMarker(),
    "--rubric-file", rubricFile,
    "--dry-run", "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.error_code, "ready_light_factor_count");

  fs.unlinkSync(rubricFile);
});

test("dispatch dry-run resolves per-executor timeout defaults and preserves explicit override", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeout-default-bin-"));
  writeFakeCodex(binDir);
  writeFakeClaude(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const codexDefault = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-timeout-codex-default",
    "--executor", "codex",
    "--prompt", "codex timeout default",
    "--dry-run", "--json",
  ], env));
  const claudeDefault = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-timeout-claude-default",
    "--executor", "claude",
    "--prompt", "claude timeout default",
    "--dry-run", "--json",
  ], env));
  const codexOverride = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-timeout-codex-override",
    "--executor", "codex",
    "--prompt", "codex timeout override",
    "--timeout", "600",
    "--dry-run", "--json",
  ], env));

  assert.equal(codexDefault.timeout, 2400);
  assert.equal(claudeDefault.timeout, 1800);
  assert.equal(codexOverride.timeout, 600);
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

test("dispatch infers planner_decision for canonical run-dir done criteria anchor", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const runId = "issue-294-20260425020202000-cafebabe";
  const runDir = getRunDir(repoRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const doneCriteriaFile = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Planner decision\n", "utf-8");
  const rubricFile = path.join(repoRoot, "rubric.yaml");
  fs.writeFileSync(rubricFile, "rubric:\n  factors:\n    - name: planner anchor\n      target: source planner_decision\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "-b", "issue-294",
    "--prompt", "planner anchor test",
    "--done-criteria-file", doneCriteriaFile,
    "--rubric-file", rubricFile,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.mode, "new");
  assert.equal(result.doneCriteriaPath, doneCriteriaFile);

  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.run_id, runId);
  assert.equal(manifest.anchor.done_criteria_path, doneCriteriaFile);
  assert.equal(manifest.anchor.done_criteria_source, "planner_decision");
});

test("dispatch preserves file source for ad-hoc done criteria paths", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const doneCriteriaFile = path.join(repoRoot, "adhoc-done-criteria.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Ad-hoc file\n", "utf-8");

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-294-adhoc",
    "--prompt", "ad-hoc anchor test",
    "--done-criteria-file", doneCriteriaFile,
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const manifest = readManifest(result.manifestPath).data;
  assert.equal(manifest.anchor.done_criteria_path, doneCriteriaFile);
  assert.equal(manifest.anchor.done_criteria_source, "file");
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

function writeRubricFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rubric-size-"));
  const rubricPath = path.join(dir, "rubric.yaml");
  fs.writeFileSync(rubricPath, contents, "utf-8");
  return rubricPath;
}

test("extractRubricSize accepts size and size_class at top-level and nested indentation", async (t) => {
  const cases = [
    { name: "top-level size:", input: "size: M\n", expected: "M" },
    { name: "top-level size_class:", input: "size_class: M\n", expected: "M" },
    { name: "nested rubric size:", input: "rubric:\n  size: M\n", expected: "M" },
    { name: "nested rubric size_class:", input: "rubric:\n  size_class: M\n", expected: "M" },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const rubricPath = writeRubricFixture(entry.input);
      assert.equal(extractRubricSize(rubricPath), entry.expected);
    });
  }
});

test("extractRubricSize returns exported sentinels for missing and unparseable size fields", () => {
  const missingPath = writeRubricFixture("rubric:\n  criteria: []\n");
  const unparseablePath = writeRubricFixture("rubric:\n  size: garbage\n");

  assert.equal(extractRubricSize(missingPath), RUBRIC_SIZE_MISSING);
  assert.equal(extractRubricSize(unparseablePath), RUBRIC_SIZE_UNPARSEABLE);
  assert.notEqual(RUBRIC_SIZE_MISSING, RUBRIC_SIZE_UNPARSEABLE);
});

test("resolveReasoningEffort maps valid rubric size without stderr", () => {
  const rubricPath = writeRubricFixture("rubric:\n  size_class: M\n");
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(resolveReasoningEffort({ rubricPath }), "high");
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(writes.join(""), "");
});

test("resolveReasoningEffort falls back for missing rubric size without requiring a warning", () => {
  const rubricPath = writeRubricFixture("rubric:\n  criteria: []\n");
  assert.equal(resolveReasoningEffort({ rubricPath }), "xhigh");
});

test("resolveReasoningEffort warns and falls back for unparseable rubric size", () => {
  const rubricPath = writeRubricFixture("rubric:\n  size: 42\n");
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(resolveReasoningEffort({ rubricPath }), "xhigh");
  } finally {
    process.stderr.write = originalWrite;
  }

  const stderr = writes.join("");
  assert.match(stderr, /unparseable|invalid/i);
  assert.match(stderr, new RegExp(rubricPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("resolveReasoningEffort override returns directly and silences unparseable warnings", () => {
  const rubricPath = writeRubricFixture("rubric:\n  size: garbage\n");
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(resolveReasoningEffort({ override: "medium", rubricPath }), "medium");
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(writes.join(""), "");
});
