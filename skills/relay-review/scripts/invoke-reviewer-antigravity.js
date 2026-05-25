#!/usr/bin/env node
/**
 * Invoke Google Antigravity CLI as an isolated structured primary reviewer.
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
  parseReviewerJsonObject,
  recoverExecStdout,
  summarizeFailure,
} = require("./reviewer-helpers");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-antigravity",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-antigravity.js --repo <path> --prompt-file <path> [--model <route>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <route>      ${modeLabel("--model")} Policy route label; not passed to agy`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const agyBin = process.env.RELAY_ANTIGRAVITY_BIN || "agy";
  const printTimeout = process.env.RELAY_ANTIGRAVITY_REVIEW_TIMEOUT || "1800s";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = [
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

  const execArgs = [
    "--print",
    "--print-timeout", printTimeout,
    "--sandbox",
    fullPrompt,
  ];

  let result;
  try {
    result = execFileSync(agyBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const recovered = recoverExecStdout(error);
    if (!recovered) {
      throw new Error(`Antigravity reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    throw new Error("Antigravity reviewer did not produce a structured result");
  }
  parseReviewerJsonObject(result, {
    adapter: "antigravity",
    phase: "primary_review",
    description: "review verdict",
  });

  if (cliArgs.hasFlag("--json")) {
    console.log(result);
  } else {
    process.stdout.write(result);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
