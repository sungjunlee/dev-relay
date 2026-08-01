#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const {
  bindCliArgs,
  findUnknownFlags,
} = require("../../relay-dispatch/scripts/cli-args");
const { findInflightRunsForIssue } = require("../../relay-dispatch/scripts/manifest/inflight-runs");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { buildRunReconcileFinding } = require("../../relay-dispatch/scripts/reconcile-findings");

const EVENT_FIELD = "event";
const INFLIGHT_ROUTE_INSTRUCTIONS = {
  "existing-open-pr": "Review the existing open PR instead of planning or dispatching a new run.",
  "existing-merged-pr": "Mark the sprint item done if present and stop because the PR is already merged.",
  "inflight-run": "Resume or inspect the existing inflight run and continue from its manifest state.",
  attention: "Stop before planning or dispatch and inspect the inflight-run scanner failure.",
  continue: "Continue to readiness handling before planning or dispatch.",
};
const BRANCH_INSTRUCTIONS = {
  bypass: "Proceed to Step 2 using the bypass route and keep the readiness_probe event as the readiness evidence.",
  "ready-light": "Proceed to Step 2 with S-size quick planning and compact rubric guidance while preserving the readiness_probe event payload.",
  "chain-y": "Ask the operator in plain text to choose y to invoke relay-ready before Step 2, n to emit bypass_override_by_user and proceed to Step 2, or abort to emit readiness_check_failed and close the run after the readiness_probe.",
  "proposal-first": "Run proposal-first relay-ready shaping after the readiness_probe, require an accepted handoff, and use that handoff as the relay-plan source of truth before dispatch.",
  "chain-n": "If the operator answers n, emit bypass_override_by_user with the supplied payload and proceed to Step 2.",
  "chain-abort": "If the operator answers abort, emit readiness_check_failed with the supplied payload and close the run.",
  "noninteractive-fail": "Emit readiness_check_failed_nontty with the supplied payload and close the run because no prompt is allowed.",
};

function buildPromptInstruction(summary) {
  const detail = summary || "readiness gaps require operator choice";
  return `Readiness gaps detected: ${detail}. Invoke relay-ready first? Answer y, n, or abort?`;
}
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
  "--reconcile",
  "--skip-readiness",
  "--bypass-readiness",
  "--skip-readiness-reason",
  "--non-interactive",
  "--json",
  "--help",
  "-h",
];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--reconcile", "--skip-readiness", "--bypass-readiness", "--non-interactive", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--branch", "--body", "--body-file", "--manifest", "--skip-readiness-reason"],
};

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
    "  --reconcile                Mutate dead dispatched runs by running reconcile-run.js (default: dry-run verdict only)",
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
  const ghBin = process.env.RELAY_GH_BIN || "gh";
  const raw = execFileSync(ghBin, args, {
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

function checkInflightRuns(repoRoot, issueNumber, scanner = findInflightRunsForIssue) {
  if (!issueNumber) {
    return {
      status: "skipped",
      reason: "missing_issue_number",
      runs: [],
    };
  }

  try {
    const runs = scanner(repoRoot, issueNumber);
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
      instruction: INFLIGHT_ROUTE_INSTRUCTIONS["existing-open-pr"],
      next_action: "skip_plan_dispatch_and_review_existing_pr",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0]?.runId || null,
    };
  }
  if (prCheck.status === "merged") {
    return {
      route: "existing-merged-pr",
      instruction: INFLIGHT_ROUTE_INSTRUCTIONS["existing-merged-pr"],
      next_action: "mark_sprint_done_if_present",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0]?.runId || null,
    };
  }
  if (runCheck.runs.length > 0) {
    return {
      route: "inflight-run",
      instruction: INFLIGHT_ROUTE_INSTRUCTIONS["inflight-run"],
      next_action: "resume_or_inspect_inflight_run",
      prNumber: prCheck.pr?.number || null,
      runId: runCheck.runs[0].runId,
    };
  }
  if (runCheck.status === "unknown") {
    return {
      route: "attention",
      instruction: INFLIGHT_ROUTE_INSTRUCTIONS.attention,
      next_action: "inspect_inflight_scanner_failure",
      prNumber: null,
      runId: null,
      reason: runCheck.reason || "inflight_scan_unknown",
    };
  }
  return {
    route: "continue",
    instruction: INFLIGHT_ROUTE_INSTRUCTIONS.continue,
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

function routeDecisionFromReadiness(envelope) {
  if (!envelope) return "readiness_prompt";
  if (envelope.bypass === true) return "ready_single";
  if (envelope.task_shape?.strong === true) return "needs_split";
  if (envelope.bypass === false && envelope.next_action === "proceed" && !hasHighRiskReadinessSignal(envelope)) return "ready_light";
  return "readiness_prompt";
}

function hasHighRiskReadinessSignal(envelope) {
  if (envelope?.risk?.high === true) return true;
  if (Array.isArray(envelope?.risk?.signals) && envelope.risk.signals.includes("high_risk_keyword")) return true;
  return /\bhigh-risk keyword\b/i.test(String(envelope?.signals_summary || ""));
}

function buildReadinessDecision(envelope, { promptAllowed }) {
  const routeDecision = routeDecisionFromReadiness(envelope);
  const score = envelope?.readiness_score || null;
  const commonPayload = {
    readiness_score: score,
    bypass: envelope?.bypass ?? null,
    next_action: envelope?.next_action || null,
    route_decision: routeDecision,
    task_shape: envelope?.task_shape || null,
    risk: envelope?.risk || null,
    signals_summary: envelope?.signals_summary || null,
  };

  let recommendedBranch = "bypass";
  if (routeDecision === "ready_light") {
    recommendedBranch = "ready-light";
  } else if (routeDecision === "needs_split" && promptAllowed) {
    recommendedBranch = "proposal-first";
  } else if (routeDecision !== "ready_single") {
    recommendedBranch = promptAllowed ? "prompt" : "noninteractive-fail";
  }

  const branchLabels = {
    bypass: {
      label: "bypass",
      [EVENT_FIELD]: EVENTS.READINESS_PROBE,
      action: "proceed_to_step_2",
      instruction: BRANCH_INSTRUCTIONS.bypass,
    },
    "ready-light": {
      label: "ready-light",
      [EVENT_FIELD]: EVENTS.READINESS_PROBE,
      action: "proceed_to_step_2_light_planning",
      instruction: BRANCH_INSTRUCTIONS["ready-light"],
      planning_profile: "ready_light",
      event_payload: {
        [EVENT_FIELD]: EVENTS.READINESS_PROBE,
        ...commonPayload,
      },
    },
    "chain-y": {
      label: "chain-y",
      [EVENT_FIELD]: EVENTS.READINESS_PROBE,
      action: "invoke_relay_ready_then_resume_step_2",
      instruction: BRANCH_INSTRUCTIONS["chain-y"],
    },
    "proposal-first": {
      label: "proposal-first",
      [EVENT_FIELD]: EVENTS.READINESS_PROBE,
      action: "invoke_relay_ready_proposal_first_then_resume_step_2",
      instruction: BRANCH_INSTRUCTIONS["proposal-first"],
      relay_ready_mode: "proposal_first",
      requires_accepted_handoff: true,
      source_of_truth: "accepted_relay_ready_handoff",
    },
    "chain-n": {
      label: "chain-n",
      [EVENT_FIELD]: EVENTS.BYPASS_OVERRIDE_BY_USER,
      action: "proceed_to_step_2",
      instruction: BRANCH_INSTRUCTIONS["chain-n"],
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
      instruction: BRANCH_INSTRUCTIONS["chain-abort"],
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
      instruction: BRANCH_INSTRUCTIONS["noninteractive-fail"],
      event_payload: {
        [EVENT_FIELD]: EVENTS.READINESS_CHECK_FAILED_NONTTY,
        reason: "readiness_gaps_without_prompt",
        ...commonPayload,
      },
    },
  };

  return {
    route_decision: routeDecision,
    recommended_branch: recommendedBranch,
    instruction: recommendedBranch === "prompt"
      ? buildPromptInstruction(envelope?.signals_summary)
      : branchLabels[recommendedBranch].instruction,
    prompt_allowed: promptAllowed,
    prompt_summary: ["readiness_prompt", "needs_split"].includes(routeDecision) && promptAllowed
      ? envelope?.signals_summary || null
      : null,
    branch_labels: branchLabels,
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

function buildUnevaluatedReadinessForInflightRoute(inflight) {
  const route = inflight?.route || "unknown";
  return {
    skipped: true,
    skip_reason: `inflight_route_${route}`,
    probe: null,
    readiness_score: null,
    bypass: null,
    next_action: "defer_to_inflight_route",
    signals_summary: `Readiness probe skipped because inflight.route is ${route}.`,
    elapsed_ms: 0,
    decision: {
      recommended_branch: "not-evaluated",
      instruction: inflight?.instruction || `Follow the ${route} inflight route before readiness handling.`,
      prompt_allowed: false,
      prompt_summary: null,
      branch_labels: {},
    },
  };
}

function promptAllowedForCurrentProcess({ nonInteractive }) {
  // stdout is often captured by SKILL.md command substitution to read JSON.
  return !nonInteractive && process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function runRouteStage(cliArgs) {
  const repoRoot = path.resolve(cliArgs.getArg("--repo") || ".");
  const issueNumber = parsePositiveInteger(cliArgs.getArg("--issue-number"), "--issue-number");
  const branch = normalizeBlank(cliArgs.getArg("--branch")) || (issueNumber ? `issue-${issueNumber}` : null);
  const body = cliArgs.getArg("--body");
  const bodyFile = normalizeBlank(cliArgs.getArg("--body-file"));
  const manifestPath = normalizeBlank(cliArgs.getArg("--manifest"));
  const nonInteractive = cliArgs.hasFlag("--non-interactive");
  const promptAllowed = promptAllowedForCurrentProcess({ nonInteractive });

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
  if (inflight.route !== "continue") {
    readiness = buildUnevaluatedReadinessForInflightRoute(inflight);
  } else if (cliArgs.hasFlag("--skip-readiness") || cliArgs.hasFlag("--bypass-readiness")) {
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
    ok: inflight.route !== "attention",
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

function fetchLivePrHead(repoRoot, prNumber) {
  if (!prNumber) {
    return {
      status: "skipped",
      reason: "missing_pr_number",
      pr_number: null,
      head_ref_name: null,
      head_sha: null,
      command: null,
    };
  }

  const args = [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,headRefName,headRefOid",
  ];
  try {
    const parsed = execGhJson(repoRoot, args);
    return {
      status: "found",
      reason: null,
      pr_number: Number(parsed?.number || prNumber),
      head_ref_name: parsed?.headRefName || null,
      head_sha: parsed?.headRefOid || null,
      command: ["gh", ...args],
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: summarizeExecError(error),
      pr_number: prNumber,
      head_ref_name: null,
      head_sha: null,
      command: ["gh", ...args],
    };
  }
}

function buildReadyStatus(snapshot, repoRoot) {
  if (snapshot.state !== "ready_to_merge") {
    return {
      status: "not_ready",
      reason: `state_${snapshot.state || "unknown"}`,
      pr_number: snapshot.pr_number || null,
      old_sha: snapshot.last_reviewed_sha || snapshot.head_sha || null,
      new_sha: null,
      reviewed_sha: snapshot.last_reviewed_sha || null,
      manifest_head_sha: snapshot.head_sha || null,
      next_action: "continue_review_flow",
    };
  }

  const oldSha = snapshot.last_reviewed_sha || snapshot.head_sha || null;
  const live = fetchLivePrHead(repoRoot, snapshot.pr_number);
  if (live.status !== "found" || !live.head_sha) {
    return {
      status: "unknown",
      reason: live.reason || live.status,
      pr_number: live.pr_number || snapshot.pr_number || null,
      old_sha: oldSha,
      new_sha: live.head_sha || null,
      reviewed_sha: snapshot.last_reviewed_sha || null,
      manifest_head_sha: snapshot.head_sha || null,
      head_ref_name: live.head_ref_name || snapshot.branch || null,
      next_action: "inspect_pr_head_before_merge",
    };
  }

  const differsFromReviewed = Boolean(snapshot.last_reviewed_sha && live.head_sha !== snapshot.last_reviewed_sha);
  const differsFromManifestHead = Boolean(snapshot.head_sha && live.head_sha !== snapshot.head_sha);
  const stale = differsFromReviewed || differsFromManifestHead;
  const staleOldSha = differsFromReviewed
    ? snapshot.last_reviewed_sha
    : differsFromManifestHead
      ? snapshot.head_sha
      : oldSha;

  return {
    status: stale ? "stale_ready" : "merge_ready",
    reason: stale ? "live_pr_head_drift" : null,
    pr_number: live.pr_number || snapshot.pr_number || null,
    old_sha: staleOldSha || null,
    new_sha: live.head_sha,
    reviewed_sha: snapshot.last_reviewed_sha || null,
    manifest_head_sha: snapshot.head_sha || null,
    head_ref_name: live.head_ref_name || snapshot.branch || null,
    next_action: stale
      ? "recover_ready_to_review_pending_then_rerun_review"
      : "proceed_to_merge",
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
  let record = resolveReviewManifest(cliArgs, repoRoot);
  const reconcile = buildRunReconcileFinding({
    repoRoot,
    manifestPath: record.manifestPath,
    data: record.data,
    mutate: cliArgs.hasFlag("--reconcile"),
  });
  if (reconcile.mutated && reconcile.verdict?.state && reconcile.verdict.state !== record.data?.state) {
    record = {
      manifestPath: record.manifestPath,
      ...readManifest(record.manifestPath),
    };
  }
  const snapshot = snapshotReview(record);
  return {
    ok: true,
    stage: "review",
    repo: repoRoot,
    snapshot,
    ready_status: buildReadyStatus(snapshot, repoRoot),
    reconcile,
    comparison: compareReviewSnapshot(snapshot, cliArgs),
  };
}

function main(argv = process.argv.slice(2)) {
  const cliArgs = bindCliArgs(argv, CLI_ARG_OPTIONS);

  if (cliArgs.hasFlag(["--help", "-h"])) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const unknownFlags = findUnknownFlags(argv, CLI_ARG_OPTIONS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const stage = normalizeBlank(cliArgs.getArg("--stage"));
  if (stage === "route") {
    const result = runRouteStage(cliArgs);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
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
  hasHighRiskReadinessSignal,
  main,
  routeDecisionFromReadiness,
  routeFromInflight,
  snapshotReview,
};
