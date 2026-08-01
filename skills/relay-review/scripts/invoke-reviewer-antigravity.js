#!/usr/bin/env node
/**
 * Invoke Google Antigravity CLI as an isolated structured primary reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const { antigravityReviewArgs } = require("./reviewer-control-invocations");
const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel: formatCliModeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  parseReviewerVerdictObject,
  recoverExecStdout,
  summarizeFailure,
} = require("./reviewer-helpers");
const {
  assertControlSafeArgv,
  createPromptFileReference,
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

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-antigravity.js --repo <path> --prompt-file <path> [--model <route>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${formatCliModeLabel("--repo", CLI_ARG_OPTIONS)} Repository root`);
  console.log(`  --prompt-file <path> ${formatCliModeLabel("--prompt-file", CLI_ARG_OPTIONS)} Prompt bundle path`);
  console.log(`  --model <route>      ${formatCliModeLabel("--model", CLI_ARG_OPTIONS)} Policy route label; not passed to agy`);
  console.log(`  --json               ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function parsePrintTimeoutMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(
      `RELAY_ANTIGRAVITY_REVIEW_TIMEOUT must be a positive duration like 120s, got ${JSON.stringify(value)}`
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
  const timeoutMs = amount * multipliers[unit];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `RELAY_ANTIGRAVITY_REVIEW_TIMEOUT must resolve to a safe positive millisecond timeout, got ${JSON.stringify(value)}`
    );
  }
  return timeoutMs;
}

function isExecTimeout(error) {
  return error?.code === "ETIMEDOUT" || (error?.signal === "SIGKILL" && error?.killed);
}

function readWorktreeStatus(repoPath) {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30_000,
  }).trim();
}

function summarizeStatus(status) {
  const text = String(status || "").trim();
  return text ? text.split(/\r?\n/).slice(0, 8).join("; ") : "(clean)";
}

function worktreeMutationMessage(repoPath, beforeStatus) {
  const afterStatus = readWorktreeStatus(repoPath);
  if (afterStatus === beforeStatus) return "";
  return (
    "Antigravity primary reviewer mutated the worktree while running in read-only review mode. " +
    `Before git status: ${summarizeStatus(beforeStatus)}. ` +
    `After git status: ${summarizeStatus(afterStatus)}.`
  );
}

function buildPrompt(promptText) {
  return [
    "[NON-INTERACTIVE REVIEW]",
    "Review the provided bundle and return only JSON matching this schema:",
    JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA),
    "Do not wrap the response in markdown fences.",
    "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "",
    promptText,
  ].join("\n");
}

function parseResult(result) {
  return parseReviewerVerdictObject(result, {
    adapter: "antigravity",
    phase: "primary_review",
    description: "review verdict",
  });
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const agyBin = process.env.RELAY_ANTIGRAVITY_BIN || "agy";
  const printTimeout = String(process.env.RELAY_ANTIGRAVITY_REVIEW_TIMEOUT || "1800s").trim();
  const parentTimeoutMs = parsePrintTimeoutMs(printTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText);
  const beforeStatus = readWorktreeStatus(repoPath);
  const promptTransport = createPromptFileReference({
    adapter: "antigravity",
    prompt: fullPrompt,
    promptFile,
  });

  const execArgs = antigravityReviewArgs({
    promptDirectory: promptTransport.directory,
    promptReference: promptTransport.argvReference,
    printTimeout,
  });
  assertControlSafeArgv(execArgs, { adapter: "antigravity", promptFile });

  let result;
  try {
    result = execFileSync(agyBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: parentTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const mutationMessage = worktreeMutationMessage(repoPath, beforeStatus);
    if (isExecTimeout(error)) {
      throw new Error(
        `Antigravity primary reviewer timed out after ${printTimeout} (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT). ` +
        "The agy --prompt invocation did not return before the parent-process timeout; retry with a larger timeout or split the review scope." +
        (mutationMessage ? ` ${mutationMessage}` : "")
      );
    }
    if (mutationMessage) {
      throw new Error(mutationMessage);
    }
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`Antigravity reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  } finally {
    promptTransport.cleanup();
  }

  if (!result) {
    throw new Error("Antigravity primary reviewer did not produce a structured result");
  }
  const mutationMessage = worktreeMutationMessage(repoPath, beforeStatus);
  if (mutationMessage) {
    throw new Error(mutationMessage);
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
