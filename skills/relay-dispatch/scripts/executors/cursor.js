const { execFileSync } = require("child_process");
const {
  copyStdoutToResultFile,
} = require("../agent-adapters/transport");

const PROBE_FLAGS = [
  "--print",
  "--trust",
  "--force",
  "--mode",
  "--sandbox",
  "--workspace",
  "--output-format",
  "--model",
  "--api-key",
];

function resolveAgentBin() {
  return process.env.RELAY_CURSOR_AGENT_BIN || "agent";
}

function parseProvider(model) {
  if (typeof model !== "string" || !model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  return model.slice(0, idx);
}

function validateExecutionMode({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox === "read-only") {
    return {
      ok: false,
      error: "cursor executor does not expose a relay read-only dispatch mode; use workspace-write or choose another executor",
    };
  }
  if (sandbox !== "workspace-write") {
    warnings.push(
      `cursor executor: --sandbox '${sandbox}' is not enforced by agent; proceeding with workspace-write semantics.`
    );
  }
  if (networkAccess === "enabled") {
    warnings.push(
      "cursor executor: --network-access 'enabled' is informational only; agent does not expose relay network gating."
    );
  }
  warnings.push(
    "cursor executor is optional experimental harness; relay uses --workspace and never agent --worktree."
  );
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, model, sandbox }) {
  const cmd = resolveAgentBin();
  const args = [
    "--print",
    "--trust",
    "--force",
    "--workspace", wtPath,
    "--output-format", "text",
  ];
  if (sandbox === "workspace-write") {
    args.push("--sandbox", "enabled");
  }
  if (model) args.push("--model", model);
  args.push(prompt);
  return { cmd, args, cwd: wtPath, codexGitCommonDir: null };
}

function finalizeResult({ stdoutLog, resultFile }) {
  return copyStdoutToResultFile({ adapter: "cursor", phase: "dispatch", stdoutLog, resultFile });
}

function register({ wtPath }) {
  const cmd = resolveAgentBin();
  try {
    const chatId = execFileSync(cmd, ["create-chat"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return {
      threadId: chatId || null,
      raw: { provider: "cursor", chatId },
    };
  } catch (error) {
    return {
      threadId: null,
      raw: { provider: "cursor", error: error.message },
    };
  }
}

function probe() {
  const cmd = resolveAgentBin();
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
    warnings.push(`agent --help failed: ${error.message}`);
  }

  const supportedFlags = PROBE_FLAGS.filter((flag) => help.includes(flag));
  const missingFlags = PROBE_FLAGS.filter((flag) => !supportedFlags.includes(flag));
  if (missingFlags.length) {
    warnings.push(`agent --help does not mention expected flags: ${missingFlags.join(", ")}`);
  }
  if (help.includes("--worktree")) {
    warnings.push("agent exposes --worktree; relay dispatch must use --workspace only to avoid colliding with relay worktrees.");
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
  cliBinary: "agent",
  providerDefault: "cursor",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
  parseProvider,
};
