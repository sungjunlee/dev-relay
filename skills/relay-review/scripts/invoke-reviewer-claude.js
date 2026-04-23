#!/usr/bin/env node
/**
 * Invoke Claude Code as an isolated structured reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const {
  getArg: sharedGetArg,
  hasFlag: sharedHasFlag,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { summarizeFailure, ensureJsonText } = require("./reviewer-helpers");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = { commandName: "invoke-reviewer-claude", reservedFlags: KNOWN_FLAGS };
const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, CLI_ARG_OPTIONS);
const hasFlag = (flag) => sharedHasFlag(args, flag, CLI_ARG_OPTIONS);
const CLAUDE_AUTH_PATTERNS = [/not logged/i, /please run \/login/i];

if (!args.length || hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-claude.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(hasFlag(["--help", "-h"]) ? 0 : 1);
}

function isClaudeBareAuthError(text) {
  const normalized = String(text || "").trim();
  return normalized ? CLAUDE_AUTH_PATTERNS.some((pattern) => pattern.test(normalized)) : false;
}

function buildClaudeAuthError() {
  return new Error(
    "claude --bare mode is not authenticated. It uses a separate token from the interactive Claude OAuth session. Set ANTHROPIC_API_KEY or run `claude login --api-key` before using `--reviewer claude` (directly or via reviewer-swap). See skills/relay-review/SKILL.md."
  );
}

function probeClaudeAuth(claudeBin, repoPath) {
  const probeArgs = ["-p", "--bare", "--no-session-persistence", "ping"];
  let probeOutput;

  try {
    probeOutput = execFileSync(claudeBin, probeArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    const output = [String(error.stdout || ""), String(error.stderr || ""), error.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (isClaudeBareAuthError(output)) {
      throw buildClaudeAuthError();
    }
    throw new Error(`Claude reviewer auth probe failed: ${summarizeFailure(error)}`);
  }

  if (isClaudeBareAuthError(probeOutput)) {
    throw buildClaudeAuthError();
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

  probeClaudeAuth(claudeBin, repoPath);

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
    "--json-schema", JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA),
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
