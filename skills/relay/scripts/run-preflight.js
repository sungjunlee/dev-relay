#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const {
  bindCliArgs,
  findUnknownFlags,
} = require("../../relay-dispatch/scripts/cli-args");
const { findInflightRunsForIssue } = require("../../relay-dispatch/scripts/manifest/inflight-runs");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { EVENTS } = require("../../relay-dispatch/scripts/relay-events");

const EVENT_FIELD = "event";
const KNOWN_FLAGS = [
  "--stage",
  "--repo",
  "--issue-number",
  "--branch",
  "--body",
  "--body-file",
  "--manifest",
  "--run-id",
  "--pr",
  "--previous-rounds",
  "--previous-verdict",
  "--previous-head-sha",
  "--previous-last-reviewed-sha",
  "--skip-readiness",
  "--bypass-readiness",
  "--skip-readiness-reason",
  "--non-interactive",
  "--json",
  "--help",
  "-h",
];

function usage() {
  return [
    "Usage: run-preflight.js --stage <route|review> [options]",
    "",
    "Route stage:",
    "  --repo <path>              Repository root, default .",
    "  --issue-number <n>         Issue number for issue-N PR/run checks",
    "  --branch <name>            Branch/head name, default issue-N when issue is set",
    "  --body <text>              Issue/task text for probe-readiness.js",
    "  --body-file <path>         Issue/task text file for probe-readiness.js",
    "  --manifest <path>          Optional run manifest/events path passed to probe-readiness.js",
    "  --skip-readiness           Do not run probe-readiness.js; emit a skipped readiness envelope",
    "  --bypass-readiness         Alias for --skip-readiness",
    "  --skip-readiness-reason <r> Reason for skipping readiness",
    "  --non-interactive          Compute readiness prompt_allowed=false",
    "",
    "Review stage:",
    "  --repo <path>              Repository root, default .",
    "  --run-id <id>              Resolve manifest by run id",
    "  --manifest <path>          Resolve manifest by path",
    "  --branch <name>            Resolve manifest by branch",
    "  --pr <n>                   Resolve manifest by PR number",
    "  --previous-rounds <n>      Previous review.rounds snapshot for comparison",
    "  --previous-verdict <name>  Previous review.latest_verdict snapshot for comparison",
  ].join("\n");
}

function normalizeBlank(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function parsePositiveInteger(value, label, { allowZero = false } = {}) {
  const normalized = normalizeBlank(value);
  if (normalized === undefined) return null;
  const parsed = Number(normalized);
  const tooSmall = allowZero ? parsed < 0 : parsed <= 0;
  if (!Number.isInteger(parsed) || tooSmall) {
    const requirement = allowZero ? "non-negative integer" : "positive integer";
    throw new Error(`${label} must be a ${requirement}`);
  }
  return parsed;
}

function summarizeExecError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function execGhJson(repoRoot, args) {
  const raw = execFileSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw || "null");
}

function checkPullRequest(repoRoot, branch) {
  if (!branch) {
    return {
      status: "skipped",
      reason: "missing_branch",
      command: null,
      pr: null,
      candidates: [],
    };
  }

  const args = [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state,mergedAt,headRefName,url",
  ];
  try {
    const candidates = execGhJson(repoRoot, args)
      .filter((entry) => entry && (!entry.headRefName || entry.headRefName === branch))
      .map((entry) => ({
        number: Number(entry.number),
        state: entry.state || null,
        mergedAt: entry.mergedAt || null,
        headRefName: entry.headRefName || branch,
        url: entry.url || null,
      }));
    const open = candidates.find((entry) => String(entry.state).toUpperCase() === "OPEN");
    const merged = candidates.find((entry) => (
      String(entry.state).toUpperCase() === "MERGED" || Boolean(entry.mergedAt)
    ));
    const selected = open || merged || candidates[0] || null;
    const status = open ? "open" : merged ? "merged" : selected ? "closed" : "not_found";
    return {
      status,
      reason: null,
      command: ["gh", ...args],
      pr: selected,
      candidates,
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: summarizeExecError(error),
      command: ["gh", ...args],
      pr: null,
      candidates: [],
    };
  }
}

function checkInflightRuns(repoRoot, issueNumber) {
  if (!issueNumber) {
    return {
      status: "skipped",
      reason: "missing_issue_number",
      runs: [],
    };
  }

  try {
    const runs = findInflightRunsForIssue(repoRoot, issueNumber);
    return {
      status: runs.length ? "found" : "not_found",
      reason: null,
      runs,
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: error.message,
      runs: [],
    };
  }
}

function routeFromInflight({ prCheck, runCheck }) {
  if (prCheck.status === "open") {
    return {
      route: "existing-open-pr",
      next_action: "skip_plan_dispatch_and_review_existing_pr",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0]?.runId || null,
    };
  }
  if (prCheck.status === "merged") {
    return {
      route: "existing-merged-pr",
      next_action: "mark_sprint_done_if_present",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0]?.runId || null,
    };
  }
  if (runCheck.runs.length > 0) {
    return {
      route: "inflight-run",
      next_action: "resume_or_inspect_inflight_run",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0].runId,
    };
  }
  return {
    route: "continue",
    next_action: "continue_to_readiness",
    prNumber: null,
    runId: null,
  };
}

function runReadinessProbe({ issueNumber, body, bodyFile, manifestPath }) {
  const probePath = path.resolve(__dirname, "..", "..", "relay-ready", "scripts", "probe-readiness.js");
  const args = [probePath, "--json"];
  if (bodyFile) {
    args.push("--body-file", path.resolve(bodyFile));
  } else {
    args.push("--body", body || "");
  }
  if (manifestPath) args.push("--manifest", path.resolve(manifestPath));
  if (issueNumber) args.push("--issue-number", String(issueNumber));

  const raw = execFileSync(process.execPath, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [process.execPath, ...args],
    envelope: JSON.parse(raw),
  };
}

function buildReadinessDecision(envelope, { promptAllowed }) {
  const score = envelope?.readiness_score || null;
  const commonPayload = {
    readiness_score: score,
    bypass: envelope?.bypass ?? null,
    next_action: envelope?.next_action || null,
    signals_summary: envelope?.signals_summary || null,
  };

  let recommendedBranch = "bypass";
  if (envelope && envelope.bypass !== true) {
    recommendedBranch = promptAllowed ? "prompt" : "noninteractive-fail";
  }

  return {
    recommended_branch: recommendedBranch,
    prompt_allowed: promptAllowed,
    prompt_summary: envelope && envelope.bypass !== true && promptAllowed
      ? envelope.signals_summary
      : null,
    branch_labels: {
      bypass: {
        label: "bypass",
        [EVENT_FIELD]: EVENTS.READINESS_PROBE,
        action: "proceed_to_step_2",
      },
      "chain-y": {
        label: "chain-y",
        [EVENT_FIELD]: EVENTS.READINESS_PROBE,
        action: "invoke_relay_ready_then_resume_step_2",
      },
      "chain-n": {
        label: "chain-n",
        [EVENT_FIELD]: EVENTS.BYPASS_OVERRIDE_BY_USER,
        action: "proceed_to_step_2",
        event_payload: {
          [EVENT_FIELD]: EVENTS.BYPASS_OVERRIDE_BY_USER,
          reason: "operator_bypass_after_readiness_prompt",
          ...commonPayload,
        },
      },
      "chain-abort": {
        label: "chain-abort",
        [EVENT_FIELD]: EVENTS.READINESS_CHECK_FAILED,
        action: "close_run",
        event_payload: {
          [EVENT_FIELD]: EVENTS.READINESS_CHECK_FAILED,
          reason: "operator_aborted_after_readiness_prompt",
          ...commonPayload,
        },
      },
      "noninteractive-fail": {
        label: "noninteractive-fail",
        [EVENT_FIELD]: EVENTS.READINESS_CHECK_FAILED_NONTTY,
        action: "close_run",
        event_payload: {
          [EVENT_FIELD]: EVENTS.READINESS_CHECK_FAILED_NONTTY,
          reason: "readiness_gaps_without_prompt",
          ...commonPayload,
        },
      },
    },
  };
}

function buildSkippedReadiness(reason, promptAllowed) {
  const envelope = {
    readiness_score: null,
    bypass: true,
    next_action: "proceed",
    signals_summary: reason || "Readiness probe skipped by explicit preflight bypass.",
    elapsed_ms: 0,
  };
  return {
    skipped: true,
    skip_reason: reason || "explicit_skip",
    probe: null,
    ...envelope,
    decision: buildReadinessDecision(envelope, { promptAllowed }),
  };
}

function runRouteStage(cliArgs) {
  const repoRoot = path.resolve(cliArgs.getArg("--repo") || ".");
  const issueNumber = parsePositiveInteger(cliArgs.getArg("--issue-number"), "--issue-number");
  const branch = normalizeBlank(cliArgs.getArg("--branch")) || (issueNumber ? `issue-${issueNumber}` : null);
  const body = cliArgs.getArg("--body");
  const bodyFile = normalizeBlank(cliArgs.getArg("--body-file"));
  const manifestPath = normalizeBlank(cliArgs.getArg("--manifest"));
  const nonInteractive = cliArgs.hasFlag("--non-interactive");
  const promptAllowed = !nonInteractive && process.stdin.isTTY === true && process.stdout.isTTY === true;

  const prCheck = checkPullRequest(repoRoot, branch);
  const runCheck = checkInflightRuns(repoRoot, issueNumber);
  const inflight = {
    issueNumber,
    branch,
    pull_request: prCheck,
    run: runCheck,
    ...routeFromInflight({ prCheck, runCheck }),
  };

  let readiness;
  if (cliArgs.hasFlag("--skip-readiness") || cliArgs.hasFlag("--bypass-readiness")) {
    readiness = buildSkippedReadiness(
      normalizeBlank(cliArgs.getArg("--skip-readiness-reason")) || "explicit_skip",
      promptAllowed
    );
  } else {
    const probe = runReadinessProbe({ issueNumber, body, bodyFile, manifestPath });
    readiness = {
      skipped: false,
      skip_reason: null,
      probe: {
        command: probe.command,
        [EVENT_FIELD]: EVENTS.READINESS_PROBE,
      },
      ...probe.envelope,
      decision: buildReadinessDecision(probe.envelope, { promptAllowed }),
    };
  }

  return {
    ok: true,
    stage: "route",
    repo: repoRoot,
    inflight,
    readiness,
  };
}

function resolveReviewManifest(cliArgs, repoRoot) {
  const manifestPath = normalizeBlank(cliArgs.getArg("--manifest"));
  const runId = normalizeBlank(cliArgs.getArg("--run-id"));
  const branch = normalizeBlank(cliArgs.getArg("--branch"));
  const prNumber = parsePositiveInteger(cliArgs.getArg("--pr"), "--pr");
  return resolveManifestRecord({
    repoRoot,
    manifestPath,
    runId,
    branch,
    prNumber,
  });
}

function snapshotReview(record) {
  const data = record.data || {};
  const rounds = Number(data.review?.rounds || 0);
  const latestVerdict = data.review?.latest_verdict || null;
  const headSha = data.git?.head_sha || null;
  const lastReviewedSha = data.review?.last_reviewed_sha || null;
  let shaState = "missing_head_sha";
  if (headSha && lastReviewedSha && headSha === lastReviewedSha) {
    shaState = "reviewed_current_head";
  } else if (headSha && lastReviewedSha) {
    shaState = "stale_reviewed_sha";
  } else if (headSha) {
    shaState = "not_reviewed";
  }

  return {
    run_id: data.run_id || path.basename(record.manifestPath, ".md"),
    manifest_path: record.manifestPath,
    state: data.state || null,
    branch: data.git?.working_branch || null,
    pr_number: data.git?.pr_number || null,
    rounds,
    latest_verdict: latestVerdict,
    head_sha: headSha,
    last_reviewed_sha: lastReviewedSha,
    sha_state: shaState,
  };
}

function compareReviewSnapshot(current, cliArgs) {
  const previousRounds = parsePositiveInteger(
    cliArgs.getArg("--previous-rounds"),
    "--previous-rounds",
    { allowZero: true }
  );
  const previousVerdict = normalizeBlank(cliArgs.getArg("--previous-verdict"));
  const previousHeadSha = normalizeBlank(cliArgs.getArg("--previous-head-sha")) || null;
  const previousLastReviewedSha = normalizeBlank(cliArgs.getArg("--previous-last-reviewed-sha")) || null;

  if (previousRounds === null && previousVerdict === undefined) return null;

  const roundsAdvanced = previousRounds !== null ? current.rounds > previousRounds : false;
  const verdictChanged = previousVerdict !== undefined
    ? current.latest_verdict !== previousVerdict
    : false;
  const advanced = roundsAdvanced || verdictChanged;

  return {
    previous: {
      rounds: previousRounds,
      latest_verdict: previousVerdict ?? null,
      head_sha: previousHeadSha,
      last_reviewed_sha: previousLastReviewedSha,
    },
    current,
    rounds_advanced: roundsAdvanced,
    verdict_changed: verdictChanged,
    advanced,
    stale: !advanced,
    sha_state: current.sha_state,
    next_action: advanced ? "proceed_to_step_5" : "run_review_runner_foreground",
  };
}

function runReviewStage(cliArgs) {
  const repoRoot = path.resolve(cliArgs.getArg("--repo") || ".");
  const record = resolveReviewManifest(cliArgs, repoRoot);
  const snapshot = snapshotReview(record);
  return {
    ok: true,
    stage: "review",
    repo: repoRoot,
    snapshot,
    comparison: compareReviewSnapshot(snapshot, cliArgs),
  };
}

function main(argv = process.argv.slice(2)) {
  const cliArgs = bindCliArgs(argv, {
    commandName: "run-preflight",
    reservedFlags: KNOWN_FLAGS,
  });

  if (cliArgs.hasFlag(["--help", "-h"])) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const unknownFlags = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const stage = normalizeBlank(cliArgs.getArg("--stage"));
  if (stage === "route") {
    process.stdout.write(`${JSON.stringify(runRouteStage(cliArgs))}\n`);
    return 0;
  }
  if (stage === "review") {
    process.stdout.write(`${JSON.stringify(runReviewStage(cliArgs))}\n`);
    return 0;
  }
  throw new Error("--stage must be one of: route, review");
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildReadinessDecision,
  checkInflightRuns,
  checkPullRequest,
  compareReviewSnapshot,
  main,
  routeFromInflight,
  snapshotReview,
};
