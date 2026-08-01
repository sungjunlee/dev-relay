const { createNativeAdapter } = require("../adapter-contract");

function binary() { return process.env.RELAY_CLINE_BIN || "cline"; }

function boundedArgv(args) {
  if (Buffer.byteLength(args.join("\0"), "utf8") >= 256 * 1024) {
    throw new Error("cline prompt argv exceeds the 256 KiB process list exposure bound");
  }
  return args;
}

function providerForModel(model) {
  if (typeof model !== "string") return "cline-pass";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "cline-pass";
}

function worktreePrompt(cwd, prompt) {
  return ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, "Run every shell command from that repository worktree.", "Do not read, write, git add, git commit, or create files outside that repository worktree.", "Do not use cline --worktree; relay already created and owns this worktree.", "", prompt].join("\n");
}

function validateDispatch({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`cline executor: --sandbox '${sandbox}' is not enforced by cline; proceeding with workspace-write semantics.`);
  if (networkAccess === "enabled") warnings.push("cline executor: --network-access 'enabled' is informational only; cline does not expose relay network gating.");
  warnings.push("cline executor has no native relay sandbox; relay uses its own worktree boundary and never cline --worktree.");
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "cline",
  timeoutMs: 1800000,
  outputProtocol: "jsonl_run_result",
  metadata: { cliBinary: "cline", cliBinaryEnv: "RELAY_CLINE_BIN", outputProtocol: "jsonl_run_result", providerDefault: "cline-pass", providerFromModel: true, resultErrorLabel: "Cline JSONL", reviewScript: null, promptTransport: "argv_visible", processContainment: "inherited_scope_no_daemon", promptTransportWarning: "installed CLI help declares only a positional prompt; prompt content is visible in the local process list and bounded to less than 256 KiB", credentials: { files: [], envHints: [] } },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "jsonl" },
    primary_review: { supported: false, reason: "Cline primary review remains blocked pending a strict live canary" },
  },
  validateDispatch,
  buildDispatch({ cwd, prompt, model, timeoutSeconds }) {
    const args = ["--json", "-P", providerForModel(model)];
    if (model) args.push("-m", model);
    args.push("--cwd", cwd, "--timeout", String(timeoutSeconds), worktreePrompt(cwd, prompt));
    return { command: binary(), args: boundedArgv(args), cwd };
  },
});
