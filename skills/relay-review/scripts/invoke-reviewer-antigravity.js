#!/usr/bin/env node
/**
 * Invoke Google Antigravity CLI as an isolated structured primary or advisory reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  parseReviewerVerdictObject,
  recoverExecStdout,
  summarizeFailure,
} = require("./reviewer-helpers");
const {
  parseAdvisoryReview,
  validateAdvisoryProfile,
  writeAdvisorySchemaFailure,
} = require("./advisory-review-schema");
const {
  assertControlSafeArgv,
  createPromptFileReference,
} = require("./reviewer-prompt-transport");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--profile", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-antigravity",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-antigravity.js --repo <path> --prompt-file <path> [--phase <name>] [--model <route>] [--profile <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <route>      ${modeLabel("--model")} Policy route label; not passed to agy`);
  console.log(`  --phase <name>       ${modeLabel("--phase")} primary_review or advisory_review`);
  console.log(`  --profile <name>     ${modeLabel("--profile")} Advisory profile, defaults to blindspot`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function resolvePhase(value) {
  const phase = String(value || "primary_review").trim();
  if (phase !== "primary_review" && phase !== "advisory_review") {
    throw new Error(`--phase must be primary_review or advisory_review, got ${JSON.stringify(value)}`);
  }
  return phase;
}

function readAdvisoryProfileArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--profile") {
      const value = argv[index + 1];
      return value && !String(value).startsWith("--") ? value : undefined;
    }
    if (token.startsWith("--profile=")) return token.slice("--profile=".length);
  }
  return undefined;
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

function worktreeMutationMessage(repoPath, beforeStatus, phase) {
  const afterStatus = readWorktreeStatus(repoPath);
  if (afterStatus === beforeStatus) return "";
  return (
    `Antigravity reviewer ${phase} mutated the worktree while running in read-only review mode. ` +
    `Before git status: ${summarizeStatus(beforeStatus)}. ` +
    `After git status: ${summarizeStatus(afterStatus)}.`
  );
}

function buildPrompt(promptText, phase) {
  if (phase === "advisory_review") {
    return [
      "[NON-INTERACTIVE ADVISORY REVIEW]",
      "Return only JSON matching the advisory review shape in the prompt.",
      "Do not wrap the response in markdown fences.",
      "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
      "Relay will check git status after this process and record any worktree mutation as a policy violation.",
      "",
      promptText,
    ].join("\n");
  }
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

function parseResult(result, phase, profile) {
  if (phase === "advisory_review") {
    return parseAdvisoryReview(result, {
      adapter: "antigravity",
      phase,
      profile,
    });
  }
  return parseReviewerVerdictObject(result, {
    adapter: "antigravity",
    phase,
    description: "review verdict",
  });
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const phase = resolvePhase(cliArgs.getArg("--phase", "primary_review"));
  const advisoryProfile = phase === "advisory_review"
    ? validateAdvisoryProfile(readAdvisoryProfileArg(args) || "blindspot")
    : "blindspot";
  const agyBin = process.env.RELAY_ANTIGRAVITY_BIN || "agy";
  const printTimeout = String(process.env.RELAY_ANTIGRAVITY_REVIEW_TIMEOUT || "1800s").trim();
  const parentTimeoutMs = parsePrintTimeoutMs(printTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText, phase);
  const beforeStatus = readWorktreeStatus(repoPath);
  const promptTransport = createPromptFileReference({
    adapter: "antigravity",
    prompt: fullPrompt,
    promptFile,
  });

  const execArgs = [
    "--add-dir", promptTransport.directory,
    "--prompt", promptTransport.argvReference,
    "--print-timeout", printTimeout,
    "--sandbox",
  ];
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
    const mutationMessage = worktreeMutationMessage(repoPath, beforeStatus, phase);
    if (isExecTimeout(error)) {
      throw new Error(
        `Antigravity reviewer ${phase} timed out after ${printTimeout} (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT). ` +
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
    throw new Error(`Antigravity reviewer ${phase} did not produce a structured result`);
  }
  const mutationMessage = worktreeMutationMessage(repoPath, beforeStatus, phase);
  if (mutationMessage) {
    throw new Error(mutationMessage);
  }
  const parsed = parseResult(result, phase, advisoryProfile);
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
  writeAdvisorySchemaFailure(error);
  process.exit(1);
}
