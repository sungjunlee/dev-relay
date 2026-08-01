#!/usr/bin/env node
/**
 * Invoke OpenCode as a structured primary reviewer.
 */

const fs = require("fs");
const path = require("path");
const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel: formatCliModeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  recoverExecStdout,
  parseReviewerVerdictObject,
  summarizeFailure,
} = require("./reviewer-helpers");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const { opencodeReviewArgs } = require("./reviewer-control-invocations");
const {
  execFileSyncWithStdinPrompt,
} = require("./reviewer-prompt-transport");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--prompt-file"],
};
const unknownFlags = findUnknownFlags(args, CLI_ARG_OPTIONS);
if (unknownFlags.length) throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);
const REVIEW_TIMEOUT_ENV = "RELAY_OPENCODE_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-opencode.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${formatCliModeLabel("--repo", CLI_ARG_OPTIONS)} Repository root`);
  console.log(`  --prompt-file <path> ${formatCliModeLabel("--prompt-file", CLI_ARG_OPTIONS)} Prompt bundle path`);
  console.log(`  --model <name>       ${formatCliModeLabel("--model", CLI_ARG_OPTIONS)} Model override`);
  console.log(`  --json               ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function parseReviewTimeoutMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(
      `${REVIEW_TIMEOUT_ENV} must be a positive duration like 120s, got ${JSON.stringify(value)}`
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
  const timeoutMs = amount * multipliers[unit];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `${REVIEW_TIMEOUT_ENV} must resolve to a safe positive millisecond timeout, got ${JSON.stringify(value)}`
    );
  }
  return timeoutMs;
}

function isExecTimeout(error) {
  return error?.code === "ETIMEDOUT" || (error?.signal === "SIGKILL" && error?.killed);
}

function buildPrompt(promptText) {
  return [
    "[NON-INTERACTIVE REVIEW]",
    "Review the provided bundle and return only raw JSON matching this schema:",
    JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA),
    "The first byte of your response must be `{` and the last byte must be `}`.",
    "Do not wrap the response in markdown fences.",
    "Do not include prose, analysis, acknowledgements, or explanations outside the JSON object.",
    "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "",
    promptText,
  ].join("\n");
}

function parseResult(result) {
  return parseReviewerVerdictObject(result, {
    adapter: "opencode",
    phase: "primary_review",
    description: "review verdict",
  });
}

function buildEmptyOutputDiagnosticCommand({ opencodeBin, model }) {
  const prompt = "Return exactly {\"verdict\":\"pass\",\"summary\":\"ok\",\"contract_status\":\"pass\",\"quality_review_status\":\"pass\",\"next_action\":\"ready_to_merge\",\"issues\":[],\"rubric_scores\":[],\"scope_drift\":{\"creep\":[],\"missing\":[]}} and nothing else.";
  const command = [opencodeBin || "opencode", "run"];
  if (model) command.push("-m", model);
  command.push(JSON.stringify(prompt));
  return command.join(" ");
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const opencodeBin = process.env.RELAY_OPENCODE_BIN || "opencode";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText);

  const execArgs = opencodeReviewArgs({ model });

  let result;
  try {
    result = execFileSyncWithStdinPrompt(opencodeBin, execArgs, {
      adapter: "opencode",
      prompt: fullPrompt,
      promptFile,
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: parentTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      const diagnosticCommand = buildEmptyOutputDiagnosticCommand({ opencodeBin, model });
      throw new Error(
        `opencode primary reviewer timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The opencode run invocation did not return before the parent-process timeout, so relay cannot treat this as healthy review evidence. " +
        `First verify OpenCode non-interactive model/provider output with: ${diagnosticCommand}. ` +
        "If that minimal command also times out, record this as an OpenCode CLI/provider non-interactive blocker; otherwise retry with a larger review timeout or split the review scope."
      );
    }
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`opencode primary reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    const diagnosticCommand = buildEmptyOutputDiagnosticCommand({ opencodeBin, model });
    throw new Error(
      `opencode primary reviewer produced empty stdout, so relay cannot treat this as healthy review evidence. ` +
      `First verify OpenCode non-interactive model/provider output with: ${diagnosticCommand}. ` +
      "If that minimal command is also empty, record this as an OpenCode CLI/provider non-interactive blocker; otherwise tighten the review prompt or increase the live dogfood command timeout."
    );
  }
  const parsed = parseResult(result);
  const output = JSON.stringify(parsed);

  if (cliArgs.hasFlag("--json")) {
    console.log(output);
  } else {
    process.stdout.write(output);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
