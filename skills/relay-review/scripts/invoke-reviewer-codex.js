#!/usr/bin/env node
/**
 * Invoke Codex as an isolated structured reviewer.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REVIEW_VERDICT_JSON_SCHEMA } = require("./review-schema");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: invoke-reviewer-codex.js --repo <path> --prompt-file <path> [--model <name>] [--json]");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function getArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return KNOWN_FLAGS.includes(value) ? undefined : value;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function readNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8").trim();
  return text || null;
}

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
  const codexBin = process.env.RELAY_CODEX_BIN || "codex";

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const schemaPath = path.join(os.tmpdir(), `relay-review-schema-${process.pid}-${Date.now()}.json`);
  const resultPath = path.join(os.tmpdir(), `relay-review-codex-${process.pid}-${Date.now()}.json`);

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA, null, 2)}\n`, "utf-8");

    const fullPrompt = [
      "[NON-INTERACTIVE REVIEW]",
      "Review the provided bundle and return only JSON matching the supplied schema.",
      "Do not wrap the response in markdown fences.",
      "Prefer the provided diff and done criteria. Use read-only tools only if absolutely necessary.",
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
    if (hasFlag("--json")) {
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
