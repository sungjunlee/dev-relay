const { execFileSync } = require("child_process");
const {
  copyClineRunResultTextToResultFile,
} = require("../agent-adapters/cline-jsonl");

const PROBE_FLAGS = [
  "--json",
  "--cwd",
  "--provider",
  "--model",
  "--timeout",
];

function resolveClineBin() {
  return process.env.RELAY_CLINE_BIN || "cline";
}

function parseProvider(model) {
  if (typeof model !== "string" || !model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  return model.slice(0, idx);
}

function providerForModel(model) {
  return parseProvider(model) || "cline-pass";
}

function normalizeTimeoutSeconds(timeoutSeconds) {
  const value = Number(timeoutSeconds);
  if (Number.isFinite(value) && value > 0) return String(Math.floor(value));
  return "1800";
}

function validateExecutionMode({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") {
    warnings.push(
      `cline executor: --sandbox '${sandbox}' is not enforced by cline; proceeding with workspace-write semantics.`
    );
  }
  if (networkAccess === "enabled") {
    warnings.push(
      "cline executor: --network-access 'enabled' is informational only; cline does not expose relay network gating."
    );
  }
  warnings.push(
    "cline executor has no native relay sandbox; relay uses its own worktree boundary and never cline --worktree."
  );
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, model, timeoutSeconds }) {
  const cmd = resolveClineBin();
  const args = [
    "--json",
    "-P", providerForModel(model),
  ];
  if (model) args.push("-m", model);
  args.push(
    "--cwd", wtPath,
    "--timeout", normalizeTimeoutSeconds(timeoutSeconds),
    [
      "[RELAY WORKTREE BOUNDARY]",
      `Repository worktree: ${wtPath}`,
      "Run every shell command from that repository worktree.",
      "Do not read, write, git add, git commit, or create files outside that repository worktree.",
      "Do not use cline --worktree; relay already created and owns this worktree.",
      "",
      prompt,
    ].join("\n")
  );
  return { cmd, args, cwd: wtPath, codexGitCommonDir: null };
}

function finalizeResult({ stdoutLog, resultFile }) {
  return copyClineRunResultTextToResultFile({ adapter: "cline", phase: "dispatch", stdoutLog, resultFile });
}

function register() {
  return { threadId: null, raw: { provider: "cline", note: "no app registration surface" } };
}

function probe() {
  const cmd = resolveClineBin();
  let version;
  try {
    version = execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
  }

  let help = "";
  const warnings = [];
  try {
    help = execFileSync(cmd, ["--help"], { encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    warnings.push(`cline --help failed: ${error.message}`);
  }

  const supportedFlags = PROBE_FLAGS.filter((flag) => help.includes(flag));
  const missingFlags = PROBE_FLAGS.filter((flag) => !supportedFlags.includes(flag));
  if (missingFlags.length) {
    warnings.push(`cline --help does not mention expected flags: ${missingFlags.join(", ")}`);
  }
  if (help.includes("--worktree")) {
    warnings.push("cline exposes --worktree; relay dispatch must use --cwd only to avoid colliding with relay worktrees.");
  }

  return {
    error: null,
    raw: JSON.stringify({
      version,
      provider_default: "cline-pass",
      supported_flags: supportedFlags,
      missing_flags: missingFlags,
      warnings,
    }),
  };
}

module.exports = {
  cliBinary: "cline",
  providerDefault: "cline-pass",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
  parseProvider,
};
