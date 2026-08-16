"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");

const ROOT = path.resolve(__dirname, "../../..");
const STATUS = path.join(ROOT, "skills/relay/scripts/relay-status.js");
const SHA = "a".repeat(40);
const TARGET = "b".repeat(40);
const HASH = "c".repeat(64);

function run(args, relayHome) {
  return spawnSync(process.execPath, [STATUS, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: relayHome },
    timeout: 60_000,
  });
}

function atDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function baseFact(runId, type, index, payload, attemptId = null) {
  return {
    event_id: `${runId}-${index}`,
    run_id: runId,
    ...(attemptId ? { attempt_id: attemptId } : {}),
    type,
    at: new Date(Date.now() - (30 - index / 100) * 86_400_000).toISOString(),
    actor: "operator",
    payload,
  };
}

function started(runId, index = 1) {
  return baseFact(runId, "attempt_started", index, {
    executor: "codex", model: "gpt-5.6-sol", start_sha: SHA,
    host_kind: "local_supervisor", host_handle: "fixture",
    stdout_path: "/tmp/stdout", stderr_path: "/tmp/stderr", result_path: "/tmp/result",
    timeout_ms: 60_000,
  }, "attempt-1");
}

function finished(runId, index = 2) {
  return baseFact(runId, "attempt_finished", index, {
    status: "completed", start_sha: SHA, final_sha: TARGET, tree_sha: TARGET,
    result_path: "/tmp/result", exit_code: 0, verification_status: "passed",
  }, "attempt-1");
}

function verified(runId, index = 3) {
  return baseFact(runId, "verification_recorded", index, {
    head_sha: TARGET, tree_sha: TARGET, done_criteria_sha256: HASH,
    command: "node --test", verification_request_sha256: HASH,
    declared_command_count: 1, completed_command_count: 1,
    result_path: "/tmp/verification", result_sha256: HASH,
    exit_code: 0, status: "passed", operator: "operator",
  });
}

function reviewed(runId, index = 4) {
  return baseFact(runId, "review_recorded", index, {
    round: 1, verdict: "lgtm", reviewed_sha: TARGET,
    done_criteria_sha256: HASH, reviewer: "reviewer",
    review_artifact: "/tmp/review", override: null,
  });
}

function merged(runId, index = 5) {
  return baseFact(runId, "merge_recorded", index, {
    pr_number: 1265, reviewed_source_sha: TARGET, pr_head_sha: TARGET,
    result_target_sha: SHA, method: "squash", operator: "operator",
    override_reason: null, operation_id: "merge-op", authorization_id: "merge-auth",
    observation_nonce: "nonce", done_criteria_sha256: HASH,
  });
}

function closed(runId, index = 5) {
  return baseFact(runId, "run_closed", index, {
    reason: "operator", operator: "operator", last_sha: TARGET, pr_number: null,
  });
}

function createRun(value, runId, facts, { age = 30, worktree = null, local = true } = {}) {
  const runDir = path.join(value.runs, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const criteria = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteria, "- cockpit fixture\n");
  const criteriaHash = crypto.createHash("sha256").update(fs.readFileSync(criteria)).digest("hex");
  createRunRecord({ runDir, record: {
    version: 3,
    run_id: runId,
    repo: { root: value.repo, remote: local ? "local/repo" : "owner/repo" },
    git: { branch: runId, base_branch: "main", worktree: worktree || path.join(value.root, "missing", runId), start_sha: SHA },
    contract: { done_criteria_path: criteria, done_criteria_sha256: criteriaHash },
    roles: { orchestrator: "operator", executor: "codex", reviewer: "reviewer" },
    parent: null,
    ownership_digest: null,
    created_at: atDaysAgo(age),
  } });
  if (facts.length) fs.writeFileSync(path.join(runDir, "events.jsonl"), `${facts.map(JSON.stringify).join("\n")}\n`);
  return runDir;
}

function marker(directory, content) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "marker.txt"), content);
  return directory;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-all-")));
  const relayHome = path.join(root, "relay-home");
  const slug = "repo-fixture123";
  const runs = path.join(relayHome, "runs", slug);
  const repo = path.join(root, "repo");
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(repo);
  const value = { root, relayHome, slug, runs, repo };

  createRun(value, "empty", []);
  createRun(value, "attempt-open", [started("attempt-open")]);
  createRun(value, "attempt-dangling", [started("attempt-dangling"), finished("attempt-dangling")]);
  createRun(value, "verified", [started("verified"), finished("verified"), verified("verified")]);
  createRun(value, "reviewed", [started("reviewed"), finished("reviewed"), verified("reviewed"), reviewed("reviewed")]);
  createRun(value, "merged-unclosed", [started("merged-unclosed"), finished("merged-unclosed"), merged("merged-unclosed")], { local: false });

  const terminalWorktree = marker(path.join(relayHome, "worktrees", slug, "terminal-aged", "repo"), "terminal");
  createRun(value, "terminal-aged", [closed("terminal-aged")], { worktree: terminalWorktree, age: 30 });
  const youngWorktree = marker(path.join(relayHome, "worktrees", slug, "terminal-young", "repo"), "young");
  createRun(value, "terminal-young", [closed("terminal-young")], { worktree: youngWorktree, age: 2 });
  const nonTerminalWorktree = marker(path.join(relayHome, "worktrees", slug, "protected-open", "repo"), "protected");
  createRun(value, "protected-open", [started("protected-open")], { worktree: nonTerminalWorktree });
  const mismatchWorktree = marker(path.join(relayHome, "worktrees", slug, "binding-mismatch", "repo"), "mismatch");
  createRun(value, "binding-mismatch", [closed("binding-mismatch")], { worktree: path.join(root, "different-worktree"), age: 30 });

  const legacyRun = path.join(runs, "legacy-run");
  fs.mkdirSync(legacyRun);
  fs.writeFileSync(path.join(legacyRun, "legacy.json"), "{}\n");
  const legacyBound = marker(path.join(relayHome, "worktrees", slug, "legacy-run", "repo"), "legacy");
  const orphanCurrent = marker(path.join(relayHome, "worktrees", slug, "orphan-current", "repo"), "orphan-current");
  const orphanHash = marker(path.join(relayHome, "worktrees", "abcdef123456"), "orphan-hash");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...value, terminalWorktree, youngWorktree, nonTerminalWorktree, mismatchWorktree, legacyBound, orphanCurrent, orphanHash };
}

function treeSnapshot(root) {
  const rows = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name), relative = path.relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        visit(full);
      } else {
        rows.push(`f:${relative}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
      }
    }
  }
  visit(root);
  return rows;
}

test("--all classifies every durable state, summarizes legacy and is byte-preserving", (t) => {
  const value = fixture(t), before = treeSnapshot(value.relayHome);
  const result = run(["--all", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const classes = new Map(output.runs.map((row) => [row.run_id, row.classification]));
  assert.equal(classes.get("empty"), "empty");
  assert.equal(classes.get("attempt-open"), "attempt_open");
  assert.equal(classes.get("attempt-dangling"), "attempt_dangling");
  assert.equal(classes.get("verified"), "verified");
  assert.equal(classes.get("reviewed"), "reviewed");
  assert.equal(classes.get("merged-unclosed"), "merged_unclosed");
  assert.match(output.runs.find((row) => row.run_id === "verified").next_command, /relay-advance\.js/);
  assert.match(output.runs.find((row) => row.run_id === "reviewed").next_command, /relay-recover\.js.*inspect/);
  assert.equal(output.summary.terminal, 3);
  assert.deepEqual(output.terminal_runs.map((row) => row.run_id).sort(), ["binding-mismatch", "terminal-aged", "terminal-young"]);
  assert.equal(output.legacy.length, 1);
  assert.equal(output.legacy[0].repo_slug, value.slug);
  assert.deepEqual(output.legacy[0].paths, [path.join(value.runs, "legacy-run")]);
  assert.deepEqual(treeSnapshot(value.relayHome), before);

  const text = run(["--all"], value.relayHome);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Terminal: 3/);
  assert.match(text.stdout, new RegExp(`Legacy: ${value.slug} count=1`));
  assert.equal(text.stdout.match(/^Legacy:/gm).length, 1);
});

test("--gc is a dry run and classifies both layouts without mutating bytes", (t) => {
  const value = fixture(t), before = treeSnapshot(value.relayHome);
  const result = run(["--all", "--gc", "--min-age-days", "14", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout), byPath = new Map(output.gc.candidates.map((row) => [row.worktree_path, row]));
  assert.equal(output.gc.apply, false);
  assert.equal(byPath.get(value.terminalWorktree).classification, "terminal_aged");
  assert.equal(byPath.get(value.orphanCurrent).classification, "orphan");
  assert.equal(byPath.get(value.orphanHash).classification, "orphan");
  assert.equal(byPath.get(value.nonTerminalWorktree).reason, "non_terminal");
  assert.equal(byPath.get(value.legacyBound).reason, "legacy_bound");
  assert.equal(byPath.get(value.youngWorktree).reason, "terminal_too_young");
  assert.equal(byPath.get(value.mismatchWorktree).classification, "terminal_aged");
  assert.deepEqual(treeSnapshot(value.relayHome), before);
});

test("--gc --apply deletes only eligible revalidated paths and reports binding mismatch", (t) => {
  const value = fixture(t);
  const result = run(["--all", "--gc", "--apply", "--min-age-days=14", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout), byPath = new Map(output.gc.candidates.map((row) => [row.worktree_path, row]));
  assert.equal(fs.existsSync(value.terminalWorktree), false);
  assert.equal(fs.existsSync(value.orphanCurrent), false);
  assert.equal(fs.existsSync(value.orphanHash), false);
  assert.equal(fs.readFileSync(path.join(value.nonTerminalWorktree, "marker.txt"), "utf8"), "protected");
  assert.equal(fs.readFileSync(path.join(value.legacyBound, "marker.txt"), "utf8"), "legacy");
  assert.equal(fs.readFileSync(path.join(value.youngWorktree, "marker.txt"), "utf8"), "young");
  assert.equal(fs.readFileSync(path.join(value.mismatchWorktree, "marker.txt"), "utf8"), "mismatch");
  assert.equal(byPath.get(value.mismatchWorktree).applied, false);
  assert.ok(byPath.get(value.mismatchWorktree).diagnostics.some((entry) => entry.code === "worktree_binding_mismatch"));
  assert.equal(output.gc.summary.removed, 3);
  for (const runId of ["terminal-aged", "binding-mismatch", "legacy-run"]) {
    assert.equal(fs.existsSync(path.join(value.runs, runId)), true, `${runId} run artifacts stay retained`);
  }
});

test("threshold boundary and strict flag adjacency fail closed", (t) => {
  const value = fixture(t);
  const protectedAt31 = run(["--all", "--gc", "--min-age-days", "31", "--json"], value.relayHome);
  assert.equal(protectedAt31.status, 0, protectedAt31.stderr);
  const terminal = JSON.parse(protectedAt31.stdout).gc.candidates.find((row) => row.worktree_path === value.terminalWorktree);
  assert.equal(terminal.classification, "unprovable");
  assert.equal(terminal.reason, "terminal_too_young");

  const adjacent = run(["--all", "--min-age-days", "--json"], value.relayHome);
  assert.notEqual(adjacent.status, 0);
  assert.match(adjacent.stderr, /--min-age-days requires a non-empty value/);
  const unknown = run(["--all", "--min-age-days", "--wat", "--json"], value.relayHome);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flags: --wat/);
  const applyWithoutGc = run(["--all", "--apply", "--json"], value.relayHome);
  assert.notEqual(applyWithoutGc.status, 0);
  assert.match(applyWithoutGc.stderr, /--apply requires --gc/);
});
