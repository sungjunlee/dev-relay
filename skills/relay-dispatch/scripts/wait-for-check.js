#!/usr/bin/env node
"use strict";

const path = require("path");
const { bindCliArgs, findUnknownFlags } = require("./cli-args");
const { execGh } = require("./exec");

const DEFAULT_TIMEOUT_S = 1800;
const DEFAULT_INTERVAL_S = 15;
const MAX_GH_RETRIES = 3;

const EXIT = Object.freeze({
  SUCCESS: 0,
  CHECK_FAILED: 1,
  TIMEOUT: 2,
  GH_ERROR: 3,
  USAGE: 64,
});

const KNOWN_FLAGS = [
  "--repo",
  "--pr",
  "--timeout-s",
  "--interval-s",
  "--json",
  "--help",
  "-h",
];

const SUCCESS_BUCKETS = new Set([
  "pass",
  "success",
  "skipping",
  "skipped",
  "neutral",
]);

const FAILURE_BUCKETS = new Set([
  "fail",
  "failed",
  "failure",
  "cancel",
  "cancelled",
  "canceled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

function printUsage() {
  console.log("Usage: wait-for-check.js --repo <path> --pr <number> [options]");
  console.log("");
  console.log("Poll a pull request until all GitHub checks reach a terminal bucket.");
  console.log("");
  console.log("Options:");
  console.log(`  --repo <path>       Repository root`);
  console.log(`  --pr <number>       Pull request number`);
  console.log(`  --timeout-s <s>     Overall timeout (default: ${DEFAULT_TIMEOUT_S}s)`);
  console.log(`  --interval-s <s>    Poll interval (default: ${DEFAULT_INTERVAL_S}s)`);
  console.log("  --json              Output a JSON summary");
  console.log("  --help, -h          Show this help");
}

function usageError(message) {
  const error = new Error(message);
  error.code = "usage_error";
  return error;
}

function parseNonNegativeNumber(value, flag) {
  if (value === undefined) throw usageError(`${flag} requires a value`);
  if (String(value).trim() === "") throw usageError(`${flag} requires a value`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw usageError(`${flag} must be a non-negative number`);
  }
  return number;
}

function parsePositiveInteger(value, flag) {
  if (value === undefined) throw usageError(`${flag} requires a value`);
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw usageError(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length > 0) {
    throw usageError(`Unknown flag(s): ${unknown.join(", ")}`);
  }

  const cli = bindCliArgs(argv, {
    commandName: "wait-for-check",
    reservedFlags: KNOWN_FLAGS,
  });
  const help = cli.hasFlag(["--help", "-h"]);
  const json = cli.hasFlag("--json");
  if (help) return { help, json };

  const repoArg = cli.getArg("--repo");
  if (!repoArg) throw usageError("--repo is required");

  return {
    help,
    json,
    repoPath: path.resolve(repoArg),
    pr: parsePositiveInteger(cli.getArg("--pr"), "--pr"),
    timeoutS: parseNonNegativeNumber(
      cli.getArg("--timeout-s", String(DEFAULT_TIMEOUT_S)),
      "--timeout-s"
    ),
    intervalS: parseNonNegativeNumber(
      cli.getArg("--interval-s", String(DEFAULT_INTERVAL_S)),
      "--interval-s"
    ),
  };
}

function sleep(ms) {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function normalizeChecks(rawChecks) {
  if (!Array.isArray(rawChecks)) {
    throw new Error("gh pr checks returned JSON that is not an array");
  }

  return rawChecks
    .map((check) => ({
      name: String(check?.name || "<unnamed>"),
      bucket: String(check?.bucket || "unknown").toLowerCase(),
    }))
    .sort((left, right) => (
      left.name.localeCompare(right.name) || left.bucket.localeCompare(right.bucket)
    ));
}

function isNoChecksReported(error) {
  // Real `gh pr checks --json` with zero checks exits nonzero, writes
  // "no checks reported on '<branch>'" to stderr, and leaves stdout empty
  // (cli/cli#9390 / checks.go populateStatusChecks). Treat that as [].
  const stdout = String(error?.stdout || "").trim();
  if (stdout !== "") return false;
  const stderr = String(error?.stderr || error?.message || "");
  return /no checks reported on/i.test(stderr);
}

function fetchChecks(repoPath, pr) {
  let output;
  try {
    output = execGh(repoPath, [
      "pr",
      "checks",
      String(pr),
      "--json",
      "name,bucket",
    ]);
  } catch (error) {
    // gh uses nonzero status for pending and failed checks while still writing
    // the complete --json payload. Only an error without valid check JSON is
    // a transient command/API failure that should consume the retry budget —
    // except the real no-checks contract (empty stdout + stderr message).
    output = error?.stdout;
    try {
      return normalizeChecks(JSON.parse(String(output || "")));
    } catch {
      if (isNoChecksReported(error)) return [];
      throw error;
    }
  }
  return normalizeChecks(JSON.parse(output));
}

function classifyChecks(checks) {
  const failedChecks = checks.filter((check) => FAILURE_BUCKETS.has(check.bucket));
  const pendingChecks = checks.filter((check) => (
    !SUCCESS_BUCKETS.has(check.bucket) && !FAILURE_BUCKETS.has(check.bucket)
  ));
  return { failedChecks, pendingChecks };
}

function checkNames(checks) {
  return checks.map((check) => check.name);
}

function summaryBase({ repoPath, pr, checks }) {
  return {
    repo: repoPath,
    pr,
    checks,
    no_checks: false,
    timed_out: false,
    failed_checks: [],
    pending_checks: [],
  };
}

function successfulResult(options, checks) {
  if (checks.length === 0) {
    return {
      exitCode: EXIT.SUCCESS,
      summary: {
        ...summaryBase({ ...options, checks }),
        ok: true,
        outcome: "no_checks",
        no_checks: true,
      },
    };
  }

  return {
    exitCode: EXIT.SUCCESS,
    summary: {
      ...summaryBase({ ...options, checks }),
      ok: true,
      outcome: "success",
    },
  };
}

function failedResult(options, checks, failedChecks, pendingChecks) {
  return {
    exitCode: EXIT.CHECK_FAILED,
    summary: {
      ...summaryBase({ ...options, checks }),
      ok: false,
      outcome: "failed",
      failed_checks: checkNames(failedChecks),
      pending_checks: checkNames(pendingChecks),
    },
  };
}

function timeoutResult(options, checks) {
  const { pendingChecks } = classifyChecks(checks);
  return {
    exitCode: EXIT.TIMEOUT,
    summary: {
      ...summaryBase({ ...options, checks }),
      ok: false,
      outcome: "timeout",
      timed_out: true,
      pending_checks: checkNames(pendingChecks),
    },
  };
}

function ghErrorResult(options, checks, error, attempts) {
  const { failedChecks, pendingChecks } = classifyChecks(checks || []);
  return {
    exitCode: EXIT.GH_ERROR,
    summary: {
      ...summaryBase({ ...options, checks: checks || [] }),
      ok: false,
      outcome: "gh_error",
      error_class: "gh_error",
      error: String(error?.stderr || error?.message || error).trim(),
      attempts,
      retry_budget: MAX_GH_RETRIES,
      failed_checks: checkNames(failedChecks),
      pending_checks: checkNames(pendingChecks),
    },
  };
}

function waitForChecks(options, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const wait = dependencies.sleep || sleep;
  const getChecks = dependencies.fetchChecks || fetchChecks;
  const deadline = now() + (options.timeoutS * 1000);
  let lastChecks = null;
  let ghErrors = 0;
  let attempts = 0;

  while (true) {
    if (lastChecks && now() >= deadline) {
      return timeoutResult(options, lastChecks);
    }

    try {
      attempts += 1;
      const checks = getChecks(options.repoPath, options.pr);
      lastChecks = checks;
      const { failedChecks, pendingChecks } = classifyChecks(checks);

      if (failedChecks.length > 0) {
        return failedResult(options, checks, failedChecks, pendingChecks);
      }
      if (pendingChecks.length === 0) {
        return successfulResult(options, checks);
      }
    } catch (error) {
      ghErrors += 1;
      if (ghErrors > MAX_GH_RETRIES) {
        return ghErrorResult(options, lastChecks, error, attempts);
      }
      if (now() >= deadline) {
        if (lastChecks) return timeoutResult(options, lastChecks);
        return ghErrorResult(options, lastChecks, error, attempts);
      }
    }

    const remainingMs = Math.max(0, deadline - now());
    wait(Math.min(options.intervalS * 1000, remainingMs));
  }
}

function formatHumanSummary(summary) {
  if (summary.outcome === "success") {
    return `All ${summary.checks.length} check(s) passed.`;
  }
  if (summary.outcome === "no_checks") return "No checks configured for this pull request.";
  if (summary.outcome === "failed") {
    return `Check failure: ${summary.failed_checks.join(", ")}`;
  }
  if (summary.outcome === "timeout") {
    return `Timed out waiting for: ${summary.pending_checks.join(", ")}`;
  }
  if (summary.outcome === "usage_error" || summary.outcome === "internal_error") {
    return summary.error;
  }
  return `GitHub CLI error after ${summary.attempts} attempt(s): ${summary.error}`;
}

function emitResult(result, json) {
  const output = json
    ? JSON.stringify(result.summary, null, 2)
    : formatHumanSummary(result.summary);
  const stream = json || result.exitCode === EXIT.SUCCESS ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      printUsage();
      return EXIT.SUCCESS;
    }
    const result = waitForChecks(options);
    emitResult(result, options.json);
    return result.exitCode;
  } catch (error) {
    const json = argv.includes("--json");
    const summary = {
      ok: false,
      outcome: error.code === "usage_error" ? "usage_error" : "internal_error",
      error_class: error.code || "internal_error",
      error: String(error.message || error),
      no_checks: false,
      timed_out: false,
      checks: [],
      failed_checks: [],
      pending_checks: [],
    };
    emitResult({ exitCode: EXIT.USAGE, summary }, json);
    return EXIT.USAGE;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_INTERVAL_S,
  DEFAULT_TIMEOUT_S,
  EXIT,
  MAX_GH_RETRIES,
  classifyChecks,
  fetchChecks,
  main,
  normalizeChecks,
  parseArgs,
  waitForChecks,
};
