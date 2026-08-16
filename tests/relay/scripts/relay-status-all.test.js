"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const { createRunRecord } = runStore;

const ROOT = path.resolve(__dirname, "../../..");
const STATUS = path.join(ROOT, "skills/relay/scripts/relay-status.js");
const { applyGcCandidate, scanAllRuns, worktreeCandidates } = require(STATUS);
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

function started(runId, index = 1, attemptId = "attempt-1") {
  return baseFact(runId, "attempt_started", index, {
    executor: "codex", model: "gpt-5.6-sol", start_sha: SHA,
    host_kind: "local_supervisor", host_handle: "fixture",
    stdout_path: "/tmp/stdout", stderr_path: "/tmp/stderr", result_path: "/tmp/result",
    timeout_ms: 60_000,
  }, attemptId);
}

function finished(runId, index = 2, attemptId = "attempt-1") {
  return baseFact(runId, "attempt_finished", index, {
    status: "completed", start_sha: SHA, final_sha: TARGET, tree_sha: TARGET,
    result_path: "/tmp/result", exit_code: 0, verification_status: "passed",
  }, attemptId);
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

function reviewed(runId, index = 4, verdict = "lgtm") {
  return baseFact(runId, "review_recorded", index, {
    round: 1, verdict, reviewed_sha: TARGET,
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
  createRun(value, "retry-open", [
    started("retry-open"), finished("retry-open"), verified("retry-open"),
    reviewed("retry-open", 4, "changes_requested"), started("retry-open", 5, "attempt-2"),
  ]);
  createRun(value, "retry-dangling", [
    started("retry-dangling"), finished("retry-dangling"), verified("retry-dangling"),
    reviewed("retry-dangling", 4, "changes_requested"),
    started("retry-dangling", 5, "attempt-2"), finished("retry-dangling", 6, "attempt-2"),
  ]);
  createRun(value, "merged-unclosed", [started("merged-unclosed"), finished("merged-unclosed"), merged("merged-unclosed")], { local: false });

  const terminalCandidate = path.join(relayHome, "worktrees", slug, "terminal-aged");
  const terminalWorktree = marker(path.join(terminalCandidate, "repo"), "terminal");
  createRun(value, "terminal-aged", [closed("terminal-aged")], { worktree: terminalWorktree, age: 30 });
  const youngCandidate = path.join(relayHome, "worktrees", slug, "terminal-young");
  const youngWorktree = marker(path.join(youngCandidate, "repo"), "young");
  createRun(value, "terminal-young", [closed("terminal-young")], { worktree: youngWorktree, age: 2 });
  const nonTerminalCandidate = path.join(relayHome, "worktrees", slug, "protected-open");
  const nonTerminalWorktree = marker(path.join(nonTerminalCandidate, "repo"), "protected");
  createRun(value, "protected-open", [started("protected-open")], { worktree: nonTerminalWorktree });
  const mismatchCandidate = path.join(relayHome, "worktrees", slug, "binding-mismatch");
  const mismatchWorktree = marker(path.join(mismatchCandidate, "repo"), "mismatch");
  createRun(value, "binding-mismatch", [closed("binding-mismatch")], { worktree: path.join(root, "different-worktree"), age: 30 });

  const legacyRun = path.join(runs, "legacy-run");
  fs.mkdirSync(legacyRun);
  fs.writeFileSync(path.join(legacyRun, "legacy.json"), "{}\n");
  const legacyCandidate = path.join(relayHome, "worktrees", slug, "legacy-run");
  const legacyBound = marker(path.join(legacyCandidate, "repo"), "legacy");
  const version2Candidate = path.join(relayHome, "worktrees", slug, "version-2");
  const version2Bound = marker(path.join(version2Candidate, "repo"), "version-2");
  const version2Run = createRun(value, "version-2", [], { worktree: version2Bound });
  const version2Path = path.join(version2Run, "run.json");
  const version2Record = JSON.parse(fs.readFileSync(version2Path, "utf8"));
  fs.writeFileSync(version2Path, `${JSON.stringify({ ...version2Record, version: 2 }, null, 2)}\n`);
  fs.writeFileSync(path.join(version2Run, "events.jsonl"), "not durable facts\n");
  const orphanCandidate = path.join(relayHome, "worktrees", slug, "orphan-current");
  const orphanCurrent = marker(path.join(orphanCandidate, "repo"), "orphan-current");
  fs.writeFileSync(path.join(orphanCandidate, "root-marker.txt"), "remove the candidate root\n");
  const legacyHash = marker(path.join(relayHome, "worktrees", "abcdef123456"), "legacy-hash");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    ...value,
    terminalCandidate, terminalWorktree,
    youngCandidate, youngWorktree,
    nonTerminalCandidate, nonTerminalWorktree,
    mismatchCandidate, mismatchWorktree,
    legacyCandidate, legacyBound,
    version2Candidate, version2Bound, version2Run,
    orphanCandidate, orphanCurrent,
    legacyHash,
  };
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
  assert.equal(classes.get("retry-open"), "attempt_open");
  assert.equal(classes.get("retry-dangling"), "attempt_dangling");
  assert.equal(classes.get("merged-unclosed"), "merged_unclosed");
  assert.match(output.runs.find((row) => row.run_id === "verified").next_command, /relay-advance\.js/);
  assert.match(output.runs.find((row) => row.run_id === "reviewed").next_command, /relay-recover\.js.*inspect/);
  assert.match(output.runs.find((row) => row.run_id === "retry-open").next_command, /relay-recover\.js.*inspect/);
  assert.doesNotMatch(output.runs.find((row) => row.run_id === "retry-open").next_command, /relay-advance\.js/);
  assert.equal(output.summary.terminal, 3);
  assert.deepEqual(output.terminal_runs.map((row) => row.run_id).sort(), ["binding-mismatch", "terminal-aged", "terminal-young"]);
  assert.equal(output.legacy.length, 1);
  assert.equal(output.legacy[0].repo_slug, value.slug);
  assert.deepEqual(output.legacy[0].paths, [path.join(value.runs, "legacy-run"), value.version2Run]);
  assert.equal(output.runs.some((row) => row.run_id === "version-2"), false);
  assert.equal(output.terminal_runs.some((row) => row.run_id === "version-2"), false);
  assert.deepEqual(treeSnapshot(value.relayHome), before);

  const text = run(["--all"], value.relayHome);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Terminal: 3/);
  assert.match(text.stdout, new RegExp(`Legacy: ${value.slug} count=2`));
  assert.equal(text.stdout.match(/^Legacy:/gm).length, 1);
});

test("a readable non-v3 record bypasses durable folding and GC ledger claims", (t) => {
  const value = fixture(t);
  const originalReadRunRecord = runStore.readRunRecord;
  t.mock.method(runStore, "readRunRecord", ({ runDir }) => {
    if (runDir === value.version2Run) {
      return JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    }
    return originalReadRunRecord({ runDir });
  });

  const scan = scanAllRuns({ relayHome: value.relayHome });
  assert.equal(scan.rows.some((row) => row.run_id === "version-2"), false);
  assert.equal(scan.terminalRows.some((row) => row.run_id === "version-2"), false);
  assert.ok(scan.legacyBySlug.get(value.slug).some((entry) => entry.path === value.version2Run));

  const candidate = worktreeCandidates(scan, { minAgeDays: 14 })
    .find((row) => row.worktree_path === value.version2Candidate);
  assert.equal(candidate.classification, "unprovable");
  assert.equal(candidate.reason, "legacy_bound");
  assert.equal(candidate.eligible, false);
});

test("--gc is a dry run and classifies both layouts without mutating bytes", (t) => {
  const value = fixture(t), before = treeSnapshot(value.relayHome);
  const result = run(["--all", "--gc", "--min-age-days", "14", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout), byPath = new Map(output.gc.candidates.map((row) => [row.worktree_path, row]));
  assert.equal(output.gc.apply, false);
  assert.equal(byPath.get(value.terminalCandidate).classification, "terminal_aged");
  assert.equal(byPath.get(value.orphanCandidate).classification, "orphan");
  assert.equal(byPath.get(value.legacyHash).classification, "unprovable");
  assert.equal(byPath.get(value.legacyHash).reason, "legacy_layout_unprovable");
  assert.equal(byPath.get(value.legacyHash).eligible, false);
  assert.equal(byPath.get(value.nonTerminalCandidate).reason, "non_terminal");
  assert.equal(byPath.get(value.legacyCandidate).reason, "legacy_bound");
  assert.equal(byPath.get(value.version2Candidate).classification, "unprovable");
  assert.equal(byPath.get(value.version2Candidate).reason, "legacy_bound");
  assert.equal(byPath.get(value.version2Candidate).eligible, false);
  assert.equal(byPath.get(value.youngCandidate).reason, "terminal_too_young");
  assert.equal(byPath.get(value.mismatchCandidate).classification, "terminal_aged");
  assert.deepEqual(output.gc.candidates.map((row) => row.worktree_path).sort(), [
    value.terminalCandidate,
    value.youngCandidate,
    value.nonTerminalCandidate,
    value.mismatchCandidate,
    value.legacyCandidate,
    value.version2Candidate,
    value.orphanCandidate,
    value.legacyHash,
  ].sort());
  assert.deepEqual(treeSnapshot(value.relayHome), before);
});

test("--gc --apply deletes only eligible revalidated paths and reports binding mismatch", (t) => {
  const value = fixture(t);
  const legacyHashBefore = treeSnapshot(value.legacyHash);
  const result = run(["--all", "--gc", "--apply", "--min-age-days=14", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout), byPath = new Map(output.gc.candidates.map((row) => [row.worktree_path, row]));
  assert.equal(fs.existsSync(value.terminalCandidate), false);
  assert.equal(fs.existsSync(value.orphanCandidate), false);
  assert.equal(fs.existsSync(value.legacyHash), true);
  assert.deepEqual(treeSnapshot(value.legacyHash), legacyHashBefore);
  assert.equal(fs.readFileSync(path.join(value.nonTerminalWorktree, "marker.txt"), "utf8"), "protected");
  assert.equal(fs.readFileSync(path.join(value.legacyBound, "marker.txt"), "utf8"), "legacy");
  assert.equal(fs.readFileSync(path.join(value.version2Bound, "marker.txt"), "utf8"), "version-2");
  assert.equal(fs.readFileSync(path.join(value.youngWorktree, "marker.txt"), "utf8"), "young");
  assert.equal(fs.readFileSync(path.join(value.mismatchWorktree, "marker.txt"), "utf8"), "mismatch");
  assert.equal(fs.existsSync(value.mismatchCandidate), true);
  assert.equal(byPath.get(value.mismatchCandidate).applied, false);
  assert.ok(byPath.get(value.mismatchCandidate).diagnostics.some((entry) => entry.code === "worktree_binding_mismatch"));
  assert.equal(output.gc.summary.removed, 2);
  for (const runId of ["terminal-aged", "binding-mismatch", "legacy-run", "version-2"]) {
    assert.equal(fs.existsSync(path.join(value.runs, runId)), true, `${runId} run artifacts stay retained`);
  }
});

test("legacy top-level layout stays unprovable even with a v3 ledger claim", (t) => {
  const value = fixture(t);
  const scan = scanAllRuns({ relayHome: value.relayHome });
  scan.rows[0].record.git.worktree = path.join(value.legacyHash, "repo");

  const candidate = worktreeCandidates(scan, { minAgeDays: 14 })
    .find((row) => row.worktree_path === value.legacyHash);

  assert.equal(candidate.classification, "unprovable");
  assert.equal(candidate.reason, "claimed_by_ledger");
  assert.equal(candidate.eligible, false);
});

test("legacy top-level layout is reclaimable only when the machine-wide legacy ledger is empty", (t) => {
  const value = fixture(t);
  fs.rmSync(path.join(value.runs, "legacy-run"), { recursive: true });
  fs.rmSync(value.version2Run, { recursive: true });
  const result = run(["--all", "--gc", "--apply", "--json"], value.relayHome);
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(result.stdout).gc.candidates
    .find((row) => row.worktree_path === value.legacyHash);

  assert.equal(candidate.classification, "orphan");
  assert.equal(candidate.reason, "legacy_ledger_empty");
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.applied, true);
  assert.equal(fs.existsSync(value.legacyHash), false);
});

test("legacy top-level orphan apply skips deletion when a legacy run materializes after scan", (t) => {
  const value = fixture(t);
  fs.rmSync(path.join(value.runs, "legacy-run"), { recursive: true });
  fs.rmSync(value.version2Run, { recursive: true });
  const scan = scanAllRuns({ relayHome: value.relayHome });
  const candidate = worktreeCandidates(scan, { minAgeDays: 14 })
    .find((row) => row.worktree_path === value.legacyHash);
  const before = treeSnapshot(value.legacyHash);

  assert.equal(candidate.classification, "orphan");
  const materialized = path.join(value.relayHome, "runs", "another-repo", "legacy-run");
  fs.mkdirSync(materialized, { recursive: true });
  fs.writeFileSync(path.join(materialized, "legacy.json"), "{}\n");

  applyGcCandidate(candidate, scan, { minAgeDays: 14 });

  assert.equal(candidate.applied, false);
  assert.ok(candidate.diagnostics.some((entry) => entry.code === "legacy_run_appeared"));
  assert.deepEqual(treeSnapshot(value.legacyHash), before);
});

test("orphan apply skips deletion when the exact run directory materializes after scan", (t) => {
  const value = fixture(t);
  const scan = scanAllRuns({ relayHome: value.relayHome });
  const candidate = worktreeCandidates(scan, { minAgeDays: 14 })
    .find((row) => row.worktree_path === value.orphanCandidate);
  const before = treeSnapshot(value.orphanCandidate);

  assert.equal(candidate.layout, "current");
  assert.equal(candidate.classification, "orphan");
  fs.mkdirSync(candidate.run_dir, { recursive: true });

  applyGcCandidate(candidate, scan, { minAgeDays: 14 });

  assert.equal(candidate.applied, false);
  assert.ok(candidate.diagnostics.some((entry) => entry.code === "run_directory_appeared"));
  assert.deepEqual(treeSnapshot(value.orphanCandidate), before);
});

test("threshold boundary and strict flag adjacency fail closed", (t) => {
  const value = fixture(t);
  const protectedAt31 = run(["--all", "--gc", "--min-age-days", "31", "--json"], value.relayHome);
  assert.equal(protectedAt31.status, 0, protectedAt31.stderr);
  const terminal = JSON.parse(protectedAt31.stdout).gc.candidates.find((row) => row.worktree_path === value.terminalCandidate);
  assert.equal(terminal.classification, "unprovable");
  assert.equal(terminal.reason, "terminal_too_young");

  const adjacent = run(["--all", "--min-age-days", "--json"], value.relayHome);
  assert.notEqual(adjacent.status, 0);
  assert.match(adjacent.stderr, /--min-age-days requires a non-empty value/);
  const unknown = run(["--all", "--min-age-days", "--wat", "--json"], value.relayHome);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flags: --wat/);
  const singleRunRepoUnknown = run(["--repo", "--wat", "--run-id", "fixture"], value.relayHome);
  assert.notEqual(singleRunRepoUnknown.status, 0);
  assert.match(singleRunRepoUnknown.stderr, /unknown flags: --wat/);
  const singleRunIdUnknown = run(["--run-id", "-wat"], value.relayHome);
  assert.notEqual(singleRunIdUnknown.status, 0);
  assert.match(singleRunIdUnknown.stderr, /unknown flags: -wat/);
  const applyWithoutGc = run(["--all", "--apply", "--json"], value.relayHome);
  assert.notEqual(applyWithoutGc.status, 0);
  assert.match(applyWithoutGc.stderr, /--apply requires --gc/);
});
