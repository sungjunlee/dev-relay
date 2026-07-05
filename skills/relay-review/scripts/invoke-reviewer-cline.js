#!/usr/bin/env node
/**
 * Invoke Cline CLI as a structured advisory reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  extractClineRunResultText,
} = require("../../relay-dispatch/scripts/agent-adapters/cline-jsonl");
const {
  recoverExecStdout,
  summarizeFailure,
} = require("./reviewer-helpers");
const { parseAdvisoryReview } = require("./advisory-review-schema");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-cline",
  reservedFlags: KNOWN_FLAGS,
});
const REVIEW_TIMEOUT_ENV = "RELAY_CLINE_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-cline.js --repo <path> --prompt-file <path> [--phase advisory_review] [--model <route>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <route>      ${modeLabel("--model")} Model route, for example cline-pass/glm-5.2`);
  console.log(`  --phase <name>       ${modeLabel("--phase")} advisory_review only`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function resolvePhase(value) {
  const phase = String(value || "advisory_review").trim();
  if (phase !== "advisory_review") {
    throw new Error(
      `cline reviewer supports advisory_review only in the MVP; got ${JSON.stringify(value)}. Primary review requires separate live canary promotion.`
    );
  }
  return phase;
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

function timeoutSecondsFromDuration(value) {
  const raw = String(value || DEFAULT_REVIEW_TIMEOUT).trim();
  const match = raw.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) return "1800";
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return String(Math.max(1, Math.ceil(amount / 1000)));
  if (unit === "s") return String(amount);
  if (unit === "m") return String(amount * 60);
  return String(amount * 60 * 60);
}

function isExecTimeout(error) {
  return error?.code === "ETIMEDOUT" || (error?.signal === "SIGKILL" && error?.killed);
}

function providerForModel(model) {
  if (typeof model !== "string" || !model.trim()) return "cline-pass";
  const idx = model.indexOf("/");
  return idx > 0 ? model.slice(0, idx) : "cline-pass";
}

function buildTimeoutDiagnosticCommand({ clineBin, model, reviewTimeout }) {
  const command = [
    clineBin || "cline",
    "--json",
    "-P", providerForModel(model),
  ];
  if (model) command.push("-m", model);
  command.push(
    "--timeout", timeoutSecondsFromDuration(reviewTimeout),
    "'Return exactly {\"ok\":true} and nothing else.'"
  );
  return command.join(" ");
}

function buildPrompt(promptText) {
  return [
    "[NON-INTERACTIVE ADVISORY REVIEW]",
    "Return only JSON matching the advisory review shape in the prompt.",
    "Do not wrap the response in markdown fences.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "Do not use cline --worktree; relay already selected the review checkout with --cwd.",
    "",
    promptText,
  ].join("\n");
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const phase = resolvePhase(cliArgs.getArg("--phase", "advisory_review"));
  const clineBin = process.env.RELAY_CLINE_BIN || "cline";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText);

  const execArgs = [
    "--json",
    "-P", providerForModel(model),
  ];
  if (model) execArgs.push("-m", model);
  execArgs.push(
    "--cwd", repoPath,
    "--timeout", timeoutSecondsFromDuration(reviewTimeout),
    fullPrompt
  );

  let rawOutput;
  try {
    rawOutput = execFileSync(clineBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: parentTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      const diagnosticCommand = buildTimeoutDiagnosticCommand({ clineBin, model, reviewTimeout });
      throw new Error(
        `Cline reviewer ${phase} timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The cline --json invocation did not return before the parent-process timeout, so relay cannot treat this as healthy advisory evidence. " +
        `First verify Cline non-interactive provider output with: ${diagnosticCommand}. ` +
        "If that minimal command also times out, record this as a Cline CLI/provider non-interactive blocker; otherwise retry with a larger review timeout or split the review scope."
      );
    }
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`Cline reviewer failed: ${summarizeFailure(error)}`);
    }
    rawOutput = recovered;
  }

  let advisoryText;
  try {
    advisoryText = extractClineRunResultText(rawOutput, { adapter: "cline", phase });
  } catch (error) {
    throw new Error(
      `${error.message}. Cline advisory review must return JSON in run_result.text; relay cannot treat this as healthy advisory evidence.`
    );
  }

  const parsed = parseAdvisoryReview(advisoryText, {
    adapter: "cline",
    phase,
    profile: "blindspot",
  });
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
