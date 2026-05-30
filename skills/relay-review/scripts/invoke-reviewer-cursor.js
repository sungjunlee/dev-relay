#!/usr/bin/env node
/**
 * Invoke Cursor Agent CLI as an isolated structured primary reviewer.
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
  parseReviewerVerdictObject,
  recoverExecStdout,
  summarizeFailure,
} = require("./reviewer-helpers");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-cursor",
  reservedFlags: KNOWN_FLAGS,
});
const REVIEW_TIMEOUT_ENV = "RELAY_CURSOR_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";
const CURSOR_AUTH_PATTERNS = [/not logged/i, /please run `agent login`/i, /authentication required/i];

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-cursor.js --repo <path> --prompt-file <path> [--model <name>] [--phase <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <name>       ${modeLabel("--model")} Model override passed to agent --model`);
  console.log(`  --phase <name>       ${modeLabel("--phase")} primary_review only`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function resolvePhase(value) {
  const phase = String(value || "primary_review").trim();
  if (phase !== "primary_review") {
    throw new Error(
      `cursor reviewer supports primary_review only; got ${JSON.stringify(value)}. Advisory review is not implemented for cursor.`
    );
  }
  return phase;
}

function parseReviewTimeoutMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([1-9]\d*)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(
      `${REVIEW_TIMEOUT_ENV} must be a positive duration like 120s, got ${JSON.stringify(value)}`
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
  const timeoutMs = amount * multipliers[unit];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `${REVIEW_TIMEOUT_ENV} must resolve to a safe positive millisecond timeout, got ${JSON.stringify(value)}`
    );
  }
  return timeoutMs;
}

function isExecTimeout(error) {
  return error?.code === "ETIMEDOUT" || (error?.signal === "SIGKILL" && error?.killed);
}

function isCursorAuthError(text) {
  const normalized = String(text || "").trim();
  return normalized ? CURSOR_AUTH_PATTERNS.some((pattern) => pattern.test(normalized)) : false;
}

function buildCursorAuthError() {
  return new Error(
    "Cursor Agent CLI is not authenticated. Set CURSOR_API_KEY or run `agent login` before using `--reviewer cursor`. See skills/relay-review/SKILL.md."
  );
}

function probeCursorAuth(agentBin, repoPath) {
  if (process.env.CURSOR_API_KEY) return;

  let probeOutput;
  try {
    probeOutput = execFileSync(agentBin, ["status"], {
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
    if (isCursorAuthError(output)) {
      throw buildCursorAuthError();
    }
    throw new Error(`Cursor reviewer auth probe failed: ${summarizeFailure(error)}`);
  }

  if (isCursorAuthError(probeOutput) || !/logged in/i.test(probeOutput)) {
    throw buildCursorAuthError();
  }
}

function buildPrompt(promptText) {
  return [
    "[NON-INTERACTIVE REVIEW]",
    "Review the provided bundle and return only JSON matching this schema:",
    JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA),
    "The first byte of your response must be `{` and the last byte must be `}`.",
    "Do not wrap the response in markdown fences.",
    "Do not include prose, analysis, acknowledgements, or explanations outside the JSON object.",
    "Start with the diff for overview. Then read callers/imports of changed functions to verify integration.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "",
    promptText,
  ].join("\n");
}

function extractCursorAgentResult(raw) {
  let wrapper;
  try {
    wrapper = JSON.parse(String(raw || "").trim());
  } catch (error) {
    throw new Error(`Cursor reviewer returned invalid JSON wrapper: ${error.message}`);
  }

  if (wrapper && typeof wrapper === "object" && wrapper.error) {
    throw new Error(`Cursor reviewer CLI error: ${String(wrapper.error)}`);
  }

  const result = wrapper?.result;
  if (typeof result === "string") {
    return result.trim();
  }
  if (result && typeof result === "object") {
    return JSON.stringify(result);
  }
  throw new Error("Cursor reviewer JSON wrapper did not include a usable result field");
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = cliArgs.getArg("--model");
  resolvePhase(cliArgs.getArg("--phase", "primary_review"));
  const agentBin = process.env.RELAY_CURSOR_AGENT_BIN || "agent";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  probeCursorAuth(agentBin, repoPath);

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText);

  const execArgs = [
    "--print",
    "--trust",
    "--mode", "ask",
    "--workspace", repoPath,
    "--output-format", "json",
  ];
  if (model) execArgs.push("--model", model);
  execArgs.push(fullPrompt);

  let rawOutput;
  try {
    rawOutput = execFileSync(agentBin, execArgs, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: parentTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      throw new Error(
        `Cursor reviewer primary_review timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The agent --print invocation did not return before the parent-process timeout; retry with a larger timeout or split the review scope."
      );
    }
    const recovered = recoverExecStdout(error);
    const failureText = recovered || summarizeFailure(error);
    if (isCursorAuthError(failureText)) {
      throw buildCursorAuthError();
    }
    if (!recovered) {
      throw new Error(`Cursor reviewer failed: ${failureText}`);
    }
    rawOutput = recovered;
  }

  if (!rawOutput) {
    throw new Error("Cursor reviewer primary_review did not produce a structured result");
  }

  const verdictText = extractCursorAgentResult(rawOutput);
  const parsed = parseReviewerVerdictObject(verdictText, {
    adapter: "cursor",
    phase: "primary_review",
    description: "review verdict",
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
