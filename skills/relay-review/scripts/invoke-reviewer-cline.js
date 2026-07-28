#!/usr/bin/env node
/**
 * Invoke Cline CLI as a structured advisory reviewer.
 */

const fs = require("fs");
const path = require("path");
const {
  bindCliArgs,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  extractClineAdvisoryCandidates,
} = require("../../relay-dispatch/scripts/agent-adapters/cline-jsonl");
const {
  summarizeFailure,
} = require("./reviewer-helpers");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("./advisory-review-schema");
const {
  spawnSyncWithStdinPrompt,
} = require("./reviewer-prompt-transport");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--prompt-file", "--model", "--phase", "--profile", "--json", "--help", "-h"];
const cliArgs = bindCliArgs(args, {
  commandName: "invoke-reviewer-cline",
  reservedFlags: KNOWN_FLAGS,
});
const REVIEW_TIMEOUT_ENV = "RELAY_CLINE_REVIEW_TIMEOUT";
const DEFAULT_REVIEW_TIMEOUT = "1800s";
const MIN_REVIEW_TIMEOUT_SECONDS = 120;
const CLINE_TIMEOUT_HEADROOM_SECONDS = 60;

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: invoke-reviewer-cline.js --repo <path> --prompt-file <path> [--phase advisory_review] [--model <route>] [--profile <name>] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root`);
  console.log(`  --prompt-file <path> ${modeLabel("--prompt-file")} Prompt bundle path`);
  console.log(`  --model <route>      ${modeLabel("--model")} Model route, for example cline-pass/glm-5.2`);
  console.log(`  --phase <name>       ${modeLabel("--phase")} advisory_review only`);
  console.log(`  --profile <name>     ${modeLabel("--profile")} Advisory profile, defaults to blindspot`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

function resolvePhase(value) {
  const phase = String(value || "advisory_review").trim();
  if (phase !== "advisory_review") {
    throw new Error(
      `cline reviewer supports advisory_review only in the MVP; got ${JSON.stringify(value)}. Primary review requires separate live canary promotion.`
    );
  }
  return phase;
}

function readAdvisoryProfileArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--profile") {
      const value = argv[index + 1];
      return value && !String(value).startsWith("--") ? value : undefined;
    }
    if (token.startsWith("--profile=")) return token.slice("--profile=".length);
  }
  return undefined;
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

function clineTimeoutSecondsFromParentMs(parentTimeoutMs) {
  const minimumParentMs = MIN_REVIEW_TIMEOUT_SECONDS * 1000;
  if (parentTimeoutMs < minimumParentMs) {
    throw new Error(
      `${REVIEW_TIMEOUT_ENV} must be at least ${MIN_REVIEW_TIMEOUT_SECONDS}s so Cline's internal timeout stays ${CLINE_TIMEOUT_HEADROOM_SECONDS}s below the parent exec timeout`
    );
  }
  const parentSeconds = Math.ceil(parentTimeoutMs / 1000);
  return String(parentSeconds - CLINE_TIMEOUT_HEADROOM_SECONDS);
}

function isExecTimeout(error) {
  return error?.code === "ETIMEDOUT" || (error?.signal === "SIGKILL" && error?.killed);
}

function providerForModel(model) {
  if (typeof model !== "string" || !model.trim()) return "cline-pass";
  const idx = model.indexOf("/");
  return idx > 0 ? model.slice(0, idx) : "cline-pass";
}

function validateModelRoute(model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const normalized = model.trim();
  if (!normalized.includes("/")) {
    throw new Error(
      `--model must use the expected modelType/model form, for example cline-pass/glm-5.2; got ${JSON.stringify(model)}`
    );
  }
  return normalized;
}

function buildTimeoutDiagnosticCommand({ clineBin, model, reviewTimeout }) {
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);
  const command = [
    clineBin || "cline",
    "--json",
    "--yolo",
    "-P", providerForModel(model),
  ];
  if (model) command.push("-m", model);
  command.push(
    "--timeout", clineTimeoutSecondsFromParentMs(parentTimeoutMs),
    "'Return exactly {\"ok\":true} and nothing else.'"
  );
  return command.join(" ");
}

function buildPrompt(promptText) {
  return [
    "[NON-INTERACTIVE ADVISORY REVIEW]",
    "Return only JSON matching the advisory review shape in the prompt.",
    "Do not wrap the response in markdown fences.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "Do not use cline --worktree; relay already selected the review checkout with --cwd.",
    "",
    promptText,
  ].join("\n");
}

function withRawAdapterOutput(error, rawOutput, rawStderr) {
  error.rawAdapterOutput = rawOutput;
  error.rawAdapterStderr = rawStderr;
  return error;
}

function main() {
  const repoPath = path.resolve(cliArgs.getArg("--repo") || ".");
  const promptFile = cliArgs.getArg("--prompt-file");
  const model = validateModelRoute(cliArgs.getArg("--model"));
  const phase = resolvePhase(cliArgs.getArg("--phase", "advisory_review"));
  const advisoryProfile = validateAdvisoryProfile(readAdvisoryProfileArg(args) || "blindspot");
  const clineBin = process.env.RELAY_CLINE_BIN || "cline";
  const reviewTimeout = String(process.env[REVIEW_TIMEOUT_ENV] || DEFAULT_REVIEW_TIMEOUT).trim();
  const parentTimeoutMs = parseReviewTimeoutMs(reviewTimeout);

  if (!promptFile) {
    throw new Error("--prompt-file is required");
  }

  const promptText = fs.readFileSync(promptFile, "utf-8").trim();
  const fullPrompt = buildPrompt(promptText);

  const execArgs = [
    "--json",
    "--yolo",
    "-P", providerForModel(model),
  ];
  if (model) execArgs.push("-m", model);
  execArgs.push(
    "--cwd", repoPath,
    "--timeout", clineTimeoutSecondsFromParentMs(parentTimeoutMs)
  );

  const execResult = spawnSyncWithStdinPrompt(clineBin, execArgs, {
    adapter: "cline",
    prompt: fullPrompt,
    promptFile,
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: parentTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
  });
  const rawOutput = String(execResult.stdout || "").trim();
  const rawStderr = String(execResult.stderr || "");
  if (execResult.error || execResult.status !== 0) {
    if (isExecTimeout(execResult.error)) {
      const diagnosticCommand = buildTimeoutDiagnosticCommand({ clineBin, model, reviewTimeout });
      throw new Error(
        `Cline reviewer ${phase} timed out after ${reviewTimeout} (${REVIEW_TIMEOUT_ENV}). ` +
        "The cline --json invocation did not return before the parent-process timeout, so relay cannot treat this as healthy advisory evidence. " +
        `First verify Cline non-interactive provider output with: ${diagnosticCommand}. ` +
        "If that minimal command also times out, record this as a Cline CLI/provider non-interactive blocker; otherwise retry with a larger review timeout or split the review scope."
      );
    }
    if (!rawOutput && !rawStderr) {
      const failure = execResult.error || {
        message: `Cline process exited with status ${execResult.status ?? "unknown"}`,
      };
      throw new Error(`Cline reviewer failed: ${summarizeFailure(failure)}`);
    }
  }

  let candidates;
  try {
    candidates = extractClineAdvisoryCandidates(rawOutput, {
      adapter: "cline",
      phase,
      stderr: rawStderr,
    });
  } catch (error) {
    throw withRawAdapterOutput(new Error(
      `${error.message}. Cline advisory review must return JSON in run_result.text, then the last text content_end, then single-line plain-JSON stdout; relay cannot treat this as healthy advisory evidence.`
    ), rawOutput, rawStderr);
  }

  let parsed = null;
  let firstParseError = null;
  for (const candidate of candidates) {
    try {
      parsed = parseAdvisoryReview(candidate, {
        adapter: "cline",
        phase,
        profile: advisoryProfile,
      });
      break;
    } catch (error) {
      if (!firstParseError) firstParseError = error;
    }
  }
  if (!parsed) {
    throw withRawAdapterOutput(new Error(
      `Cline advisory review failed to parse any of ${candidates.length} advisory candidate(s); first failure: ${firstParseError?.message || "unknown parse failure"}`
    ), rawOutput, rawStderr);
  }
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
  if (error.rawAdapterOutput || error.rawAdapterStderr) {
    if (error.rawAdapterOutput) {
      process.stderr.write(`\nRaw Cline output:\n${error.rawAdapterOutput.trim()}\n`);
    }
    if (error.rawAdapterStderr) {
      process.stderr.write(`\nCline stderr:\n${error.rawAdapterStderr.trim()}\n`);
    }
  }
  process.exit(1);
}
