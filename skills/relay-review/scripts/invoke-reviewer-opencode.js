#!/usr/bin/env node
/**
 * Invoke opencode as a structured advisory reviewer.
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
  summarizeFailure,
} = require("./reviewer-helpers");
const { parseAdvisoryReview } = require("./advisory-review-schema");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-opencode",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-opencode.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const opencodeBin = process.env.RELAY_OPENCODE_BIN || "opencode";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = [
    "[NON-INTERACTIVE ADVISORY REVIEW]",
    "Return only JSON matching the advisory review shape in the prompt.",
    "Do not wrap the response in markdown fences.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "",
    promptText,
  ].join("\n");

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
      throw new Error(`opencode advisory reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    throw new Error("opencode advisory reviewer did not produce a structured result");
  }
  const parsed = parseAdvisoryReview(result, {
    adapter: "opencode",
    phase: "advisory_review",
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
