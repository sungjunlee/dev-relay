#!/usr/bin/env node
/**
 * Invoke Claude Code as an isolated structured planner.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeFailure } = require("../../relay-dispatch/scripts/manifest/paths");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--prompt-file", "--model", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, { reservedFlags: KNOWN_FLAGS });

const PLANNER_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rubric_yaml: { type: "string" },
    dispatch_prompt_md: { type: "string" },
    planner_notes_md: { type: "string" },
  },
  required: ["rubric_yaml", "dispatch_prompt_md", "planner_notes_md"],
};

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-planner-claude.js --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function ensurePlannerJson(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }

  for (const field of PLANNER_RESULT_JSON_SCHEMA.required) {
    if (typeof parsed[field] !== "string") {
      throw new Error(`${label} JSON missing string field '${field}'`);
    }
  }
}

function main() {
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const claudeBin = process.env.RELAY_CLAUDE_BIN || "claude";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-claude-work-"));

  try {
    const fullPrompt = [
      "Draft the requested relay-plan artifacts and return only JSON matching the supplied schema.",
      "Do not wrap the response in markdown fences.",
      "You do not need repository write access; produce text outputs only.",
      "",
      promptText,
    ].join("\n");

    const execArgs = [
      "-p",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--output-format", "text",
      "--json-schema", JSON.stringify(PLANNER_RESULT_JSON_SCHEMA),
      "--tools", "",
    ];
    if (model) execArgs.push("--model", model);
    execArgs.push(fullPrompt);

    let result;
    try {
      result = execFileSync(claudeBin, execArgs, {
        cwd: workDir,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch (error) {
      const recovered = String(error.stdout || "").trim();
      if (!recovered) {
        throw new Error(`Claude planner failed: ${summarizeFailure(error)}`);
      }
      result = recovered;
    }

    if (!result) {
      throw new Error("Claude planner did not produce a structured result");
    }
    ensurePlannerJson(result, "Claude planner");

    if (cliArgs.hasFlag("--json")) {
      console.log(result);
    } else {
      process.stdout.write(result);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
