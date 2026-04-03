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

function main() {
  const repoPath = path.resolve(getArg("--repo") || ".");
  const promptFile = getArg("--prompt-file");
  const model = getArg("--model");

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
      "--sandbox", "read-only",
      "--color", "never",
      "--output-schema", schemaPath,
      "-o", resultPath,
    ];
    if (model) execArgs.push("-m", model);
    execArgs.push(fullPrompt);

    execFileSync("codex", execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    });

    const result = fs.readFileSync(resultPath, "utf-8").trim();
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
