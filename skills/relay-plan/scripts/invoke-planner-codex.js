#!/usr/bin/env node
/**
 * Invoke Codex as an isolated structured planner.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--prompt-file", "--model", "--json", "--help", "-h"];
const { getArg, hasFlag } = bindCliArgs(args, { reservedFlags: KNOWN_FLAGS });

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

if (!args.length || hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-planner-codex.js --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(hasFlag(["--help", "-h"]) ? 0 : 1);
}

function summarizeFailure(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function readNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8").trim();
  return text || null;
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
  const promptFile = getArg("--prompt-file");
  const model = getArg("--model");
  const codexBin = process.env.RELAY_CODEX_BIN || "codex";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-codex-work-"));
  const schemaPath = path.join(workDir, "planner-schema.json");
  const resultPath = path.join(workDir, "planner-result.json");

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(PLANNER_RESULT_JSON_SCHEMA, null, 2)}\n`, "utf-8");

    const fullPrompt = [
      "[NON-INTERACTIVE PLAN]",
      "Draft the requested relay-plan artifacts and return only JSON matching the supplied schema.",
      "Do not wrap the response in markdown fences.",
      "You do not need repository write access; produce text outputs only.",
      "",
      promptText,
    ].join("\n");

    const execArgs = [
      "exec",
      "-C", workDir,
      "--skip-git-repo-check",
      "--ephemeral",
      "--full-auto",
      "--sandbox", "workspace-write",
      "--color", "never",
      "--output-schema", schemaPath,
      "-o", resultPath,
    ];
    if (model) execArgs.push("-m", model);
    execArgs.push(fullPrompt);

    try {
      execFileSync(codexBin, execArgs, {
        cwd: workDir,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const recovered = readNonEmptyFile(resultPath);
      if (!recovered) {
        throw new Error(`Codex planner failed: ${summarizeFailure(error)}`);
      }
    }

    const result = readNonEmptyFile(resultPath);
    if (!result) {
      throw new Error("Codex planner did not produce a structured result");
    }
    ensurePlannerJson(result, "Codex planner");
    if (hasFlag("--json")) {
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
