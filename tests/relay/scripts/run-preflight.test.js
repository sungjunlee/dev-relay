"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const {
  checkInflightRuns,
  routeFromInflight,
  snapshotReview,
} = require("../../../skills/relay/scripts/run-preflight");

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "skills/relay/scripts/run-preflight.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-preflight-")));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.name", "Preflight Test"]);
  git(repo, ["config", "user.email", "preflight@example.test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const canonical = fs.realpathSync(repo);
  const slug = `${path.basename(canonical)}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
  const runs = path.join(relayHome, "runs", slug);
  const worktreeBase = path.join(relayHome, "worktrees");
  fs.mkdirSync(worktreeBase, { recursive: true });
  const gh = path.join(root, "gh.js");
  fs.writeFileSync(gh, "#!/usr/bin/env node\nprocess.stdout.write('[]')\n");
  fs.chmodSync(gh, 0o755);
  return { root, repo: canonical, remote, relayHome, runs, worktreeBase, gh };
}

function createRun(value, issue = 802) {
  const runId = `issue-${issue}-20260801000000001`;
  const runDir = path.join(value.runs, runId);
  const worktree = path.join(value.worktreeBase, runId);
  fs.mkdirSync(runDir, { recursive: true });
  execFileSync("git", ["-C", value.repo, "worktree", "add", "-b", `issue-${issue}`, worktree, "main"], { stdio: "ignore" });
  const source = path.join(runDir, "source.md");
  fs.writeFileSync(source, "- preflight uses canonical inspect\n");
  const frozen = runStore.freezeDoneCriteria({ sourcePath: source, runDir });
  fs.unlinkSync(source);
  runStore.createRunRecord({ runDir, record: {
    version: 3,
    run_id: runId,
    repo: { root: value.repo, remote: value.remote },
    git: { branch: `issue-${issue}`, base_branch: "main", worktree, start_sha: git(worktree, ["rev-parse", "HEAD"]) },
    contract: { done_criteria_path: frozen.path, done_criteria_sha256: frozen.sha256 },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00.000Z",
  } });
  return { runId, runDir };
}

function run(value, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: value.relayHome, RELAY_GH_BIN: value.gh },
  });
}

test("route stage emits only the inflight dedup guard, never a readiness envelope", () => {
  const value = fixture();
  const created = createRun(value, 805);
  const result = run(value, ["--stage", "route", "--repo", value.repo, "--issue-number", "805"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["ok", "stage", "repo", "inflight"]);
  assert.equal(payload.ok, true);
  assert.equal(payload.stage, "route");
  assert.deepEqual(Object.keys(payload.inflight), [
    "issueNumber", "branch", "pull_request", "run", "route", "instruction", "next_action", "prNumber", "runId",
  ]);
  assert.equal(payload.inflight.route, "inflight-run");
  assert.equal(payload.inflight.next_action, "resume_or_inspect_inflight_run");
  assert.equal(payload.inflight.branch, "issue-805");
  assert.equal(payload.inflight.runId, created.runId);
});

test("route stage with no PR and no inflight run continues without readiness plumbing", () => {
  const value = fixture();
  const result = run(value, ["--stage", "route", "--repo", value.repo, "--issue-number", "900"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.inflight.route, "continue");
  assert.equal(payload.inflight.next_action, "continue_to_readiness");
  assert.equal(payload.inflight.pull_request.status, "not_found");
  assert.equal(payload.inflight.run.status, "not_found");
  assert.equal("readiness" in payload, false);
});

test("retired readiness route flags fail closed instead of being silently ignored", () => {
  const value = fixture();
  for (const flag of [
    "--skip-readiness", "--bypass-readiness", "--non-interactive",
    "--body", "--body-file", "--skip-readiness-reason",
  ]) {
    const result = run(value, ["--stage", "route", "--repo", value.repo, "--issue-number", "901", flag, "x"]);
    assert.notEqual(result.status, 0, `${flag} must be rejected`);
    assert.match(`${result.stdout}${result.stderr}`, /unknown flags/, flag);
  }
});

test("route stage no longer shells out to any readiness probe", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(source, /probe-readiness|score-readiness|readiness_probe|bypass_override_by_user/);
});

test("inflight scanner failures remain fail-closed", async () => {
  const runCheck = await checkInflightRuns("/repo", 404, async () => { throw new Error("invalid Relay run ledger"); });
  const route = routeFromInflight({ prCheck: { status: "not_found", pr: null }, runCheck });
  assert.equal(route.route, "attention");
  assert.equal(route.reason, "invalid Relay run ledger");
});

test("review snapshot trusts canonical derived reviewed_sha, not a raw fact fallback", () => {
  const record = { run_id: "issue-1-20260809000000001", git: { branch: "issue-1" } };
  const inspection = {
    derived: { head_sha: "a".repeat(40), phase: "reviewable" },
    facts: [{
      type: "review_recorded",
      payload: { verdict: "lgtm", reviewed_sha: "a".repeat(40) },
    }],
    recommended_action: { kind: "review", reason: "review required" },
    blockers: [],
  };

  const snapshot = snapshotReview(record, "/tmp/run", inspection);
  assert.equal(snapshot.last_reviewed_sha, null);
  assert.equal(snapshot.sha_state, "not_reviewed");
});

test("review preflight black box consumes the same canonical inspect action", () => {
  const value = fixture();
  const created = createRun(value);
  const result = run(value, ["--stage", "review", "--repo", value.repo, "--run-id", created.runId]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.snapshot.phase, "reviewable");
  assert.equal(payload.snapshot.action, payload.inspection.action.kind);
  assert.equal(payload.ready_status.next_action, payload.inspection.action.kind);
  assert.match(payload.snapshot.run_path, /run\.json$/);
  assert.equal(payload.recovery, null);
});

test("merge preflight consumes the identical canonical inspect action", () => {
  const value = fixture();
  const created = createRun(value, 803);
  const result = run(value, ["--stage", "merge", "--repo", value.repo, "--run-id", created.runId]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stage, "merge");
  assert.equal(payload.snapshot.action, payload.inspection.action.kind);
  assert.deepEqual(payload.snapshot.blockers, payload.inspection.blockers);
});

test("reconcile and recover require an explicit audit reason before mutation", () => {
  const value = fixture();
  const created = createRun(value);
  for (const flag of ["--reconcile", "--recover"]) {
    const result = run(value, ["--stage", "review", "--repo", value.repo, "--run-id", created.runId, flag]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /requires --reason/);
  }
});

test("recover delegates to canonical runtime recovery with the inspected action key", () => {
  const value = fixture();
  const created = createRun(value, 804);
  const result = run(value, [
    "--stage", "review", "--repo", value.repo, "--run-id", created.runId,
    "--recover", "--reason", "operator-audited preflight recovery",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.recovery.operation, "recover");
  assert.match(payload.recovery.action_key, /^[0-9a-f]{64}$/);
  assert.equal(payload.recovery.action_key, payload.recovery.before.recommended_action.key);
});

test("production sources no longer import legacy observation or mutation modules", () => {
  const sources = [
    fs.readFileSync(SCRIPT, "utf8"),
    fs.readFileSync(path.join(ROOT, "skills/relay/scripts/relay-status.js"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(sources, /manifest\/(?:lifecycle|store)|relay-events|relay-resolver|run-observer|reconcile-findings/);
});
