const { createNativeAdapter } = require("../adapter-contract");
const MAX_ARGV_BYTES = 256 * 1024;

function boundedArgv(args) {
  const bytes = args.reduce((total, value) => total + Buffer.byteLength(value, "utf8") + 1, 0);
  if (bytes >= MAX_ARGV_BYTES) {
    throw new Error("antigravity argv exceeds the conservative 256 KiB limit; its prompt transport is visible in the process list");
  }
  return args;
}

function validateDispatch({ networkAccess }) {
  void networkAccess; const warnings = [];
  return { ok: true, warnings };
}

function worktreePrompt(cwd, prompt) {
  return ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, `Before doing anything, run: cd ${cwd}`, "Create and edit source files only in that repository worktree. You may inspect git status, but do not run git add, git commit, git push, or create a PR; canonical relay recovery owns Git metadata and publication.", "Do not create, edit, or report source files under ~/.gemini, scratch directories, or any path outside the repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
}

function antigravityParseFailure(outcome, message) {
  return Object.freeze({ ...outcome, status: "failed", summary: `Antigravity JSON envelope ${message}`, output: null });
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const native = createNativeAdapter({
  name: "antigravity",
  timeoutMs: 1800000,
  outputProtocol: "json_result",
  metadata: { cliBinary: "agy", cliBinaryEnv: "RELAY_ANTIGRAVITY_BIN", outputProtocol: "json_success_envelope", providerDefault: "google", providerFromModel: true, promptTransport: "argv_visible", processContainment: "inherited_scope_no_daemon", providerTransport: "remote_required", runtimeDependencies: { executableParent: null, interpreterParent: null }, promptTransportWarning: "prompt content is visible in the local process list; bounded to less than 256 KiB" },
  phases: {
    // `agy --sandbox` does not provide a verifiable tool-network block.
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", filesystemIsolation: "declaration_only", loopbackListen: "unknown", cancellation: "process", structuredOutput: "json" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", filesystemIsolation: "declaration_only", loopbackListen: "unknown", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, prompt, timeoutSeconds }) {
    const args = ["--prompt", worktreePrompt(cwd, prompt), "--print-timeout", `${timeoutSeconds}s`, "--mode", "accept-edits", "--output-format", "json", "--disable-slash-commands", "--sandbox"];
    return { command: process.env.RELAY_ANTIGRAVITY_BIN || "agy", args: boundedArgv(args), cwd };
  },
  buildReview({ cwd, prompt, schemaPath, timeoutSeconds }) {
    if (!schemaPath) throw new Error("antigravity primary review requires a staged JSON schema");
    return {
      command: process.env.RELAY_ANTIGRAVITY_BIN || "agy",
      args: boundedArgv([
        "--add-dir", cwd,
        "--prompt", prompt,
        "--print-timeout", `${timeoutSeconds}s`,
        "--output-format", "json",
        "--json-schema", schemaPath,
        "--mode", "plan",
        "--sandbox",
      ]),
      cwd,
    };
  },
});

function parseOutcome(input) {
  const outcome = native.parseOutcome(input);
  if (outcome.status !== "succeeded") return outcome;
  const envelope = outcome.output;
  if (!isJsonObject(envelope)) return antigravityParseFailure(outcome, "must be a JSON object");
  if (envelope.status !== "SUCCESS") return antigravityParseFailure(outcome, "must have status SUCCESS");
  const review = input.phase === "primary_review";
  if (review && !isJsonObject(envelope.structured_output)) {
    return antigravityParseFailure(outcome, "primary review must have object structured_output");
  }
  const output = review ? envelope.structured_output : envelope;
  return Object.freeze({ ...outcome, summary: JSON.stringify(output).slice(0, 500), output });
}

module.exports = Object.freeze({ ...native, parseOutcome });
