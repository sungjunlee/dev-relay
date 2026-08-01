"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const { inspectRun, recoverRun } = recovery;

const START = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const TARGET = "d".repeat(40);
const HASH = "e".repeat(64);

function runRecord(runId = "issue-1135-test") {
  return {
    version: 3,
    run_id: runId,
    repo: { root: "/repo", remote: "owner/repo" },
    git: { branch: "issue-1135", base_branch: "main", worktree: "/repo/wt", start_sha: START },
    contract: { done_criteria_path: "/run/done.md", done_criteria_sha256: HASH },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function harness({ facts = [], observations = {}, record = runRecord() } = {}) {
  const state = {
    facts: structuredClone(facts),
    observations: structuredClone(observations),
    effects: [],
    receipts: new Map(),
    intent: null,
    writes: 0,
  };
  const readSnapshot = async () => ({
    runDir: "/run",
    runRecord: record,
    facts: structuredClone(state.facts),
    snapshot: {
      run_sha256: digest(record),
      facts_sha256: digest(state.facts),
      fact_count: state.facts.length,
      last_event_id: state.facts.at(-1)?.event_id || null,
      tail_status: "complete",
    },
  });
  const observer = async () => structuredClone(state.observations);
  const appendFact = async (fact) => {
    const existing = state.facts.find((entry) => entry.event_id === fact.event_id);
    if (!existing) state.facts.push(structuredClone(fact));
  };
  return {
    state,
    readSnapshot,
    observer,
    appendFact,
    withLock: async (callback) => callback(),
    readIntent: async () => (
      state.intent && !state.receipts.has(state.intent.action_key)
        ? structuredClone(state.intent)
        : null
    ),
    writeIntent: async ({ intent }) => {
      if (state.intent && JSON.stringify(state.intent) !== JSON.stringify(intent)) {
        throw new Error("intent conflict");
      }
      state.intent = structuredClone(intent);
    },
    readReceipt: async ({ actionKey }) => state.receipts.get(actionKey) || null,
    writeReceipt: async ({ actionKey, receipt }) => {
      state.writes += 1;
      state.receipts.set(actionKey, structuredClone(receipt));
    },
  };
}

function attemptFinished(verificationStatus = "not_declared") {
  return {
    event_id: "attempt-finished",
    run_id: "issue-1135-test",
    attempt_id: "attempt-1",
    type: "attempt_finished",
    at: "2026-08-01T00:01:00Z",
    actor: "codex",
    payload: {
      status: "completed",
      start_sha: START,
      final_sha: HEAD,
      tree_sha: TREE,
      result_path: "/run/result.txt",
      exit_code: 0,
      verification_status: verificationStatus,
    },
  };
}

function closedFact() {
  return {
    event_id: "closed",
    run_id: "issue-1135-test",
    type: "run_closed",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: { reason: "done", operator: "owner", last_sha: HEAD, pr_number: null },
  };
}

function pullRequestFact(headSha = START) {
  return {
    event_id: `pr-${headSha.slice(0, 4)}`,
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42,
      repo: "owner/repo",
      head_ref: "issue-1135",
      base_ref: "main",
      head_sha: headSha,
      created_by_relay: true,
    },
  };
}

function publicationObservations(overrides = {}) {
  return {
    git: {
      head_sha: HEAD,
      tree_sha: TREE,
      branch_commit_exists: true,
      reviewable_work: true,
      reviewable_dirty: false,
      remote_head_sha: null,
      remote_relation: "behind_local",
    },
    github: {
      available: true,
      pr_lookup_complete: true,
      matching_pr_count: 0,
      repo: "owner/repo",
      pr_number: null,
      pr_state: null,
      head_ref: "issue-1135",
      base_ref: "main",
      pr_head_sha: null,
      merge_sha: null,
    },
    host: { live: false },
    verification: { pending: false },
    ...overrides,
  };
}

test("inspect is byte-read-only and emits one stable recommended action", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const before = structuredClone(h.state);
  const first = await inspectRun(h);
  const second = await inspectRun(h);
  assert.deepEqual(h.state, before);
  assert.equal(first.recommended_action.kind, "recover");
  assert.deepEqual(first.recommended_action.steps, ["push_branch", "record_or_create_pr"]);
  assert.equal(first.recommended_action.key, second.recommended_action.key);
  assert.deepEqual(first.facts, [attemptFinished()]);
});

test("recover refuses a stale inspect key before effects or durable writes", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const effects = { converge: async (step) => { h.state.effects.push(step); return { converged: true }; } };
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "recover publication",
    expectedActionKey: "0".repeat(64),
    effects,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "stale_action");
  assert.deepEqual(h.state.effects, []);
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("recover rejects a path-shaped expected action key before ownership or reads", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  let lockCalls = 0;
  await assert.rejects(recoverRun({
    ...h,
    withLock: async (callback) => { lockCalls += 1; return callback(); },
    actor: "owner",
    reason: "must not traverse",
    expectedActionKey: "../../outside",
    effects: { converge: async () => { throw new Error("effect called"); } },
  }), /lowercase SHA-256/);
  assert.equal(lockCalls, 0);
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("recover rejects a regular forged receipt without its durable completion fact", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const inspected = await inspectRun(h);
  const key = inspected.recommended_action.key;
  h.state.receipts.set(key, {
    schema_version: 1,
    operation_id: `recover-${key.slice(0, 32)}`,
    action_key: key,
    fact_event_ids: ["forged-completion"],
  });
  let effectCalls = 0;
  await assert.rejects(recoverRun({
    ...h,
    actor: "owner",
    reason: "must verify receipt",
    expectedActionKey: key,
    effects: { converge: async () => { effectCalls += 1; return { converged: true }; } },
  }), /missing durable fact/);
  assert.equal(effectCalls, 0);
  assert.deepEqual(h.state.facts, [attemptFinished()]);
});

test("terminal recovery is a no-write noop", async () => {
  const h = harness({ facts: [closedFact()], observations: publicationObservations() });
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "must not reopen",
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(result.status, "noop");
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("terminal run refuses an unrelated active intent without publishing a receipt", async () => {
  const h = harness({ facts: [closedFact()], observations: publicationObservations() });
  const unrelatedKey = "1".repeat(64);
  h.state.intent = {
    schema_version: 1,
    action_key: unrelatedKey,
    operation_id: `recover-${unrelatedKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:01:30Z",
    steps: ["record_external_merge"],
    actor: "owner",
    reason: "unrelated abandoned operation",
    reason_code: "merged_pr_unrecorded",
    observed_event_id: "older-pr",
    before_sha: HEAD,
  };
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "unrelated abandoned operation",
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "terminal_intent_mismatch");
  assert.equal(result.receipt, null);
  assert.equal(h.state.receipts.size, 0);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.facts.length, 1);
});

test("effect-before-fact retry reuses the exact PR and appends each deterministic fact once", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  let prCreates = 0;
  let failFirstPrFact = true;
  const effects = {
    converge: async (step, context) => {
      h.state.effects.push(step);
      if (step === "push_branch") {
        h.state.observations.git.remote_head_sha = HEAD;
        h.state.observations.git.remote_relation = "equal";
        return { converged: true, applied: h.state.effects.filter((entry) => entry === step).length === 1 };
      }
      assert.equal(step, "record_or_create_pr");
      if (!h.state.observations.github.pr_number) {
        prCreates += 1;
        Object.assign(h.state.observations.github, {
          matching_pr_count: 1,
          pr_number: 42,
          pr_state: "OPEN",
          pr_head_sha: HEAD,
        });
      }
      return {
        converged: true,
        applied: prCreates === 1,
        fact: {
          type: "pull_request_recorded",
          at: "2026-08-01T00:03:00Z",
          actor: "owner",
          payload: {
            pr_number: 42,
            repo: "owner/repo",
            head_ref: "issue-1135",
            base_ref: "main",
            head_sha: HEAD,
            created_by_relay: true,
          },
        },
      };
    },
  };
  const appendFact = async (fact) => {
    if (fact.type === "pull_request_recorded" && failFirstPrFact) {
      failFirstPrFact = false;
      throw new Error("crash_after_pr_effect");
    }
    await h.appendFact(fact);
  };
  await assert.rejects(recoverRun({
    ...h, appendFact, actor: "owner", reason: "publish", effects,
  }), /crash_after_pr_effect/);
  const retry = await recoverRun({
    ...h, appendFact, actor: "owner", reason: "publish", effects,
  });
  assert.equal(retry.status, "converged");
  assert.equal(prCreates, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "pull_request_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 1);

  const factBytes = JSON.stringify(h.state.facts);
  const effectCount = h.state.effects.length;
  const receiptWrites = h.state.writes;
  const again = await recoverRun({
    ...h, appendFact, actor: "owner", reason: "publish", effects,
    expectedActionKey: retry.action_key,
  });
  assert.equal(again.status, "noop");
  assert.equal(JSON.stringify(h.state.facts), factBytes);
  assert.equal(h.state.effects.length, effectCount);
  assert.equal(h.state.writes, receiptWrites);
  assert.equal(prCreates, 1);
});

test("an externally merged PR derives only the terminal provenance step", async () => {
  const pr = {
    event_id: "pr",
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
      head_sha: HEAD, created_by_relay: true,
    },
  };
  const h = harness({
    facts: [attemptFinished(), pr],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, ["record_external_merge"]);
});

test("an unrelated historical MERGED PR cannot become terminal without a durable PR identity", async () => {
  const h = harness({
    facts: [attemptFinished()],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 7, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "publication_incomplete");
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "unrecorded_merged_pr");
  assert.deepEqual(inspected.recommended_action.steps, []);
});

test("a MERGED PR with a different recorded head also requires operator attention", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(START)],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "merged_pr_unrecorded");
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "unrecorded_merged_pr");
});

test("an open PR with local head drift pushes, refreshes its durable head, then verifies", async () => {
  const observations = publicationObservations({
    git: {
      ...publicationObservations().git,
      remote_head_sha: START,
      remote_relation: "behind_local",
    },
    github: {
      available: true,
      pr_lookup_complete: true,
      matching_pr_count: 1,
      repo: "owner/repo",
      pr_number: 42,
      pr_state: "OPEN",
      head_ref: "issue-1135",
      base_ref: "main",
      pr_head_sha: START,
      merge_sha: null,
    },
  });
  const h = harness({ facts: [attemptFinished(), pullRequestFact(START)], observations });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, [
    "push_branch",
    "record_or_create_pr",
    "record_verification",
  ]);

  h.state.observations.git.remote_head_sha = HEAD;
  h.state.observations.git.remote_relation = "equal";
  h.state.observations.github.pr_head_sha = HEAD;
  const afterPush = await inspectRun(h);
  assert.deepEqual(afterPush.recommended_action.steps, [
    "record_or_create_pr",
    "record_verification",
  ]);
});

test("head-drift recovery durably refreshes the same PR without a fold conflict", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(START)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: START,
        remote_relation: "behind_local",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "OPEN",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: START, merge_sha: null,
      },
    }),
  });
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "refresh exact PR head",
    effects: {
      converge: async (step, context) => {
        if (step === "push_branch") {
          h.state.observations.git.remote_head_sha = HEAD;
          h.state.observations.git.remote_relation = "equal";
          h.state.observations.github.pr_head_sha = HEAD;
          return { converged: true, applied: true };
        }
        if (step === "record_or_create_pr") {
          return {
            converged: true,
            applied: false,
            fact: {
              type: "pull_request_recorded", at: context.intent.created_at, actor: "owner",
              payload: {
                pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
                head_sha: HEAD, created_by_relay: true,
              },
            },
          };
        }
        assert.equal(step, "record_verification");
        return {
          converged: true,
          applied: true,
          fact: {
            type: "verification_recorded", at: context.intent.created_at, actor: "owner",
            payload: {
              head_sha: HEAD, tree_sha: TREE, done_criteria_sha256: HASH,
              command: "node --test", verification_request_sha256: "f".repeat(64),
              declared_command_count: 1, completed_command_count: 1,
              result_path: "/run/verification.log", result_sha256: "f".repeat(64),
              exit_code: 0, status: "passed", operator: "owner",
            },
          },
        };
      },
    },
  });
  assert.equal(result.status, "converged");
  assert.equal(result.after.derived.reason, "review_missing");
  assert.notEqual(result.after.derived.reason, "fact_conflict");
  const prFacts = h.state.facts.filter((fact) => fact.type === "pull_request_recorded");
  assert.equal(prFacts.length, 2);
  assert.equal(prFacts.at(-1).payload.pr_number, 42);
  assert.equal(prFacts.at(-1).payload.head_sha, HEAD);
});

test("PR selection reuses exact OPEN, reconciles exact MERGED, and ignores CLOSED", () => {
  const row = (number, state, headRefOid = HEAD) => ({
    number,
    state,
    headRefName: "issue-1135",
    baseRefName: "main",
    headRefOid,
    headRepository: { nameWithOwner: "owner/repo" },
  });
  const options = {
    remote: "owner/repo",
    branch: "issue-1135",
    baseBranch: "main",
    localHeadSha: HEAD,
  };
  const mixed = recovery.__testing.selectGithubPr([
    row(40, "CLOSED"),
    row(42, "OPEN"),
  ], options);
  assert.equal(mixed.pr.number, 42);
  assert.equal(mixed.matchingPrCount, 1);
  assert.equal(mixed.closedPrCount, 1);

  const recordedClosed = recovery.__testing.selectGithubPr([
    row(40, "CLOSED"),
    row(42, "OPEN"),
  ], { ...options, recordedPrNumber: 40 });
  assert.equal(recordedClosed.pr.number, 40);
  assert.equal(recordedClosed.pr.state, "CLOSED");

  const closedOnly = recovery.__testing.selectGithubPr([row(40, "CLOSED")], options);
  assert.equal(closedOnly.pr, null);
  assert.equal(closedOnly.matchingPrCount, 0);

  const mergedExact = recovery.__testing.selectGithubPr([
    row(41, "OPEN", START),
    row(42, "MERGED", HEAD),
  ], options);
  assert.equal(mergedExact.pr.number, 42);
  assert.equal(mergedExact.pr.state, "MERGED");
});

test("a lone CLOSED PR is ignored so publication can create a new exact OPEN PR", async () => {
  const h = harness({
    facts: [attemptFinished()],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 0,
        identity_match_count: 1, open_pr_count: 0, merged_pr_count: 0, closed_pr_count: 1,
        repo: "owner/repo", pr_number: null, pr_state: null,
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: null, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, ["record_or_create_pr"]);
});

test("the exact CLOSED durable PR is exposed as a stable operator blocker", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "CLOSED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "github_pr_closed_unmerged");
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "github_pr_closed_unmerged");
});

test("verification refuses dirty reviewable bytes and special entries classify without reading", () => {
  assert.throws(() => recovery.__testing.assertCleanVerificationObservation({
    git: { reviewable_dirty: true },
  }), /reviewable worktree is dirty/);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-special-"));
  execFileSync("git", ["init", "--quiet", worktree]);
  const fifo = path.join(worktree, "executor.pipe");
  execFileSync("mkfifo", [fifo]);
  assert.deepEqual(
    recovery.__testing.unsafeWorktreeEntries(worktree, Buffer.from("?? executor.pipe\0")),
    ["executor.pipe"],
  );
});

test("dirty PR recovery commits and republishes before accepting verification", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        reviewable_dirty: true,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "OPEN",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.deepEqual(inspected.recommended_action.steps, [
    "commit_work", "push_branch", "record_or_create_pr", "record_verification",
  ]);
});

test("an untracked Unix socket is classified without connecting or reading", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-socket-"));
  execFileSync("git", ["init", "--quiet", worktree]);
  const socketPath = path.join(worktree, "executor.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.deepEqual(
      recovery.__testing.unsafeWorktreeEntries(worktree, Buffer.from("?? executor.sock\0")),
      ["executor.sock"],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ignored special entries are outside the reviewable recovery set", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-ignored-socket-"));
  execFileSync("git", ["init", "--quiet", worktree]);
  const socketPath = path.join(worktree, "ignored.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.deepEqual(recovery.__testing.unsafeWorktreeEntries(worktree, Buffer.alloc(0)), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("recovery_applied bytes remain stable when observed HEAD drifts after durable effects", () => {
  const intent = {
    operation_id: "recover-stable", created_at: "2026-08-01T00:00:00Z",
    actor: "operator", reason: "repair", reason_code: "publication_missing",
    observed_event_id: "observed", before_sha: START,
    steps: ["record_or_create_pr"],
  };
  const eventId = recovery.__testing.deterministicEventId(intent.operation_id, "record_or_create_pr");
  const applied = [{ step: "record_or_create_pr", fact_event_id: eventId }];
  const facts = [{ event_id: eventId, payload: { head_sha: HEAD } }];
  const first = recovery.__testing.recoveryAppliedFact({
    runId: "issue-1135", intent, applied, after: { facts, derived: { head_sha: HEAD } },
  });
  const retry = recovery.__testing.recoveryAppliedFact({
    runId: "issue-1135", intent, applied,
    after: { facts, derived: { head_sha: "f".repeat(40) } },
  });
  assert.deepEqual(retry, first);
  assert.equal(first.payload.after_sha, HEAD);
});

test("production mutation trust rejects repository root and active checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-trust-"));
  const repoRoot = path.join(root, "repo");
  const relayWorktreeBase = path.join(root, "relay-worktrees");
  const activeCheckout = path.join(relayWorktreeBase, "active");
  const trustedWorktree = path.join(relayWorktreeBase, "run-worktree");
  for (const directory of [repoRoot, activeCheckout, relayWorktreeBase, trustedWorktree]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  assert.equal(recovery.__testing.assertTrustedRecoveryWorktree({
    repoRoot,
    activeCheckout,
    relayWorktreeBase,
    worktree: trustedWorktree,
  }), fs.realpathSync(trustedWorktree));
  assert.throws(() => recovery.__testing.assertTrustedRecoveryWorktree({
    repoRoot,
    activeCheckout,
    relayWorktreeBase,
    worktree: repoRoot,
  }), /trusted relay worktree boundary/);
  assert.throws(() => recovery.__testing.assertTrustedRecoveryWorktree({
    repoRoot,
    activeCheckout,
    relayWorktreeBase,
    worktree: activeCheckout,
  }), /trusted relay worktree boundary/);
});

test("production recover refuses root and active-checkout identities before lock artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-production-trust-"));
  const repoRoot = path.join(root, "repo");
  const relayWorktreeBase = path.join(root, "relay-worktrees");
  const activeCheckout = path.join(relayWorktreeBase, "active");
  for (const directory of [repoRoot, relayWorktreeBase, activeCheckout]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  function createRun(runId, worktree) {
    const requestedRunDir = path.join(root, runId);
    fs.mkdirSync(requestedRunDir);
    const runDir = fs.realpathSync(requestedRunDir);
    const criteriaPath = path.join(runDir, "done-criteria.md");
    fs.writeFileSync(criteriaPath, "done\n");
    const record = runRecord(runId);
    record.repo.root = repoRoot;
    record.git.worktree = worktree;
    record.contract.done_criteria_path = criteriaPath;
    record.contract.done_criteria_sha256 = crypto.createHash("sha256")
      .update(fs.readFileSync(criteriaPath)).digest("hex");
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    return runDir;
  }
  for (const [runId, worktree] of [
    ["root-worktree", repoRoot],
    ["active-worktree", activeCheckout],
  ]) {
    const runDir = createRun(runId, worktree);
    const entries = fs.readdirSync(runDir).sort();
    await assert.rejects(recovery.recoverProductionRun({
      runDir,
      actor: "owner",
      reason: "must refuse before mutation",
      activeCheckout,
      relayWorktreeBase,
    }), /trusted relay worktree boundary/);
    assert.deepEqual(fs.readdirSync(runDir).sort(), entries);
  }
});

test("terminal fact before receipt resumes without active facts or repeated effects", async () => {
  const pr = {
    event_id: "pr",
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
      head_sha: HEAD, created_by_relay: true,
    },
  };
  const h = harness({
    facts: [attemptFinished(), pr],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  let receiptCrash = true;
  const originalWriteReceipt = h.writeReceipt;
  const writeReceipt = async (request) => {
    if (receiptCrash) {
      receiptCrash = false;
      throw new Error("crash_after_terminal_fact");
    }
    return originalWriteReceipt(request);
  };
  const effects = {
    converge: async (step, context) => {
      h.state.effects.push(step);
      assert.equal(step, "record_external_merge");
      return {
        converged: true,
        applied: true,
        fact: {
          type: "merge_recorded",
          at: context.intent.created_at,
          actor: context.actor,
          payload: {
            pr_number: 42,
            reviewed_source_sha: HEAD,
            pr_head_sha: HEAD,
            result_target_sha: TARGET,
            method: "external",
            operator: context.actor,
            override_reason: context.reason,
            operation_id: context.operationId,
            authorization_id: "authorization-1",
            observation_nonce: "observation-1",
            done_criteria_sha256: HASH,
          },
        },
      };
    },
  };
  await assert.rejects(recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects,
  }), /crash_after_terminal_fact/);
  assert.equal(h.state.facts.filter((fact) => fact.type === "merge_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 0);
  assert.deepEqual(h.state.effects, ["record_external_merge"]);

  const retry = await recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects,
  });
  assert.equal(retry.status, "converged");
  assert.deepEqual(h.state.effects, ["record_external_merge"]);
  assert.equal(h.state.facts.filter((fact) => fact.type === "merge_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 0);

  const factBytes = JSON.stringify(h.state.facts);
  const receiptWrites = h.state.writes;
  const completed = await recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects,
    expectedActionKey: retry.action_key,
  });
  assert.equal(completed.status, "noop");
  assert.equal(JSON.stringify(h.state.facts), factBytes);
  assert.deepEqual(h.state.effects, ["record_external_merge"]);
  assert.equal(h.state.writes, receiptWrites);
});
