#!/usr/bin/env node
/**
 * Invoke Claude Code as an isolated structured reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REVIEW_VERDICT_JSON_SCHEMA } = require("./review-schema");
const { getArg: sharedGetArg, hasFlag: sharedHasFlag } = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: invoke-reviewer-claude.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, { reservedFlags: KNOWN_FLAGS });
const hasFlag = (flag) => sharedHasFlag(args, flag);

function summarizeFailure(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function ensureJsonText(text, label) {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function main() {
  const repoPath = path.resolve(getArg("--repo") || ".");
  const promptFile = getArg("--prompt-file");
  const model = getArg("--model");
  const claudeBin = process.env.RELAY_CLAUDE_BIN || "claude";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = [
    "Review the provided bundle and return only JSON matching the supplied schema.",
    "Do not wrap the response in markdown fences.",
    "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
    "You have read-only access to the full codebase.",
    "",
    promptText,
  ].join("\n");

  const execArgs = [
    "-p",
    "--bare",
    "--no-session-persistence",
    "--output-format", "text",
    "--json-schema", JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA),
    "--allowedTools=Read",
  ];
  if (model) execArgs.push("--model", model);
  execArgs.push(fullPrompt);

  let result;
  try {
    result = execFileSync(claudeBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const recovered = String(error.stdout || "").trim();
    if (!recovered) {
      throw new Error(`Claude reviewer failed: ${summarizeFailure(error)}`);
    }
    result = recovered;
  }

  if (!result) {
    throw new Error("Claude reviewer did not produce a structured result");
  }
  ensureJsonText(result, "Claude reviewer");

  if (hasFlag("--json")) {
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
