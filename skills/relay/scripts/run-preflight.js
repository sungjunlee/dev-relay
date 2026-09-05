#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const {
  classifyRepositorySource,
  inspectProductionRun,
  recoverProductionRun,
} = require("../../relay-dispatch/scripts/recover");
const {
  canonicalRepoRoot,
  readRunCandidates,
  resolveRunById,
} = require("./relay-status");
const {
  checkInflightRuns,
  checkPullRequest,
  requireSupportedSource,
  routeFromInflight,
  scanInflightRuns,
} = require("./run-preflight-helpers");

const KNOWN_FLAGS = [
  "--stage",
  "--repo",
  "--issue-number",
  "--branch",
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
  "--json",
  "--help",
  "-h",
];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--reconcile", "--recover", "--break-lock", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--branch", "--reason", "--actor", "--verification-file"],
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
    "",
    "Review stage:",
    "  --repo <path>              Repository root, default .",
    "  --run-id <id>              Resolve a validated Relay run.json by run id",
    "  --branch <name>            Resolve an unambiguous Relay run by branch",
    "  --pr <n>                   Resolve an unambiguous Relay run by observed PR number",
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

async function runRouteStage(cliArgs) {
  const source = requireSupportedSource(classifyRepositorySource(cliArgs.getArg("--repo") || "."));
  const repoRoot = canonicalRepoRoot(source.repoRoot);
  const issueNumber = parsePositiveInteger(cliArgs.getArg("--issue-number"), "--issue-number");
  const branch = normalizeBlank(cliArgs.getArg("--branch")) || (issueNumber ? `issue-${issueNumber}` : null);

  const prCheck = source.kind === "local"
    ? {
      status: "skipped",
      reason: "local_reviewed_result_route",
      command: null,
      pr: null,
      candidates: [],
    }
    : checkPullRequest(repoRoot, branch);
  const scanner = source.kind === "local"
    ? (root, issue) => scanInflightRuns(root, issue, { localOnly: true })
    : scanInflightRuns;
  const runCheck = await checkInflightRuns(repoRoot, issueNumber, scanner);
  const inflight = {
    issueNumber,
    branch,
    pull_request: prCheck,
    run: runCheck,
    ...routeFromInflight({ prCheck, runCheck }),
  };

  return {
    ok: inflight.route !== "attention",
    stage: "route",
    repo: repoRoot,
    source: {
      route: source.route,
      ...(source.remote_name ? { remote_name: source.remote_name } : {}),
    },
    inflight,
  };
}

async function resolveReviewRun(cliArgs, repoRoot) {
  const runId = normalizeBlank(cliArgs.getArg("--run-id"));
  const branch = normalizeBlank(cliArgs.getArg("--branch"));
  const prNumber = parsePositiveInteger(cliArgs.getArg("--pr"), "--pr");
  const selectors = [runId, branch, prNumber].filter((value) => value !== null && value !== undefined);
  if (selectors.length === 0) throw new Error("review stage requires --run-id, --branch, or --pr");
  const candidates = readRunCandidates(repoRoot);
  let selected = runId ? resolveRunById(repoRoot, runId) : null;
  if (branch) {
    const matches = candidates.filter(({ record }) => record.git.branch === branch);
    if (matches.length !== 1) throw new Error(matches.length ? `branch is ambiguous: ${branch}` : `Relay run not found for branch: ${branch}`);
    if (selected && selected.runDir !== matches[0].runDir) throw new Error("run selectors identify different Relay runs");
    selected = matches[0];
  }
  if (prNumber !== null) {
    if (selected) {
      const inspection = await inspectProductionRun({ runDir: selected.runDir });
      if (inspection.derived?.pr_number !== prNumber) throw new Error("run selectors identify different Relay runs");
      selected = { ...selected, inspection };
    } else {
      const inspected = await Promise.all(candidates.map(async (candidate) => ({
        ...candidate,
        inspection: await inspectProductionRun({ runDir: candidate.runDir }),
      })));
      const matches = inspected.filter(({ inspection }) => inspection.derived?.pr_number === prNumber);
      if (matches.length !== 1) throw new Error(matches.length ? `PR is ambiguous: #${prNumber}` : `Relay run not found for PR: #${prNumber}`);
      selected = matches[0];
    }
  }
  return selected;
}

function snapshotReview(record, runDir, inspection) {
  const reviews = (inspection.facts || []).filter((fact) => fact.type === "review_recorded");
  const latest = reviews.at(-1) || null;
  const headSha = inspection.derived?.head_sha || null;
  const lastReviewedSha = inspection.derived?.reviewed_sha || null;
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
      code: error.code || "PREFLIGHT_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  checkInflightRuns,
  checkPullRequest,
  compareReviewSnapshot,
  main,
  routeFromInflight,
  snapshotReview,
};
