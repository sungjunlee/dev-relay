const { execFileSync } = require("child_process");
const {
  copyStdoutToResultFile,
} = require("../agent-adapters/transport");

const PROBE_FLAGS = [
  "--print",
  "--no-session",
  "--mode",
  "--tools",
  "--model",
  "--provider",
  "--thinking",
  "--no-context-files",
];

function normalizeThinking(reasoning) {
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high") return reasoning;
  if (reasoning === "xhigh") return "high";
  return null;
}

function parseProvider(model) {
  if (typeof model !== "string" || !model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  return model.slice(0, idx);
}

function validateExecutionMode({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") {
    warnings.push(
      `pi executor: --sandbox '${sandbox}' is not enforced by pi; proceeding with workspace-write semantics.`
    );
  }
  if (networkAccess === "enabled") {
    warnings.push(
      "pi executor: --network-access 'enabled' is informational only; pi does not gate network access at the executor level."
    );
  }
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, model, reasoning }) {
  const cmd = "pi";
  const args = ["--no-session"];
  if (model) args.push("--model", model);
  const thinking = normalizeThinking(reasoning);
  if (thinking) args.push("--thinking", thinking);
  args.push("--print", prompt);
  return { cmd, args, cwd: wtPath, codexGitCommonDir: null };
}

function finalizeResult({ stdoutLog, resultFile }) {
  return copyStdoutToResultFile({ adapter: "pi", phase: "dispatch", stdoutLog, resultFile });
}

function register() {
  return { threadId: null, raw: { provider: "pi", note: "no app registration surface" } };
}

function probe() {
  const cmd = "pi";
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
    warnings.push(`pi --help failed: ${error.message}`);
  }

  const supportedFlags = PROBE_FLAGS.filter((flag) => help.includes(flag));
  const missingFlags = PROBE_FLAGS.filter((flag) => !supportedFlags.includes(flag));
  if (missingFlags.length) {
    warnings.push(`pi --help does not mention expected flags: ${missingFlags.join(", ")}`);
  }

  return {
    error: null,
    raw: JSON.stringify({
      version,
      supported_flags: supportedFlags,
      missing_flags: missingFlags,
      warnings,
    }),
  };
}

module.exports = {
  cliBinary: "pi",
  providerDefault: "pi",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
  parseProvider,
};
