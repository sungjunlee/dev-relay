"use strict";

const fs = require("fs");
const path = require("path");
const { getRunDir, listManifestPaths } = require("./paths");
const { readManifest } = require("./store");
const { isTerminalState } = require("./lifecycle");

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

function findInflightRunsForIssue(repoRoot, issueNumber) {
  if (!issueNumber || !Number.isInteger(Number(issueNumber))) return [];
  const prefix = `issue-${issueNumber}-`;
  const inflight = [];
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
    inflight.push({
      runId,
      state: data.state,
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
