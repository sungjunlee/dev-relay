#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ADAPTER_PHASES, getAdapter, listAdapters } = require("./adapters");
const { assertInvocationIdentity } = require("./adapter-contract");

const AUTH_FAILURE = /\b(auth(?:entication|orization)?|credential|login|log in|api[_ -]?key|token)\b.{0,100}\b(missing|required|invalid|failed|unavailable|not found|not set|expired|denied)\b|\b(not authenticated|not logged in|unauthorized|forbidden|no api key found)\b/i;
const ENVIRONMENT_FAILURE = /\b(operation not permitted|attempt to write a readonly database|sqlite_readonly|filesystem\.open|bind: operation not permitted)\b/i;

function phaseFor(adapter) {
  if (adapter.capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported) {
    return ADAPTER_PHASES.PRIMARY_REVIEW;
  }
  return null;
}

function initializeRepo(root, spawn = spawnSync) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  for (const args of [
    ["-C", repo, "init", "-q", "-b", "main"],
    ["-C", repo, "config", "user.email", "adapter-canary@example.test"],
    ["-C", repo, "config", "user.name", "adapter canary"],
  ]) {
    const result = spawn("git", args, { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  }
  fs.writeFileSync(path.join(repo, "README.md"), "read-only adapter live canary\n", "utf8");
  for (const args of [
    ["-C", repo, "add", "README.md"],
    ["-C", repo, "commit", "-q", "-m", "canary fixture"],
  ]) {
    const result = spawn("git", args, { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  }
  return repo;
}

function gitStatus(repo, spawn = spawnSync) {
  const result = spawn("git", ["-C", repo, "status", "--short", "--untracked-files=all"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr || result.error?.message}`);
  return String(result.stdout || "");
}

function classifyInvocationFailure(result) {
  const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    return { status: "failed", reason: "invocation_timeout", detail: detail.trim() || null };
  }
  if (AUTH_FAILURE.test(detail)) {
    return { status: "skipped", reason: "credentials_unavailable", detail: detail.trim() || null };
  }
  if (ENVIRONMENT_FAILURE.test(detail)) {
    return { status: "skipped", reason: "execution_environment_unavailable", detail: detail.trim() || null };
  }
  return { status: "failed", reason: "invocation_failed", detail: detail.trim() || `exit ${result.status}` };
}

function runAdapterCanary(adapter, {
  root,
  repo,
  timeoutMs,
  env,
  spawn = spawnSync,
}) {
  const probe = adapter.probe({ env, timeoutMs: Math.min(timeoutMs, 10000), spawn });
  if (probe.status === "skipped") {
    return { adapter: adapter.name, status: "skipped", reason: "cli_unavailable", probe };
  }
  if (probe.status !== "available") {
    const reason = /ETIMEDOUT|timed out/i.test(probe.error || "")
      ? "probe_timeout"
      : "probe_failed";
    return { adapter: adapter.name, status: "failed", reason, probe };
  }
  const phase = phaseFor(adapter);
  if (!phase) return { adapter: adapter.name, status: "skipped", reason: "read_only_phase_unavailable", probe };

  const promptPath = path.join(root, `${adapter.name}-prompt.md`);
  const resultPath = path.join(root, `${adapter.name}-result.json`);
  const stdoutPath = path.join(root, `${adapter.name}-stdout.log`);
  const stderrPath = path.join(root, `${adapter.name}-stderr.log`);
  fs.writeFileSync(
    promptPath,
    "Return a minimal valid pass verdict JSON for this read-only canary. Do not modify files.\n",
  );

  const invocation = adapter.buildInvocation({
    phase,
    cwd: repo,
    promptPath,
    resultPath,
    model: null,
    timeoutMs,
    sandbox: "read-only",
    networkAccess: "disabled",
  });
  assertInvocationIdentity(invocation);
  const before = gitStatus(repo, spawn);
  const executed = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env,
    stdio: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
  });
  fs.writeFileSync(stdoutPath, String(executed.stdout || ""), "utf8");
  fs.writeFileSync(stderrPath, String(executed.stderr || ""), "utf8");
  const after = gitStatus(repo, spawn);
  if (before !== after) {
    return { adapter: adapter.name, phase, status: "failed", reason: "worktree_mutated", probe };
  }
  if (executed.error || executed.status !== 0 || executed.signal) {
    return { adapter: adapter.name, phase, probe, ...classifyInvocationFailure(executed) };
  }
  const outcome = adapter.parseOutcome({
    phase,
    exitCode: executed.status,
    signal: executed.signal,
    stdoutPath,
    stderrPath,
    resultPath,
  });
  return outcome.status === "succeeded"
    ? { adapter: adapter.name, phase, status: "passed", reason: "minimal_invocation_parsed", probe }
    : { adapter: adapter.name, phase, status: "failed", reason: `parse_outcome_${outcome.status}`, detail: outcome.summary, probe };
}

function runCanaries({
  timeoutMs = 5000,
  env = process.env,
  adapters = listAdapters().map(getAdapter),
  spawn = spawnSync,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-live-canary-"));
  try {
    const repo = initializeRepo(root, spawn);
    const results = adapters.map((adapter) => runAdapterCanary(adapter, {
      root,
      repo,
      timeoutMs,
      env,
      spawn,
    }));
    return {
      generated_at: new Date().toISOString(),
      timeout_ms: timeoutMs,
      results,
      summary: {
        passed: results.filter((entry) => entry.status === "passed").length,
        skipped: results.filter((entry) => entry.status === "skipped").length,
        failed: results.filter((entry) => entry.status === "failed").length,
      },
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const timeoutArg = process.argv.indexOf("--timeout-ms");
  const outputArg = process.argv.indexOf("--output");
  const timeoutMs = timeoutArg >= 0 ? Number(process.argv[timeoutArg + 1]) : 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new Error("--timeout-ms must be an integer between 1 and 30000");
  }
  const report = {
    ...runCanaries({ timeoutMs }),
    generated_by: "skills/relay-dispatch/scripts/adapter-live-canary.js",
    command: `node skills/relay-dispatch/scripts/adapter-live-canary.js ${process.argv.slice(2).join(" ")}`.trim(),
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputArg >= 0) {
    const outputPath = process.argv[outputArg + 1];
    if (!outputPath || outputPath.startsWith("--")) throw new Error("--output requires a file path");
    fs.writeFileSync(path.resolve(outputPath), output, "utf8");
  }
  process.stdout.write(output);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  classifyInvocationFailure,
  runAdapterCanary,
  runCanaries,
};
