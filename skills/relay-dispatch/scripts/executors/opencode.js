const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROBE_PROMPT =
  "List ALL your available tools, MCP servers, and installed skills. " +
  "Output a JSON array of objects with {name, type, description} fields. " +
  "type is one of: skill, mcp_tool, built_in.";

const NOT_YET = "opencode executor is experimental and not yet wired up; see #377";

function validateExecutionMode(/* { sandbox, networkAccess } */) {
  return { ok: false, error: NOT_YET };
}

function buildExecCommand() {
  throw new Error(NOT_YET);
}

function finalizeResult(/* { stdoutLog, resultFile } */) {
  // safe no-op so dispatch.js can call this unconditionally
}

function register() {
  throw new Error(NOT_YET);
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

function probe({ timeout }) {
  const cmd = "opencode";

  // 1. Fast availability check via --version
  let version = null;
  try {
    version = execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
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
    if (result.error) {
      probeError = result.error.code === "ETIMEDOUT"
        ? `probe timed out after ${timeout}s`
        : result.error.message;
    } else if (result.status !== 0) {
      probeError = `executor exited with code ${result.status}`;
    } else {
      probeOutput = (result.stdout || "").trim() || null;
    }
  }

  // Compose the raw payload as a JSON string so existing consumers reading `raw` still get text.
  const raw = JSON.stringify({
    version,
    config_path: configPath,
    auth_list: authList,
    probe_output: probeOutput,
    probe_error: probeError,
    warnings,
  });

  return { error: probeError, raw };
}

module.exports = {
  cliBinary: "opencode",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
};
