"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const { selectIssueRuns } = require("../../../skills/relay/scripts/relay-status");

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "skills/relay/scripts/relay-status.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-vnext-")));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  const worktrees = path.join(relayHome, "worktrees");
  fs.mkdirSync(repo);
  fs.mkdirSync(worktrees, { recursive: true });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.name", "Status Test"]);
  git(repo, ["config", "user.email", "status@example.test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const canonical = fs.realpathSync(repo);
  const slug = `${path.basename(canonical)}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
  return { root, repo: canonical, remote, relayHome, runs: path.join(relayHome, "runs", slug), worktrees };
}

function createRun(value, issue, suffix) {
  const runId = `issue-${issue}-2026080100000000${suffix}`;
  const runDir = path.join(value.runs, runId);
  const worktree = path.join(value.worktrees, runId);
  fs.mkdirSync(runDir, { recursive: true });
  execFileSync("git", ["-C", value.repo, "worktree", "add", "-b", `issue-${issue}-${suffix}`, worktree, "main"], { stdio: "ignore" });
  const criteria = path.join(runDir, "criteria-source.md");
  fs.writeFileSync(criteria, "- status is derived from vNext\n");
  const frozen = runStore.freezeDoneCriteria({ sourcePath: criteria, runDir });
  fs.unlinkSync(criteria);
  const startSha = git(worktree, ["rev-parse", "HEAD"]);
  runStore.createRunRecord({ runDir, record: {
    version: 3,
    run_id: runId,
    repo: { root: value.repo, remote: value.remote },
    git: { branch: `issue-${issue}-${suffix}`, base_branch: "main", worktree, start_sha: startSha },
    contract: { done_criteria_path: frozen.path, done_criteria_sha256: frozen.sha256 },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: `2026-08-01T00:00:0${suffix}.000Z`,
  } });
  return { runId, runDir };
}

function inspection(terminal = false) {
  return {
    derived: { phase: terminal ? "terminal" : "reviewable", action: terminal ? "none" : "redispatch", terminal, reason: terminal ? "closed" : "no_attempt", pr_number: null },
    recommended_action: { kind: terminal ? "none" : "redispatch", reason: terminal ? "closed" : "no_attempt", key: "a".repeat(64) },
    blockers: [],
  };
}

test("issue selection uses only validated vNext run.json records and fails closed on active ambiguity", async () => {
  const value = fixture();
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = value.relayHome;
  const first = createRun(value, 828, "1");
  createRun(value, 828, "2");
  try {
    let inspected = 0;
    const oneActive = await selectIssueRuns(value.repo, 828, async () => inspection(inspected++ > 0));
    assert.equal(oneActive.selected_run_id, first.runId);
    assert.equal(oneActive.selection_reason, "single_active_run");
    const ambiguous = await selectIssueRuns(value.repo, 828, async () => inspection(false));
    assert.equal(ambiguous.selected_run_id, null);
    assert.equal(ambiguous.selection_reason, "multiple_active_runs");
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
  }
});

test("relay-status black box derives phase, action, blockers, and PR from canonical inspect", () => {
  const value = fixture();
  const created = createRun(value, 829, "1");
  const gh = path.join(value.root, "gh.js");
  fs.writeFileSync(gh, "#!/usr/bin/env node\nprocess.stdout.write('[]')\n");
  fs.chmodSync(gh, 0o755);
  const result = spawnSync(process.execPath, [SCRIPT, "--repo", value.repo, "--run-id", created.runId, "--json"], {
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: value.relayHome, RELAY_GH_BIN: gh },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.row.run_id, created.runId);
  assert.equal(payload.row.phase, "reviewable");
  assert.equal(payload.row.action, "redispatch");
  assert.equal(payload.row.pr_number, null);
  assert.ok(Array.isArray(payload.row.blockers));
  assert.match(payload.row.run_path, /run\.json$/);
});
