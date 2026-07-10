#!/usr/bin/env node
/**
 * Invoke OpenCode as a structured primary or advisory reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  recoverExecStdout,
  parseReviewerVerdictObject,
  summarizeFailure,
} = require("./reviewer-helpers");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("./advisory-review-schema");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--profile", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-opencode",
  reservedFlags: KNOWN_FLAGS,
});
const REVIEW_TIMEOUT_ENV = "RELAY_OPENCODE_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-opencode.js --repo <path> --prompt-file <path> [--phase <name>] [--model <name>] [--profile <name>] [--json]");
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
  const phase = String(value || "advisory_review").trim();
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

function buildPrompt(promptText, phase) {
  if (phase === "primary_review") {
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
  return [
    "[NON-INTERACTIVE ADVISORY REVIEW]",
    "Return only JSON matching the advisory review shape in the prompt.",
    "Do not wrap the response in markdown fences.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "",
    promptText,
  ].join("\n");
}

function parseResult(result, phase, profile) {
  if (phase === "primary_review") {
    return parseReviewerVerdictObject(result, {
      adapter: "opencode",
      phase,
      description: "review verdict",
    });
  }
  return parseAdvisoryReview(result, {
    adapter: "opencode",
    phase,
    profile,
  });
}

function buildEmptyOutputDiagnosticCommand({ opencodeBin, model, phase }) {
  const prompt = phase === "primary_review"
    ? "Return exactly {\"verdict\":\"pass\",\"summary\":\"ok\",\"contract_status\":\"pass\",\"quality_review_status\":\"pass\",\"next_action\":\"ready_to_merge\",\"issues\":[],\"rubric_scores\":[],\"scope_drift\":{\"creep\":[],\"missing\":[]}} and nothing else."
    : "Return exactly {\"profile\":\"blindspot\",\"summary\":\"ok\",\"required_findings\":[],\"advisory_findings\":[],\"duplicate_or_low_confidence\":[]} and nothing else.";
  const command = [opencodeBin || "opencode", "run"];
  if (model) command.push("-m", model);
  command.push(JSON.stringify(prompt));
  return command.join(" ");
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const phase = resolvePhase(cliArgs.getArg("--phase", "advisory_review"));
  const advisoryProfile = phase === "advisory_review"
    ? validateAdvisoryProfile(readAdvisoryProfileArg(args) || "blindspot")
    : "blindspot";
  const opencodeBin = process.env.RELAY_OPENCODE_BIN || "opencode";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText, phase);

  const execArgs = ["run"];
  if (model) execArgs.push("-m", model);
  execArgs.push(fullPrompt);

  let result;
  try {
    result = execFileSync(opencodeBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: parentTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      const diagnosticCommand = buildEmptyOutputDiagnosticCommand({ opencodeBin, model, phase });
      throw new Error(
        `opencode ${phase} reviewer timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The opencode run invocation did not return before the parent-process timeout, so relay cannot treat this as healthy review evidence. " +
        `First verify OpenCode non-interactive model/provider output with: ${diagnosticCommand}. ` +
        "If that minimal command also times out, record this as an OpenCode CLI/provider non-interactive blocker; otherwise retry with a larger review timeout or split the review scope."
      );
    }
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`opencode ${phase} reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    const diagnosticCommand = buildEmptyOutputDiagnosticCommand({ opencodeBin, model, phase });
    throw new Error(
      `opencode ${phase} reviewer produced empty stdout, so relay cannot treat this as healthy review evidence. ` +
      `First verify OpenCode non-interactive model/provider output with: ${diagnosticCommand}. ` +
      "If that minimal command is also empty, record this as an OpenCode CLI/provider non-interactive blocker; otherwise tighten the review prompt or increase the live dogfood command timeout."
    );
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
