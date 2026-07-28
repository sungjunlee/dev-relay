#!/usr/bin/env node
/**
 * Invoke Codex as an isolated structured reviewer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("./review-schema");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { parseReviewerJsonObject, summarizeFailure } = require("./reviewer-helpers");
const {
  execFileSyncWithStdinPrompt,
} = require("./reviewer-prompt-transport");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--json", "--help", "-h"];
const REVIEW_TIMEOUT_ENV = "RELAY_CODEX_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "900s";
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

function parseReviewTimeoutMs(value) {
  const text = String(value || DEFAULT_REVIEW_TIMEOUT).trim();
  const match = text.match(/^(\d+)(ms|s|m)?$/);
  if (!match) {
    throw new Error(`${REVIEW_TIMEOUT_ENV} must be a duration like 900s, 15m, or 60000ms`);
  }
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const multiplier = unit === "m" ? 60 * 1000 : unit === "s" ? 1000 : 1;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${REVIEW_TIMEOUT_ENV} must resolve to a positive timeout`);
  }
  return ms;
}

function isExecTimeout(error) {
  return error && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM" || error.signal === "SIGKILL");
}

/** Stable prefix of the Codex CLI usage-limit line (URL/time vary). */
const CODEX_USAGE_LIMIT_SIGNATURE = "You've hit your usage limit";

/**
 * If stdout/stderr contain an anchored CLI usage-limit error line, return it
 * (including the CLI's retry-at text). Otherwise null.
 */
function classifyCodexQuotaExhausted(error) {
  const combined = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
  const matchingLine = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("ERROR:") && line.includes(CODEX_USAGE_LIMIT_SIGNATURE));
  return matchingLine || null;
}

function writeRawResponse(filePath, error) {
  const stdout = String(error?.stdout || "").trim();
  const stderr = String(error?.stderr || "").trim();
  const text = stderr ? [stdout, "", "stderr:", stderr].filter(Boolean).join("\n") : stdout;
  fs.writeFileSync(filePath, `${text || "(no output)"}\n`, "utf-8");
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  const codexBin = process.env.RELAY_CODEX_BIN || "codex";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const schemaPath = path.join(os.tmpdir(), `relay-review-schema-${process.pid}-${Date.now()}.json`);
  const resultPath = path.join(os.tmpdir(), `relay-review-codex-${process.pid}-${Date.now()}.json`);
  const rawResponsePath = path.join(os.tmpdir(), `relay-review-codex-${process.pid}-${Date.now()}-raw-response.txt`);

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
    execArgs.push("-");

    try {
      execFileSyncWithStdinPrompt(codexBin, execArgs, {
        adapter: "codex",
        prompt: fullPrompt,
        promptFile,
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: parentTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      writeRawResponse(rawResponsePath, error);
      const quotaLine = classifyCodexQuotaExhausted(error);
      if (quotaLine) {
        throw new Error(
          `Codex reviewer primary_review failed; codex_quota_exhausted; model=${model || "default"}; ` +
          `raw_response=${rawResponsePath}; ${quotaLine}`
        );
      }
      if (isExecTimeout(error)) {
        throw new Error(
          `Codex reviewer primary_review timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}); ` +
          `model=${model || "default"}; raw_response=${rawResponsePath}`
        );
      }
      const recovered = readNonEmptyFile(resultPath);
      if (!recovered) {
        throw new Error(
          `Codex reviewer primary_review failed; model=${model || "default"}; ` +
          `raw_response=${rawResponsePath}; ${summarizeFailure(error)}`
        );
      }
    }

    const result = readNonEmptyFile(resultPath);
    if (!result) {
      throw new Error("Codex reviewer did not produce a structured result");
    }
    parseReviewerJsonObject(result, {
      adapter: "codex",
      phase: "primary_review",
      description: "review verdict",
    });
    if (cliArgs.hasFlag("--json")) {
      console.log(result);
    } else {
      process.stdout.write(result);
    }
  } finally {
    try { fs.unlinkSync(schemaPath); } catch {}
    try { fs.unlinkSync(resultPath); } catch {}
    if (fs.existsSync(rawResponsePath) && fs.statSync(rawResponsePath).size === 0) {
      try { fs.unlinkSync(rawResponsePath); } catch {}
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
