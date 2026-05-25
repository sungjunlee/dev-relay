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
const { parseAdvisoryReview } = require("./advisory-review-schema");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-opencode",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-opencode.js --repo <path> --prompt-file <path> [--phase <name>] [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --phase <name>       ${modeLabel("--phase")} primary_review or advisory_review`);
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

function parseResult(result, phase) {
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
    profile: "blindspot",
  });
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const phase = resolvePhase(cliArgs.getArg("--phase", "advisory_review"));
  const opencodeBin = process.env.RELAY_OPENCODE_BIN || "opencode";

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
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`opencode ${phase} reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    throw new Error(`opencode ${phase} reviewer did not produce a structured result`);
  }
  const parsed = parseResult(result, phase);
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
