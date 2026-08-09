const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  foldRunFacts,
  recoverySteps,
} = require("../../../skills/relay-dispatch/scripts/inspect");

const START = "a".repeat(40);
const HEAD = "b".repeat(40);
const TARGET = "c".repeat(40);
const HASH = "d".repeat(64);
const TREE = "e".repeat(40);

function runRecord() {
  return {
    run_id: "r1",
    repo: { remote: "owner/repo" },
    git: { branch: "work", base_branch: "main" },
    contract: { done_criteria_sha256: HASH },
  };
}

function fact(type, index, payload, attemptId = null) {
  return {
    event_id: `e${index}`,
    run_id: "r1",
    ...(attemptId ? { attempt_id: attemptId } : {}),
    type,
    at: `2026-07-31T00:00:${String(index).padStart(2, "0")}Z`,
    actor: "owner",
    payload,
  };
}

function started(index = 1, attemptId = "a1") {
  return fact("attempt_started", index, {
    executor: "codex", model: null, start_sha: START, host_kind: "local",
    host_handle: "host-1", stdout_path: "/r/out", stderr_path: "/r/err",
    result_path: "/r/result", timeout_ms: 1000,
  }, attemptId);
}

function finished(index = 2, attemptId = "a1", overrides = {}) {
  return fact("attempt_finished", index, {
    status: "completed", start_sha: START, final_sha: HEAD, tree_sha: HEAD,
    result_path: "/r/result", exit_code: 0, verification_status: "passed",
    ...overrides,
  }, attemptId);
}

function interrupted(index = 2, attemptId = "a1") {
  return fact("attempt_interrupted", index, {
    last_known_sha: HEAD, reason: "cancelled", host_liveness: "dead", reviewable_work: true,
  }, attemptId);
}

function pr(index = 3) {
  return fact("pull_request_recorded", index, {
    pr_number: 42, repo: "owner/repo", head_ref: "work", base_ref: "main",
    head_sha: HEAD, created_by_relay: true,
  });
}

function verification(index = 4, overrides = {}) {
  return fact("verification_recorded", index, {
    head_sha: HEAD,
    tree_sha: TREE,
    done_criteria_sha256: HASH,
    command: "node --test",
    verification_request_sha256: "1".repeat(64),
    declared_command_count: 1,
    completed_command_count: 1,
    result_path: "/r/verification.log",
    result_sha256: "f".repeat(64),
    exit_code: 0,
    status: "passed",
    operator: "owner",
    ...overrides,
  });
}

function review(verdict, index = 4, reviewedSha = HEAD, hash = HASH) {
  return fact("review_recorded", index, {
    round: 1, verdict, reviewed_sha: reviewedSha, done_criteria_sha256: hash,
    reviewer: "claude", review_artifact: "/r/review.json", override: null,
  });
}

function livePrFacts(prNumber = 42, overrides = {}) {
  return {
    available: true,
    pr_number: prNumber,
    repo: "owner/repo",
    pr_head_sha: HEAD,
    head_ref: "work",
    base_ref: "main",
    pr_state: "OPEN",
    ...overrides,
  };
}

test("fold implements active, publication, review, stale, changes, and ready precedence", () => {
  assert.deepEqual(
    foldRunFacts({ runRecord: runRecord(), facts: [started()], hostFacts: { live: true } }).action,
    "wait",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started()],
      hostFacts: { live: false },
      githubFacts: { available: true },
    }).reason,
    "attempt_liveness_unknown",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started(), finished()],
      gitFacts: { head_sha: HEAD, reviewable_work: true },
      githubFacts: { available: true, pr_lookup_complete: true },
    }).reason,
    "publication_incomplete",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started(), finished(), pr()],
      githubFacts: livePrFacts(),
    }).reason,
    "verification_missing",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), verification(), review("pass", 5, START)],
      gitFacts: { head_sha: HEAD, tree_sha: TREE },
      githubFacts: livePrFacts(),
    }).reason,
    "review_stale",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), review("changes_requested")],
      gitFacts: { head_sha: HEAD, tree_sha: TREE },
      githubFacts: livePrFacts(),
    }).action,
    "redispatch",
  );
  const ready = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(), review("pass", 5)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(ready.action, "merge");
  assert.equal(ready.reason, "ready_to_merge");
});

test("#1190 review corrections reach canonical publication recovery only after completed work", () => {
  const beforeReview = [started(), finished(), pr(3), verification(4), review("changes_requested", 5)];
  const observation = {
    gitFacts: { head_sha: HEAD, tree_sha: TREE, reviewable_work: true, reviewable_dirty: true },
    githubFacts: livePrFacts(42, { pr_lookup_complete: true }),
  };
  const recovered = foldRunFacts({
    runRecord: runRecord(),
    facts: [...beforeReview, started(6, "a2"), finished(7, "a2")],
    ...observation,
  });
  assert.equal(recovered.action, "recover");
  assert.equal(recovered.reason, "publication_incomplete");
  assert.deepEqual(recoverySteps(recovered, {
    git: { head_sha: HEAD, reviewable_dirty: true, remote_head_sha: HEAD },
    github: { pr_state: "OPEN", matching_pr_count: 1, pr_head_sha: HEAD },
  }, [...beforeReview, started(6, "a2"), finished(7, "a2")]), [
    "commit_work", "push_branch", "record_or_create_pr",
  ]);

  const boundaries = [
    { name: "no post-review attempt", facts: [pr(3), verification(4), review("changes_requested", 5)] },
    { name: "attempt before review", facts: beforeReview },
    {
      name: "failed post-review attempt",
      facts: [...beforeReview, started(6, "a2"), finished(7, "a2", { status: "failed", exit_code: 1 })],
    },
    {
      name: "interrupted post-review attempt",
      facts: [...beforeReview, started(6, "a2"), interrupted(7, "a2")],
    },
    {
      name: "completed post-review attempt without reviewable work",
      facts: [...beforeReview, started(6, "a2"), finished(7, "a2")],
      gitFacts: { head_sha: HEAD, tree_sha: TREE },
    },
  ];
  for (const boundary of boundaries) {
    const result = foldRunFacts({
      runRecord: runRecord(),
      ...observation,
      ...boundary,
    });
    assert.equal(result.action, "redispatch", boundary.name);
    assert.equal(result.reason, "changes_requested", boundary.name);
  }
});
test("exact criteria binding, external revalidation, and identity conflicts fail closed", () => {
  const staleCriteria = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(), review("pass", 5, HEAD, "f".repeat(64))],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(staleCriteria.action, "review");
  assert.equal(staleCriteria.reason, "review_stale");

  const unavailable = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(), review("pass", 5)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: { available: false, pr_head_sha: HEAD },
  });
  assert.equal(unavailable.action, "none");
  assert.equal(unavailable.reason, "github_unavailable");

  const conflict = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr()],
    githubFacts: livePrFacts(42, { repo: "other/repo" }),
  });
  assert.equal(conflict.action, "none");
  assert.equal(conflict.reason, "fact_conflict");

  for (const missing of ["pr_number", "repo", "pr_head_sha", "head_ref", "base_ref", "pr_state"]) {
    const incomplete = livePrFacts();
    delete incomplete[missing];
    const result = foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), verification(), review("pass", 5)],
      gitFacts: { head_sha: HEAD, tree_sha: TREE },
      githubFacts: incomplete,
    });
    assert.equal(result.action, "none", missing);
    assert.equal(result.reason, "github_unavailable", missing);
  }
  const closedPr = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: livePrFacts(42, { pr_state: "CLOSED" }),
  });
  assert.equal(closedPr.action, "none");
  assert.equal(closedPr.reason, "github_pr_closed_unmerged");

  const branchConflict = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr()],
    githubFacts: livePrFacts(42, { head_ref: "other-work" }),
  });
  assert.equal(branchConflict.reason, "fact_conflict");

  const staleRequested = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(), review("changes_requested", 5, HEAD, "f".repeat(64))],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(staleRequested.action, "review");
  assert.equal(staleRequested.reason, "review_stale");

  const incompletePublicationLookup = foldRunFacts({
    runRecord: runRecord(),
    facts: [started(), finished()],
    gitFacts: { head_sha: HEAD, reviewable_work: true },
    githubFacts: { available: true },
  });
  assert.equal(incompletePublicationLookup.action, "none");
  assert.equal(incompletePublicationLookup.reason, "github_unavailable");
});

test("terminal facts are irreversible and conflicting terminal history fails closed", () => {
  const closed = fact("run_closed", 2, {
    reason: "operator", operator: "owner", last_sha: HEAD, pr_number: null,
  });
  const folded = foldRunFacts({
    runRecord: runRecord(),
    facts: [started(), closed, started(3, "a2")],
  });
  assert.equal(folded.phase, "terminal");
  assert.equal(folded.action, "none");
  assert.equal(folded.reason, "closed");
  assert.equal(folded.activeAttempt, null);
  assert.ok(folded.diagnostics.some((entry) => entry.code === "active_fact_after_terminal"));

  const merged = fact("merge_recorded", 4, {
    pr_number: 42, reviewed_source_sha: HEAD, pr_head_sha: HEAD,
    result_target_sha: TARGET, method: "squash", operator: "owner",
    override_reason: null, operation_id: "merge-op-1",
    authorization_id: "merge-auth-1", observation_nonce: "merge-observation-1",
    done_criteria_sha256: HASH,
  });
  const conflict = foldRunFacts({ runRecord: runRecord(), facts: [closed, merged] });
  assert.equal(conflict.reason, "fact_conflict");
  assert.equal(conflict.action, "none");

  const repeatedClose = {
    ...closed,
    event_id: "e5",
    at: "2026-07-31T00:00:05Z",
  };
  assert.equal(
    foldRunFacts({ runRecord: runRecord(), facts: [closed, repeatedClose] }).reason,
    "fact_conflict",
  );
  const repeatedMerge = {
    ...merged,
    event_id: "e6",
    at: "2026-07-31T00:00:06Z",
  };
  assert.equal(
    foldRunFacts({ runRecord: runRecord(), facts: [merged, repeatedMerge] }).reason,
    "fact_conflict",
  );
  const contradictoryMerge = {
    ...merged,
    payload: { ...merged.payload, pr_head_sha: START },
  };
  const contradictoryTerminal = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), contradictoryMerge],
    githubFacts: livePrFacts(42, { pr_state: "MERGED", merge_sha: TARGET }),
  });
  assert.equal(contradictoryTerminal.reason, "fact_conflict");
  assert.equal(contradictoryTerminal.terminal, true);
});

test("fold replay is deterministic and append position, not timestamps, controls precedence", () => {
  const facts = [pr(), verification(), review("changes_requested", 5)];
  const input = {
    runRecord: runRecord(),
    facts,
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  };
  assert.deepEqual(foldRunFacts(input), foldRunFacts(JSON.parse(JSON.stringify(input))));
  const passWithOlderTimestamp = {
    ...review("pass", 6),
    at: "2020-01-01T00:00:00Z",
  };
  assert.equal(
    foldRunFacts({ ...input, facts: [...facts, passWithOlderTimestamp] }).action,
    "merge",
  );
});

test("a live PR head advance invalidates the local tree observation", () => {
  const advanced = "f".repeat(40);
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(4, { tree_sha: TREE }), review("pass", 5)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(42, { pr_head_sha: advanced }),
  });
  assert.equal(result.reason, "verification_observation_incomplete");
  assert.equal(result.action, "recover");
});

test("#1113 stale verification proof cannot be rebranded into a merge approval", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [
      pr(),
      verification(4, { head_sha: START, tree_sha: START }),
      review("pass", 5),
    ],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_stale");
  assert.equal(result.diagnostics.at(-1).code, "verification_proof_stale");
});

test("#1114 verification before a salvage commit cannot approve the post-commit head", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [
      pr(),
      verification(4, { head_sha: START, tree_sha: TREE }),
      review("pass", 5),
    ],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_stale");
  assert.notEqual(result.action, "merge");
});

test("#1118 executor success cannot turn incomplete declared verification into approval", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [
      // This is the executor process outcome: success alone is not the
      // declared two-command verification result.
      finished(),
      pr(),
      verification(4, {
        declared_command_count: 2,
        completed_command_count: 1,
        status: "incomplete",
        exit_code: null,
      }),
      review("pass", 5),
    ],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_not_passing");
  assert.equal(result.diagnostics.at(-1).code, "verification_proof_not_passing");
});

test("a declared attempt without a content-addressed proof fails closed", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), finished(), review("pass", 4)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_missing");
  assert.equal(result.diagnostics.at(-1).code, "verification_proof_missing");
});

test("a PR pass review without any verification fact fails closed by default", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass", 4)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_missing");
  assert.equal(result.diagnostics.at(-1).code, "verification_proof_missing");
});

test("a Git tree is trusted only when observed at the live PR head", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), verification(), review("pass", 5)],
    gitFacts: { head_sha: START, tree_sha: TREE },
    githubFacts: livePrFacts(),
  });
  assert.equal(result.action, "recover");
  assert.equal(result.reason, "verification_observation_incomplete");
  assert.equal(result.diagnostics.at(-1).code, "verification_tree_observation_incomplete");
  assert.notEqual(result.action, "merge");
});

test("property replay preserves ordering, rejects duplicate delivery, and never leaves terminal", () => {
  const closed = fact("run_closed", 8, {
    reason: "operator",
    operator: "owner",
    last_sha: HEAD,
    pr_number: 42,
  });
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const firstVerdict = iteration % 2 === 0 ? "pass" : "changes_requested";
    const secondVerdict = firstVerdict === "pass" ? "changes_requested" : "pass";
    const sequence = [
      pr(),
      verification(),
      { ...review(firstVerdict, 5), event_id: `property-first-${iteration}` },
      { ...review(secondVerdict, 6), event_id: `property-second-${iteration}` },
    ];
    const input = {
      runRecord: runRecord(),
      facts: sequence,
      gitFacts: { head_sha: HEAD, tree_sha: TREE },
      githubFacts: livePrFacts(),
    };
    const folded = foldRunFacts(input);
    assert.deepEqual(folded, foldRunFacts(JSON.parse(JSON.stringify(input))));
    assert.equal(
      folded.action,
      secondVerdict === "pass" ? "merge" : "redispatch",
      `ordering iteration ${iteration}`,
    );
    const duplicate = foldRunFacts({
      ...input,
      facts: [...sequence, { ...sequence[0] }],
    });
    assert.equal(duplicate.reason, "fact_conflict");
    const terminal = foldRunFacts({
      ...input,
      facts: [...sequence, { ...closed, event_id: `closed-${iteration}` }, started(7, `late-${iteration}`)],
    });
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.action, "none");
  }
});
