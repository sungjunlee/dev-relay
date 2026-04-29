#!/usr/bin/env node
/**
 * Invoke Codex as an isolated structured reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { summarizeFailure, ensureJsonText } = require("./reviewer-helpers");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-codex",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-codex.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function readNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8").trim();
  return text || null;
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const codexBin = process.env.RELAY_CODEX_BIN || "codex";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const schemaPath = path.join(os.tmpdir(), `relay-review-schema-${process.pid}-${Date.now()}.json`);
  const resultPath = path.join(os.tmpdir(), `relay-review-codex-${process.pid}-${Date.now()}.json`);

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA, null, 2)}\n`, "utf-8");

    const fullPrompt = [
      "[NON-INTERACTIVE REVIEW]",
      "Review the provided bundle and return only JSON matching the supplied schema.",
      "Do not wrap the response in markdown fences.",
      "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
      "You have read-only access to the full codebase.",
      "",
      promptText,
    ].join("\n");

    const execArgs = [
      "exec",
      "-C", repoPath,
      "--ephemeral",
      "--sandbox", "read-only",
      "--color", "never",
      "--output-schema", schemaPath,
      "-o", resultPath,
    ];
    if (model) execArgs.push("-m", model);
    execArgs.push(fullPrompt);

    try {
      execFileSync(codexBin, execArgs, {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const recovered = readNonEmptyFile(resultPath);
      if (!recovered) {
        throw new Error(`Codex reviewer failed: ${summarizeFailure(error)}`);
      }
    }

    const result = readNonEmptyFile(resultPath);
    if (!result) {
      throw new Error("Codex reviewer did not produce a structured result");
    }
    ensureJsonText(result, "Codex reviewer");
    if (cliArgs.hasFlag("--json")) {
      console.log(result);
    } else {
      process.stdout.write(result);
    }
  } finally {
    try { fs.unlinkSync(schemaPath); } catch {}
    try { fs.unlinkSync(resultPath); } catch {}
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
