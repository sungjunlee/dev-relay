#!/usr/bin/env node
/**
 * Invoke Pi as an isolated structured primary or advisory reviewer.
 */

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
const { parseAdvisoryReview, validateAdvisoryProfile } = require("./advisory-review-schema");
const {
  execFileSyncWithStdinPrompt,
} = require("./reviewer-prompt-transport");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--profile", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-pi",
  reservedFlags: KNOWN_FLAGS,
});
const REVIEW_TIMEOUT_ENV = "RELAY_PI_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-pi.js --repo <path> --prompt-file <path> [--phase <name>] [--model <name>] [--profile <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
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

function buildTimeoutDiagnosticCommand({ piBin, reviewTimeout }) {
  const duration = String(reviewTimeout || DEFAULT_REVIEW_TIMEOUT).trim() || DEFAULT_REVIEW_TIMEOUT;
  return [
    "timeout",
    duration,
    piBin || "pi",
    "--no-session",
    "--no-context-files",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--print",
    "'Return exactly {\"ok\":true} and nothing else.'",
  ].join(" ");
}

function buildPrompt(promptText, phase) {
  if (phase === "advisory_review") {
    return [
      "[NON-INTERACTIVE ADVISORY REVIEW]",
      "Return only JSON matching the advisory review shape in the prompt.",
      "Do not wrap the response in markdown fences.",
      "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
      "",
      promptText,
    ].join("\n");
  }
  return [
    "[NON-INTERACTIVE REVIEW]",
    "Review the provided bundle and return only raw JSON matching this schema:",
    JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA),
    "The first byte of your response must be `{` and the last byte must be `}`.",
    "Do not wrap the response in markdown fences.",
    "Do not include prose, analysis, acknowledgements, or explanations outside the JSON object.",
    "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
    "You have read-only access to the full codebase via read, grep, find, and ls tools.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "",
    promptText,
  ].join("\n");
}

function parseResult(result, phase, profile) {
  if (phase === "advisory_review") {
    return parseAdvisoryReview(result, {
      adapter: "pi",
      phase,
      profile,
    });
  }
  return parseReviewerVerdictObject(result, {
    adapter: "pi",
    phase,
    description: "review verdict",
  });
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const phase = resolvePhase(cliArgs.getArg("--phase", "primary_review"));
  const advisoryProfile = phase === "advisory_review"
    ? validateAdvisoryProfile(readAdvisoryProfileArg(args) || "blindspot")
    : "blindspot";
  const piBin = process.env.RELAY_PI_BIN || "pi";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText, phase);

  const execArgs = [
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools", "read,grep,find,ls",
  ];
  if (model) execArgs.push("--model", model);
  execArgs.push("--print");

  let result;
  try {
    result = execFileSyncWithStdinPrompt(piBin, execArgs, {
      adapter: "pi",
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
      const diagnosticCommand = buildTimeoutDiagnosticCommand({ piBin, reviewTimeout });
      throw new Error(
        `Pi reviewer ${phase} timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The pi --print invocation did not return before the parent-process timeout, so relay cannot treat this as healthy review evidence. " +
        `First verify Pi non-interactive auth/provider health with: ${diagnosticCommand}. ` +
        "If that minimal command also times out, record this as a Pi CLI/provider non-interactive blocker; otherwise retry with a larger review timeout or split the review scope."
      );
    }
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`Pi reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    throw new Error(`Pi reviewer ${phase} did not produce a structured result`);
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
  process.exit(1);
}
