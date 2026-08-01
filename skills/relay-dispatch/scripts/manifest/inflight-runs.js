"use strict";

const fs = require("fs");
const path = require("path");
const { getManifestPath, getRunDir, getRunsDir, listManifestPaths, requireValidRunId } = require("./paths");
const { readManifest } = require("./store");
const { isTerminalState } = require("./lifecycle");
const { readRunRecord } = require("../run-store");
const { readFacts } = require("../facts");
const { foldRunFacts } = require("../run-fold");

const ISSUE_PATTERN = /\bissue-(\d+)\b/;

function inferIssueFromPromptOrBranch(branch, prompt) {
  for (const source of [branch, prompt]) {
    if (!source) continue;
    const match = String(source).match(ISSUE_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}

function readLastEventTimestamp(repoRoot, runId) {
  try {
    const eventsPath = path.join(getRunDir(repoRoot, runId), "events.jsonl");
    if (!fs.existsSync(eventsPath)) return null;
    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    if (!content) return null;
    const lines = content.split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed.ts || null;
  } catch {
    return null;
  }
}

function recordedGithubFacts(facts) {
  const pr = facts.filter((fact) => fact.type === "pull_request_recorded").at(-1);
  if (!pr) return { available: true, pr_lookup_complete: true };
  const merged = facts.filter((fact) => fact.type === "merge_recorded").at(-1);
  return {
    available: true,
    pr_lookup_complete: true,
    pr_number: pr.payload.pr_number,
    repo: pr.payload.repo,
    pr_head_sha: pr.payload.head_sha,
    head_ref: pr.payload.head_ref,
    base_ref: pr.payload.base_ref,
    pr_state: merged ? "MERGED" : "OPEN",
    ...(merged ? { merge_sha: merged.payload.result_target_sha } : {}),
  };
}

function scanVnextRunsForIssue(repoRoot, issueNumber) {
  const prefix = `issue-${issueNumber}-`;
  const claimedRunIds = new Set();
  const inflight = [];
  const logicalRunsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(logicalRunsDir)) return { claimedRunIds, inflight };
  let runsDir;
  try { runsDir = fs.realpathSync(logicalRunsDir); } catch { return { claimedRunIds, inflight }; }
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    let runId;
    try { runId = requireValidRunId(entry.name); } catch { continue; }
    const runDir = path.join(runsDir, runId);
    const runRecordPath = path.join(runDir, "run.json");
    try { fs.lstatSync(runRecordPath); } catch (error) { if (error.code === "ENOENT") continue; }
    // Presence is authoritative even when parsing fails: a forged/stale legacy
    // manifest with the same id cannot make the admission scanner forget a
    // vNext crash residue.
    claimedRunIds.add(runId);
    const manifestPath = fs.existsSync(getManifestPath(repoRoot, runId)) ? getManifestPath(repoRoot, runId) : null;
    let record;
    try {
      record = readRunRecord({ runDir });
    } catch (error) {
      inflight.push({
        runId,
        state: "operator_attention",
        source: "vnext_invalid",
        manifestPath,
        worktreePath: null,
        lastEventAt: null,
        reason: `invalid run.json: ${error.message}`,
      });
      continue;
    }
    let journal;
    let folded;
    try {
      journal = readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
      if (journal.tailIncomplete) throw new Error("fact journal has an incomplete tail");
      folded = foldRunFacts({
        runRecord: record,
        facts: journal.facts,
        githubFacts: recordedGithubFacts(journal.facts),
      });
    } catch (error) {
      inflight.push({
        runId,
        state: "operator_attention",
        source: "vnext",
        manifestPath,
        worktreePath: record.git.worktree,
        lastEventAt: journal?.facts?.at(-1)?.at || null,
        reason: `invalid fact journal: ${error.message}`,
      });
      continue;
    }
    // Terminality is proven only by a conflict-free fold of durable terminal
    // facts. Empty facts, no-attempt folds, and all ambiguous folds remain
    // in-flight so admission cannot create a duplicate child after a crash.
    const safelyTerminal = folded.terminal === true
      && new Set(["merged", "closed"]).has(folded.terminal_kind)
      && new Set(["merged", "closed"]).has(folded.reason);
    if (safelyTerminal) continue;
    inflight.push({
      runId,
      state: folded.action === "none" ? "operator_attention" : folded.reason,
      source: "vnext",
      manifestPath,
      worktreePath: record.git.worktree,
      lastEventAt: journal.facts.at(-1)?.at || null,
      reason: folded.reason,
    });
  }
  return { claimedRunIds, inflight };
}

function findInflightRunsForIssue(repoRoot, issueNumber) {
  if (!issueNumber || !Number.isInteger(Number(issueNumber))) return [];
  const prefix = `issue-${issueNumber}-`;
  const vnext = scanVnextRunsForIssue(repoRoot, Number(issueNumber));
  const inflight = [...vnext.inflight];
  const seen = new Set(vnext.claimedRunIds);
  for (const manifestPath of listManifestPaths(repoRoot)) {
    if (!path.basename(manifestPath).startsWith(prefix)) continue;
    let data;
    try {
      ({ data } = readManifest(manifestPath));
    } catch {
      continue;
    }
    if (!data || isTerminalState(data.state)) continue;
    const runId = data.run_id || path.basename(manifestPath, ".md");
    if (seen.has(runId)) continue;
    seen.add(runId);
    inflight.push({
      runId,
      state: data.state,
      source: "legacy",
      manifestPath,
      worktreePath: data.paths?.worktree || null,
      lastEventAt: readLastEventTimestamp(repoRoot, runId),
    });
  }
  return inflight;
}

function formatInflightCollisionError(inflightRuns, { issueNumber } = {}) {
  const header = issueNumber
    ? `Refusing to dispatch: ${inflightRuns.length} non-terminal run(s) already own issue-${issueNumber}.`
    : `Refusing to dispatch: ${inflightRuns.length} non-terminal run(s) already own this issue.`;
  const lines = [
    header,
    "Pass --allow-conflicting-run to override (e.g., orchestrator-initiated cleanup).",
    "",
  ];
  for (const run of inflightRuns) {
    lines.push(`  run_id:     ${run.runId}`);
    lines.push(`  state:      ${run.state}`);
    lines.push(`  worktree:   ${run.worktreePath || "(unset)"}`);
    lines.push(`  last_event: ${run.lastEventAt || "(none)"}`);
    lines.push(`  manifest:   ${run.manifestPath}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

module.exports = {
  findInflightRunsForIssue,
  formatInflightCollisionError,
  inferIssueFromPromptOrBranch,
};
