"use strict";

// #1135: this file deliberately exercises the injected recovery seam rather
// than the production GitHub adapter.  It gives every recovery transition a
// deterministic external world, so a failure cannot be hidden by a real
// remote changing underneath the test.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  inspectRun,
  recoverRun,
} = require("../../../skills/relay-dispatch/scripts/recover");

const RUN_ID = "issue-1135-scenario-matrix";
const START = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const COMMITTED = "4".repeat(40);
const COMMITTED_TREE = "5".repeat(40);
const MERGE = "6".repeat(40);
const CRITERIA = "7".repeat(64);
const RESULT = "8".repeat(64);
const REQUEST = "9".repeat(64);

function clone(value) {
  return structuredClone(value);
}

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record() {
  return {
    version: 3,
    run_id: RUN_ID,
    repo: { root: "/repo", remote: "owner/repo" },
    git: {
      branch: "issue-1135-scenario-matrix",
      base_branch: "main",
      worktree: "/repo/worktree",
      start_sha: START,
    },
    contract: { done_criteria_path: "/run/done.md", done_criteria_sha256: CRITERIA },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

function fact(type, payload, extra = {}) {
  return {
    event_id: extra.event_id || `${type}-${extra.n || 1}`,
    run_id: RUN_ID,
    ...(type.startsWith("attempt_") ? { attempt_id: extra.attempt_id || "attempt-1" } : {}),
    type,
    at: extra.at || "2026-08-01T00:01:00.000Z",
    actor: extra.actor || "codex",
    payload,
  };
}

function attemptFacts({ head = HEAD, tree = TREE } = {}) {
  return [
    fact("attempt_started", {
      executor: "codex", model: null, start_sha: START,
      host_kind: "local", host_handle: "attempt-1",
      stdout_path: "/run/stdout", stderr_path: "/run/stderr", result_path: "/run/result",
      timeout_ms: 60_000,
    }, { n: 1 }),
    fact("attempt_finished", {
      status: "completed", start_sha: START, final_sha: head, tree_sha: tree,
      result_path: "/run/result", exit_code: 0, verification_status: "passed",
    }, { n: 1, at: "2026-08-01T00:02:00.000Z" }),
  ];
}

function prFact({ head = HEAD, number = 42 } = {}) {
  return fact("pull_request_recorded", {
    pr_number: number, repo: "owner/repo", head_ref: "issue-1135-scenario-matrix",
    base_ref: "main", head_sha: head, created_by_relay: true,
  }, { n: number, at: "2026-08-01T00:03:00.000Z" });
}

function verificationFact({
  head = HEAD,
  tree = TREE,
  status = "passed",
  completed = status === "incomplete" ? 1 : 2,
  exitCode = status === "incomplete" ? null : 0,
  n = 1,
} = {}) {
  return fact("verification_recorded", {
    head_sha: head,
    tree_sha: tree,
    done_criteria_sha256: CRITERIA,
    command: "node --test && node --check index.js",
    verification_request_sha256: REQUEST,
    declared_command_count: 2,
    completed_command_count: completed,
    result_path: "/run/verification.log",
    result_sha256: RESULT,
    exit_code: exitCode,
    status,
    operator: "owner",
  }, { n, actor: "owner", at: `2026-08-01T00:0${3 + n}:00.000Z` });
}

function reviewFact({ reviewed = HEAD } = {}) {
  return fact("review_recorded", {
    round: 1, verdict: "pass", reviewed_sha: reviewed,
    done_criteria_sha256: CRITERIA, reviewer: "claude",
    review_artifact: "/run/review.json", override: null,
  }, { n: 1, actor: "claude", at: "2026-08-01T00:06:00.000Z" });
}

function defaultObservations({
  head = HEAD,
  tree = TREE,
  dirty = false,
  remoteHead = null,
  relation = "behind_local",
  pr = null,
  verificationPending = false,
} = {}) {
  return {
    git: {
      head_sha: head,
      tree_sha: tree,
      branch: "issue-1135-scenario-matrix",
      base_branch: "main",
      branch_commit_exists: head !== START,
      reviewable_work: head !== START || dirty,
      reviewable_dirty: dirty,
      tree_differs_from_start: head !== START || dirty,
      remote_head_sha: remoteHead,
      remote_relation: relation,
    },
    github: {
      available: true,
      lookup_complete: true,
      pr_lookup_complete: true,
      matching_pr_count: pr ? 1 : 0,
      repo: "owner/repo",
      pr_number: pr?.number || null,
      pr_state: pr?.state || null,
      head_ref: "issue-1135-scenario-matrix",
      base_ref: "main",
      pr_head_sha: pr?.head || null,
      merge_sha: pr?.merge || null,
    },
    host: { live: false },
    verification: { pending: verificationPending },
  };
}

function scenarioDefinitions() {
  const openPr = { number: 42, state: "OPEN", head: HEAD };
  return [
    {
      name: "clean",
      facts: [],
      observations: defaultObservations({
        head: START, tree: TREE, remoteHead: START, relation: "equal",
      }),
      action: "redispatch",
      reason: "no_attempt",
      steps: [],
    },
    {
      name: "dirty",
      facts: attemptFacts(),
      observations: defaultObservations({ dirty: true }),
      action: "recover",
      reason: "publication_incomplete",
      steps: ["commit_work", "push_branch", "record_or_create_pr"],
    },
    {
      name: "committed",
      facts: attemptFacts(),
      observations: defaultObservations({ remoteHead: START, relation: "behind_local" }),
      action: "recover",
      reason: "publication_incomplete",
      steps: ["push_branch", "record_or_create_pr"],
    },
    {
      name: "pushed",
      facts: attemptFacts(),
      observations: defaultObservations({ remoteHead: HEAD, relation: "equal" }),
      action: "recover",
      reason: "publication_incomplete",
      steps: ["record_or_create_pr"],
    },
    {
      name: "PR-open",
      facts: [...attemptFacts(), prFact(), verificationFact()],
      observations: defaultObservations({ remoteHead: HEAD, relation: "equal", pr: openPr }),
      action: "review",
      reason: "review_missing",
      steps: [],
    },
    {
      name: "PR-merged",
      facts: [...attemptFacts(), prFact()],
      observations: defaultObservations({
        remoteHead: HEAD, relation: "equal",
        pr: { number: 42, state: "MERGED", head: HEAD, merge: MERGE },
      }),
      action: "recover",
      reason: "merged_pr_unrecorded",
      steps: ["record_external_merge"],
    },
    {
      name: "stale-review",
      facts: [...attemptFacts(), prFact(), verificationFact(), reviewFact({ reviewed: START })],
      observations: defaultObservations({ remoteHead: HEAD, relation: "equal", pr: openPr }),
      action: "review",
      reason: "review_stale",
      steps: [],
    },
    {
      name: "partial-verification",
      facts: [...attemptFacts(), prFact(), verificationFact({ status: "incomplete" })],
      observations: defaultObservations({
        remoteHead: HEAD, relation: "equal", pr: openPr, verificationPending: true,
      }),
      action: "recover",
      reason: "verification_not_passing",
      steps: ["record_verification"],
    },
  ];
}

function harness(definition) {
  const state = {
    record: record(),
    facts: clone(definition.facts),
    observations: clone(definition.observations),
    intent: null,
    receipts: new Map(),
    effect_calls: [],
    effect_applications: [],
    pr_creations: 0,
    fact_writes: [],
    verification_completed: false,
    external_merge_recorded: false,
  };
  const readSnapshot = async () => ({
    runDir: "/run",
    runRecord: clone(state.record),
    facts: clone(state.facts),
    snapshot: {
      run_sha256: stableDigest(state.record),
      facts_sha256: stableDigest(state.facts),
      fact_count: state.facts.length,
      last_event_id: state.facts.at(-1)?.event_id || null,
      tail_status: "complete",
    },
  });
  const observer = async () => clone(state.observations);
  const appendFact = async (entry) => {
    state.fact_writes.push(entry.type);
    if (!state.facts.some((current) => current.event_id === entry.event_id)) {
      state.facts.push(clone(entry));
    }
  };
  const effects = {
    converge: async (step, context) => {
      state.effect_calls.push(step);
      const git = state.observations.git;
      const github = state.observations.github;
      if (step === "commit_work") {
        if (!git.reviewable_dirty) return { converged: true, applied: false };
        git.reviewable_dirty = false;
        git.head_sha = COMMITTED;
        git.tree_sha = COMMITTED_TREE;
        git.branch_commit_exists = true;
        git.reviewable_work = true;
        git.tree_differs_from_start = true;
        git.remote_relation = "behind_local";
        state.effect_applications.push(step);
        return { converged: true, applied: true };
      }
      if (step === "push_branch") {
        if (git.remote_head_sha === git.head_sha) return { converged: true, applied: false };
        assert.equal(git.remote_relation, "behind_local", "push must only happen from behind_local");
        git.remote_head_sha = git.head_sha;
        git.remote_relation = "equal";
        state.effect_applications.push(step);
        return { converged: true, applied: true };
      }
      if (step === "record_or_create_pr") {
        if (github.pr_number) {
          return {
            converged: true,
            applied: false,
            fact: prFact({ head: git.head_sha, number: github.pr_number }),
          };
        }
        state.pr_creations += 1;
        github.matching_pr_count = 1;
        github.pr_number = 42;
        github.pr_state = "OPEN";
        github.pr_head_sha = git.head_sha;
        state.effect_applications.push(step);
        return { converged: true, applied: true, fact: prFact({ head: git.head_sha }) };
      }
      if (step === "record_verification") {
        const existingPassing = state.verification_completed || state.facts.some((entry) => (
          entry.type === "verification_recorded"
          && entry.payload.status === "passed"
          && entry.payload.head_sha === git.head_sha
          && entry.payload.tree_sha === git.tree_sha
        ));
        state.observations.verification.pending = false;
        if (existingPassing) {
          return {
            converged: true,
            applied: false,
            fact: verificationFact({ head: git.head_sha, tree: git.tree_sha, n: 2 }),
          };
        }
        state.verification_completed = true;
        state.effect_applications.push(step);
        return {
          converged: true,
          applied: true,
          fact: verificationFact({ head: git.head_sha, tree: git.tree_sha, n: 2 }),
        };
      }
      if (step === "record_external_merge") {
        const existing = state.external_merge_recorded || state.facts.some((entry) => entry.type === "merge_recorded");
        const mergeFact = () => fact("merge_recorded", {
          pr_number: github.pr_number,
          reviewed_source_sha: github.pr_head_sha,
          pr_head_sha: github.pr_head_sha,
          result_target_sha: github.merge_sha,
          method: "external",
          operator: "owner",
          override_reason: "scenario recovery",
          operation_id: context.operationId,
          authorization_id: "authorization-1",
          observation_nonce: "observation-1",
          done_criteria_sha256: CRITERIA,
        });
        if (existing) return { converged: true, applied: false, fact: mergeFact() };
        state.external_merge_recorded = true;
        state.effect_applications.push(step);
        return {
          converged: true,
          applied: true,
          fact: mergeFact(),
        };
      }
      throw new Error(`unexpected recovery step ${step}`);
    },
  };
  return {
    state,
    readSnapshot,
    observer,
    appendFact,
    effects,
    withLock: async (callback) => callback(),
    readIntent: async () => (
      state.intent && !state.receipts.has(state.intent.action_key) ? clone(state.intent) : null
    ),
    writeIntent: async ({ intent }) => {
      if (state.intent && JSON.stringify(state.intent) !== JSON.stringify(intent)) {
        throw new Error("intent conflict");
      }
      state.intent = clone(intent);
    },
    readReceipt: async ({ actionKey }) => state.receipts.get(actionKey) || null,
    writeReceipt: async ({ actionKey, receipt }) => {
      state.receipts.set(actionKey, clone(receipt));
    },
  };
}

async function recover(h, options = {}) {
  return recoverRun({
    ...h,
    actor: "owner",
    reason: "scenario recovery",
    ...options,
  });
}

function countByEventId(facts) {
  const counts = new Map();
  for (const entry of facts) counts.set(entry.event_id, (counts.get(entry.event_id) || 0) + 1);
  return counts;
}

test("#1135 inspect scenario matrix derives one exact next action for all lifecycle states", async (t) => {
  for (const definition of scenarioDefinitions()) {
    await t.test(definition.name, async () => {
      const h = harness(definition);
      const before = clone(h.state);
      const first = await inspectRun(h);
      const second = await inspectRun(h);
      assert.equal(first.recommended_action.kind, definition.action);
      assert.equal(first.recommended_action.reason, definition.reason);
      assert.deepEqual(first.recommended_action.steps, definition.steps);
      assert.equal(first.recommended_action.key, second.recommended_action.key);
      assert.deepEqual(h.state, before, "inspect must not mutate durable or external harness state");
    });
  }
});

test("#1135 recovery crash matrix is idempotent before and after every emitted durable fact", async (t) => {
  const recoverable = scenarioDefinitions().filter((definition) => definition.action === "recover");
  for (const definition of recoverable) {
    const probe = harness(definition);
    const inspected = await inspectRun(probe);
    // Each recoverable scenario emits a fact per factual step and, unless the
    // factual step itself is terminal, one recovery_applied receipt fact.
    const emittedTypes = [...inspected.recommended_action.steps].flatMap((step) => (
      new Set(["record_or_create_pr", "record_verification", "record_external_merge"]).has(step)
        ? [step === "record_or_create_pr" ? "pull_request_recorded"
          : step === "record_verification" ? "verification_recorded" : "merge_recorded"]
        : []
    ));
    if (!emittedTypes.includes("merge_recorded")) emittedTypes.push("recovery_applied");

    for (const targetType of emittedTypes) {
      for (const phase of ["before", "after"]) {
        await t.test(`${definition.name}: crash ${phase} ${targetType}`, async () => {
          const h = harness(definition);
          let faulted = false;
          const appendFact = async (entry) => {
            if (!faulted && entry.type === targetType && phase === "before") {
              faulted = true;
              throw new Error(`injected crash before ${targetType}`);
            }
            await h.appendFact(entry);
            if (!faulted && entry.type === targetType && phase === "after") {
              faulted = true;
              throw new Error(`injected crash after ${targetType}`);
            }
          };
          await assert.rejects(recover(h, { appendFact }), new RegExp(`injected crash ${phase} ${targetType}`));

          const verificationChangedAction = definition.name === "partial-verification"
            && h.state.facts.some((entry) => entry.type === "verification_recorded"
              && entry.payload.status === "passed");
          const converged = await recover(h, { appendFact });
          if (verificationChangedAction) {
            assert.equal(converged.status, "refused");
            assert.equal(converged.blockers[0].code, "active_intent_observation_changed");
            return;
          }
          assert.equal(converged.status, "converged");
          assert.equal(h.state.pr_creations, definition.steps.includes("record_or_create_pr") ? 1 : 0);
          for (const count of countByEventId(h.state.facts).values()) assert.equal(count, 1, "event IDs are append-idempotent");
          assert.ok(h.state.effect_applications.length <= definition.steps.length, "effects must converge once");

          const factsAfterConvergence = JSON.stringify(h.state.facts);
          const applicationsAfterConvergence = [...h.state.effect_applications];
          const sameKey = await recover(h, { appendFact, expectedActionKey: converged.action_key });
          assert.equal(sameKey.status, "noop", "completed exact action key must be a no-op");
          assert.equal(JSON.stringify(h.state.facts), factsAfterConvergence);
          assert.deepEqual(h.state.effect_applications, applicationsAfterConvergence);

          if (definition.name === "PR-merged") {
            const terminal = await inspectRun(h);
            assert.equal(terminal.derived.terminal, true);
            assert.equal(terminal.recommended_action.kind, "none");
            const irreversible = await recover(h, { appendFact });
            assert.equal(irreversible.status, "noop", "terminal merge must never be reopened");
            assert.equal(JSON.stringify(h.state.facts), factsAfterConvergence);
          }
        });
      }
    }
  }
});
