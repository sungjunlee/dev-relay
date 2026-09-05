"use strict";

/** Inflight PR/run routing helpers for run-preflight. */

const { execFileSync } = require("child_process");
const path = require("path");

const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const { readRunCandidates } = require("./relay-status");

const INFLIGHT_ROUTE_INSTRUCTIONS = {
  "existing-open-pr": "Review the existing open PR instead of planning or dispatching a new run.",
  "existing-merged-pr": "Mark the sprint item done if present and stop because the PR is already merged.",
  "inflight-run": "Resume or inspect the existing inflight run and continue from its immutable run facts.",
  attention: "Stop before planning or dispatch and inspect the inflight-run scanner failure.",
  continue: "Continue to readiness handling before planning or dispatch.",
};

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

function requireSupportedSource(source) {
  if (source.kind !== "unsupported") return source;
  throw Object.assign(
    new Error(`${source.message}. Relay currently supports GitHub or a no-remote local Git repository; GitLab and other forges are not implemented. Configure a supported GitHub remote, remove the remotes for local delivery, or use direct \`delegate\`.`),
    { code: "SOURCE_UNSUPPORTED_REMOTE" },
  );
}

async function scanInflightRuns(repoRoot, issueNumber, { localOnly = false } = {}) {
  const prefix = `issue-${issueNumber}`;
  const localIdentity = `local/${path.basename(repoRoot)}`;
  const candidates = readRunCandidates(repoRoot).filter(({ record }) => (
    (!localOnly || record.repo.remote === localIdentity)
    && (
    record.run_id === prefix
    || record.run_id.startsWith(`${prefix}-`)
    || record.git.branch === prefix
    || record.git.branch.startsWith(`${prefix}-`)
    )
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

async function checkInflightRuns(repoRoot, issueNumber, scanner = scanInflightRuns) {
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

module.exports = {
  checkInflightRuns,
  checkPullRequest,
  execGhJson,
  requireSupportedSource,
  routeFromInflight,
  scanInflightRuns,
  summarizeExecError,
};
