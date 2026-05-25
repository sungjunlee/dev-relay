const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  copyStdoutToResultFile,
  summarizeSpawnResult,
} = require("../agent-adapters/transport");

const PROBE_PROMPT =
  "List ALL your available tools, MCP servers, and installed skills. " +
  "Output a JSON array of objects with {name, type, description} fields. " +
  "type is one of: skill, mcp_tool, built_in.";

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
      `opencode executor: --sandbox '${sandbox}' is not enforced by opencode (no native sandboxing); proceeding with workspace-write semantics.`
    );
  }
  if (networkAccess === "enabled") {
    warnings.push(
      "opencode executor: --network-access 'enabled' is informational only; opencode does not gate network access at the executor level."
    );
  }
  warnings.push("opencode executor is experimental; review boundary defined in relay-dispatch/references/reviewer-policy-opencode.md.");
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, model }) {
  const cmd = "opencode";
  const args = ["run"];
  if (model) args.push("-m", model);
  args.push(prompt);
  return { cmd, args, cwd: wtPath, codexGitCommonDir: null };
}

function finalizeResult({ stdoutLog, resultFile }) {
  copyStdoutToResultFile({ adapter: "opencode", phase: "dispatch", stdoutLog, resultFile });
}

function register() {
  return { threadId: null, raw: { provider: "opencode", note: "no app registration surface" } };
}

function discoverConfigPath() {
  // opencode config locations (best-effort, no hard dependency)
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "config.json"),
    path.join(os.homedir(), ".opencode", "config.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function helpMentionsCommand(help, name) {
  return new RegExp(`(^|\\s)${name}(\\s|,|$)`).test(help);
}

function probe({ timeout }) {
  const cmd = "opencode";

  // 1. Fast availability check via --version
  let version = null;
  try {
    version = execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
  }

  let cliPath = null;
  try {
    const result = spawnSync("/bin/sh", ["-c", "command -v opencode"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (result.status === 0) cliPath = (result.stdout || "").trim() || null;
  } catch {}
  if (!cliPath) {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const candidate = path.join(dir, process.platform === "win32" ? "opencode.exe" : "opencode");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cliPath = candidate;
        break;
      } catch {}
    }
  }

  // 2. Try richer discovery; degrade gracefully if any sub-command is unavailable.
  const help = (() => {
    try {
      return execFileSync(cmd, ["--help"], { encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return null;
    }
  })();

  // List of commands documented in opencode README. If --help doesn't show one, surface a warning.
  const expectedFlags = ["run", "auth"];
  const warnings = [];
  if (help) {
    for (const flag of expectedFlags) {
      if (!help.includes(flag)) {
        warnings.push(`opencode --help does not mention '${flag}' (docs say it should)`);
      }
    }
  }

  const configPath = discoverConfigPath();

  // Best-effort provider/model listing. opencode auth list is documented.
  let authList = null;
  try {
    const result = spawnSync(cmd, ["auth", "list"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: Math.min(timeout, 30) * 1000,
    });
    if (result.status === 0) authList = (result.stdout || "").trim();
  } catch {}

  const discoveryProbes = [
    { name: "models", argv: ["models"] },
    { name: "providers", argv: ["providers"] },
    { name: "model", argv: ["model"] },
    { name: "list", argv: ["list"] },
  ];
  const discoveryResults = {};
  for (const { name, argv } of discoveryProbes) {
    if (help && helpMentionsCommand(help, name)) {
      try {
        const result = spawnSync(cmd, argv, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: Math.min(timeout, 30) * 1000,
        });
        if (result.status === 0) {
          discoveryResults[`${name}_output`] = (result.stdout || "").trim();
        } else {
          discoveryResults[`${name}_error`] =
            `exit ${result.status}: ${(result.stderr || "").trim().slice(0, 200)}`;
        }
      } catch (e) {
        discoveryResults[`${name}_error`] = e.message;
      }
    }
  }
  if (!help || (!helpMentionsCommand(help, "models") && !helpMentionsCommand(help, "providers"))) {
    warnings.push(
      "opencode --help does not expose models/providers discovery; provider state inferred from auth list only",
    );
  }

  // 3. Run the actual probe prompt against opencode if it has a `run` command. Time-boxed.
  // If this fails or times out, still return the version + auth info we collected.
  let probeOutput = null;
  let probeError = null;
  if (help && help.includes("run")) {
    const result = spawnSync(cmd, ["run", PROBE_PROMPT], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: timeout * 1000,
    });
    const summary = summarizeSpawnResult(result, {
      adapter: "opencode",
      phase: "dispatch_probe",
      timeoutSeconds: timeout,
    });
    if (summary) {
      probeError = summary;
    } else {
      probeOutput = (result.stdout || "").trim() || null;
    }
  }

  // Compose the raw payload as a JSON string so existing consumers reading `raw` still get text.
  const raw = JSON.stringify({
    version,
    cli_path: cliPath,
    config_path: configPath,
    auth_list: authList,
    ...discoveryResults,
    probe_output: probeOutput,
    probe_error: probeError,
    warnings,
  });

  // Match codex/claude probe semantics: any probe-run error returns raw=null so
  // consumers do not treat failed probe output as discovered tools.
  return { error: probeError, raw: probeError ? null : raw };
}

module.exports = {
  cliBinary: "opencode",
  providerDefault: "opencode-go",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
  parseProvider,
};
