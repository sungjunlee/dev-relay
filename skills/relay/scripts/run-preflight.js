#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { inspectProductionRun, recoverProductionRun } = require("../../relay-dispatch/scripts/recover");
const {
  canonicalRepoRoot,
  readRunCandidates,
  resolveRunById,
} = require("./relay-status");

const EVENT_FIELD = "event";
const EVENTS = Object.freeze({
  READINESS_PROBE: "readiness_probe",
  BYPASS_OVERRIDE_BY_USER: "bypass_override_by_user",
  READINESS_CHECK_FAILED: "readiness_check_failed",
  READINESS_CHECK_FAILED_NONTTY: "readiness_check_failed_nontty",
});
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
  "--recover",
  "--reason",
  "--actor",
  "--verification-file",
  "--break-lock",
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
  booleanFlags: ["--reconcile", "--recover", "--break-lock", "--skip-readiness", "--bypass-readiness", "--non-interactive", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--branch", "--body", "--body-file", "--manifest", "--skip-readiness-reason", "--reason", "--actor", "--verification-file"],
};
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS), bool = new Set(CLI_ARG_OPTIONS.booleanFlags), verbatim = new Set(CLI_ARG_OPTIONS.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const variants = (flag) => Array.isArray(flag) ? flag : [flag]; return { hasFlag: (flags) => variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flags, fallback) => { for (const flag of variants(flags)) for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}

function usage() {
  return [
    "Usage: run-preflight.js --stage <route|review|merge> [options]",
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
    "  --run-id <id>              Resolve a validated vNext run.json by run id",
    "  --manifest <path>          Compatibility name for a vNext run.json path",
    "  --branch <name>            Resolve an unambiguous vNext run by branch",
    "  --pr <n>                   Resolve an unambiguous vNext run by observed PR number",
    "  --previous-rounds <n>      Previous review.rounds snapshot for comparison",
    "  --previous-verdict <name>  Previous review.latest_verdict snapshot for comparison",
    "  --reconcile, --recover     Apply the canonical inspected recovery action",
    "  --reason <text>            Required audit reason for recovery",
    "  --actor <name>             Recovery actor (default: git user.name)",
    "  --verification-file <path> Immutable verification input when requested",
    "  --break-lock               Permit audited stale-owner lock recovery",
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

async function scanInflightVnextRuns(repoRoot, issueNumber) {
  const prefix = `issue-${issueNumber}`;
  const candidates = readRunCandidates(repoRoot).filter(({ record }) => (
    record.run_id === prefix
    || record.run_id.startsWith(`${prefix}-`)
    || record.git.branch === prefix
    || record.git.branch.startsWith(`${prefix}-`)
  ));
  const inspected = await Promise.all(candidates.map(async ({ runDir, record }) => ({
    runDir,
    record,
    inspection: await inspectProductionRun({ runDir }),
  })));
  return inspected
    .filter(({ inspection }) => inspection.derived?.terminal !== true)
    .map(({ runDir, record, inspection }) => ({
      runId: record.run_id,
      runDir,
      phase: inspection.derived?.phase || "unknown",
      action: inspection.recommended_action?.kind || inspection.derived?.action || "unknown",
      reason: inspection.recommended_action?.reason || inspection.derived?.reason || null,
      prNumber: inspection.derived?.pr_number || null,
      blockers: inspection.blockers || [],
    }));
}

async function checkInflightRuns(repoRoot, issueNumber, scanner = scanInflightVnextRuns) {
  if (!issueNumber) {
    return {
      status: "skipped",
      reason: "missing_issue_number",
      runs: [],
    };
  }

  try {
    const runs = await scanner(repoRoot, issueNumber);
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

async function runRouteStage(cliArgs) {
  const repoRoot = canonicalRepoRoot(cliArgs.getArg("--repo") || ".");
  const issueNumber = parsePositiveInteger(cliArgs.getArg("--issue-number"), "--issue-number");
  const branch = normalizeBlank(cliArgs.getArg("--branch")) || (issueNumber ? `issue-${issueNumber}` : null);
  const body = cliArgs.getArg("--body");
  const bodyFile = normalizeBlank(cliArgs.getArg("--body-file"));
  const manifestPath = normalizeBlank(cliArgs.getArg("--manifest"));
  const nonInteractive = cliArgs.hasFlag("--non-interactive");
  const promptAllowed = promptAllowedForCurrentProcess({ nonInteractive });

  const prCheck = checkPullRequest(repoRoot, branch);
  const runCheck = await checkInflightRuns(repoRoot, issueNumber);
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

async function resolveReviewRun(cliArgs, repoRoot) {
  const runPath = normalizeBlank(cliArgs.getArg("--manifest"));
  const runId = normalizeBlank(cliArgs.getArg("--run-id"));
  const branch = normalizeBlank(cliArgs.getArg("--branch"));
  const prNumber = parsePositiveInteger(cliArgs.getArg("--pr"), "--pr");
  const selectors = [runPath, runId, branch, prNumber].filter((value) => value !== null && value !== undefined);
  if (selectors.length === 0) throw new Error("review stage requires --run-id, --manifest, --branch, or --pr");
  const candidates = readRunCandidates(repoRoot);
  let selected = runId ? resolveRunById(repoRoot, runId) : null;
  if (runPath) {
    const resolved = fs.realpathSync(path.resolve(runPath));
    if (path.basename(resolved) !== "run.json") {
      throw new Error("--manifest is retired; pass the canonical vNext run.json path");
    }
    const matches = candidates.filter(({ runDir }) => path.join(runDir, "run.json") === resolved);
    if (matches.length !== 1) throw new Error("vNext run.json does not belong to this repository");
    if (selected && selected.runDir !== matches[0].runDir) throw new Error("run selectors identify different vNext runs");
    selected = matches[0];
  }
  if (branch) {
    const matches = candidates.filter(({ record }) => record.git.branch === branch);
    if (matches.length !== 1) throw new Error(matches.length ? `branch is ambiguous: ${branch}` : `vNext run not found for branch: ${branch}`);
    if (selected && selected.runDir !== matches[0].runDir) throw new Error("run selectors identify different vNext runs");
    selected = matches[0];
  }
  if (prNumber !== null) {
    if (selected) {
      const inspection = await inspectProductionRun({ runDir: selected.runDir });
      if (inspection.derived?.pr_number !== prNumber) throw new Error("run selectors identify different vNext runs");
      selected = { ...selected, inspection };
    } else {
      const inspected = await Promise.all(candidates.map(async (candidate) => ({
        ...candidate,
        inspection: await inspectProductionRun({ runDir: candidate.runDir }),
      })));
      const matches = inspected.filter(({ inspection }) => inspection.derived?.pr_number === prNumber);
      if (matches.length !== 1) throw new Error(matches.length ? `PR is ambiguous: #${prNumber}` : `vNext run not found for PR: #${prNumber}`);
      selected = matches[0];
    }
  }
  return selected;
}

function snapshotReview(record, runDir, inspection) {
  const reviews = (inspection.facts || []).filter((fact) => fact.type === "review_recorded");
  const latest = reviews.at(-1) || null;
  const headSha = inspection.derived?.head_sha || null;
  const lastReviewedSha = inspection.derived?.reviewed_sha || latest?.payload?.reviewed_sha || null;
  let shaState = "missing_head_sha";
  if (headSha && lastReviewedSha && headSha === lastReviewedSha) {
    shaState = "reviewed_current_head";
  } else if (headSha && lastReviewedSha) {
    shaState = "stale_reviewed_sha";
  } else if (headSha) {
    shaState = "not_reviewed";
  }

  return {
    run_id: record.run_id,
    run_path: path.join(runDir, "run.json"),
    phase: inspection.derived?.phase || "unknown",
    action: inspection.recommended_action?.kind || inspection.derived?.action || "unknown",
    action_reason: inspection.recommended_action?.reason || inspection.derived?.reason || null,
    blockers: inspection.blockers || [],
    branch: record.git.branch,
    pr_number: inspection.derived?.pr_number || null,
    rounds: reviews.length,
    latest_verdict: latest?.payload?.verdict || null,
    head_sha: headSha,
    last_reviewed_sha: lastReviewedSha,
    sha_state: shaState,
  };
}

function buildReadyStatus(snapshot) {
  if (snapshot.action !== "merge") {
    const stale = snapshot.action === "review" && snapshot.action_reason === "review_stale";
    return {
      status: stale ? "stale_ready" : "not_ready",
      reason: snapshot.action_reason || `action_${snapshot.action}`,
      pr_number: snapshot.pr_number || null,
      old_sha: snapshot.last_reviewed_sha || snapshot.head_sha || null,
      new_sha: snapshot.head_sha || null,
      reviewed_sha: snapshot.last_reviewed_sha || null,
      observed_head_sha: snapshot.head_sha || null,
      next_action: stale ? "rerun_review" : snapshot.action,
    };
  }
  return {
    status: "merge_ready",
    reason: null,
    pr_number: snapshot.pr_number || null,
    old_sha: snapshot.last_reviewed_sha || snapshot.head_sha || null,
    new_sha: snapshot.head_sha || null,
    reviewed_sha: snapshot.last_reviewed_sha || null,
    observed_head_sha: snapshot.head_sha || null,
    head_ref_name: snapshot.branch || null,
    next_action: "proceed_to_merge",
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

async function runReviewStage(cliArgs, stage = "review") {
  const repoRoot = canonicalRepoRoot(cliArgs.getArg("--repo") || ".");
  const selected = await resolveReviewRun(cliArgs, repoRoot);
  let inspection = selected.inspection || await inspectProductionRun({ runDir: selected.runDir });
  const mutate = cliArgs.hasFlag("--reconcile") || cliArgs.hasFlag("--recover");
  let recovery = null;
  if (mutate) {
    if (cliArgs.hasFlag("--reconcile") && cliArgs.hasFlag("--recover")) {
      throw new Error("--reconcile and --recover are aliases and cannot be combined");
    }
    const reason = String(cliArgs.getArg("--reason") || "").trim();
    if (!reason) throw new Error("--reconcile/--recover requires --reason <audit text>");
    let actor = String(cliArgs.getArg("--actor") || "").trim();
    if (!actor) {
      try { actor = execFileSync("git", ["-C", repoRoot, "config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { actor = process.env.USER || "relay-operator"; }
    }
    recovery = await recoverProductionRun({
      runDir: selected.runDir,
      actor,
      reason,
      expectedActionKey: inspection.recommended_action.key,
      verificationFile: normalizeBlank(cliArgs.getArg("--verification-file")) || null,
      breakLock: cliArgs.hasFlag("--break-lock"),
      activeCheckout: repoRoot,
    });
    inspection = recovery.after || await inspectProductionRun({ runDir: selected.runDir });
  }
  const snapshot = snapshotReview(selected.record, selected.runDir, inspection);
  return {
    ok: true,
    stage,
    repo: repoRoot,
    snapshot,
    ready_status: buildReadyStatus(snapshot),
    inspection: {
      action: inspection.recommended_action,
      blockers: inspection.blockers,
    },
    recovery,
    comparison: compareReviewSnapshot(snapshot, cliArgs),
  };
}

async function main(argv = process.argv.slice(2)) {
  const cliArgs = parseCli(argv);

  if (cliArgs.hasFlag(["--help", "-h"])) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }


  const stage = normalizeBlank(cliArgs.getArg("--stage"));
  if (stage === "route") {
    const result = await runRouteStage(cliArgs);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (stage === "review" || stage === "merge") {
    process.stdout.write(`${JSON.stringify(await runReviewStage(cliArgs, stage))}\n`);
    return 0;
  }
  throw new Error("--stage must be one of: route, review, merge");
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
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
