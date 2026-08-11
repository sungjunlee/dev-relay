const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  foldRunFacts,
  inspectRun,
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
    roles: { reviewer: "claude" },
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

test("#1207 proven no-remote Git runs recover verification and advance to local review", () => {
  const local = {
    local_delivery: true,
    remote_name: null,
    remote_url: null,
    remote_head_sha: null,
    remote_relation: null,
    head_sha: HEAD,
    tree_sha: TREE,
    reviewable_work: true,
    reviewable_dirty: false,
  };
  const localGithub = {};
  const record = { ...runRecord(), repo: { remote: "local/repo" } };
  const before = foldRunFacts({
    runRecord: record,
    facts: [started(), finished()],
    gitFacts: local,
    githubFacts: localGithub,
  });
  assert.equal(before.action, "recover");
  assert.equal(before.reason, "verification_missing");
  assert.deepEqual(recoverySteps(before, { git: local, github: localGithub }), ["record_verification"]);

  const after = foldRunFacts({
    runRecord: record,
    facts: [started(), finished(), verification()],
    gitFacts: local,
    githubFacts: localGithub,
  });
  assert.equal(after.action, "review");
  assert.equal(after.reason, "review_missing");
  assert.equal(after.terminal, false);
});

test("#1208 local review uses the exact Git head and closes through one recovery step", () => {
  const local = {
    local_delivery: true, head_sha: HEAD, tree_sha: TREE,
    reviewable_work: true, reviewable_dirty: false,
  };
  const record = { ...runRecord(), repo: { remote: "local/repo" } };
  const facts = [started(), finished(), verification(), review("pass", 5)];
  const ready = foldRunFacts({ runRecord: record, facts, gitFacts: local, githubFacts: {} });
  assert.equal(ready.action, "recover");
  assert.equal(ready.reason, "reviewed_result_ready");
  assert.equal(ready.reviewed_sha, HEAD);
  assert.equal(ready.review_event_id, "e5");
  assert.equal(ready.verification_event_id, "e4");
  assert.deepEqual(recoverySteps(ready, { git: local, github: {} }, facts), ["close_reviewed_result"]);

  const laterDuplicateVerification = verification(6);
  const stableReviewSubject = foldRunFacts({
    runRecord: record,
    facts: [...facts, laterDuplicateVerification],
    gitFacts: local,
    githubFacts: {},
  });
  assert.equal(stableReviewSubject.reason, "reviewed_result_ready");
  assert.equal(stableReviewSubject.review_event_id, "e5");
  assert.equal(stableReviewSubject.verification_event_id, "e4");

  const failedAfterPass = foldRunFacts({
    runRecord: record,
    facts: [verification(4), verification(5, { status: "failed", exit_code: 1 }), review("pass", 6)],
    gitFacts: local,
    githubFacts: {},
  });
  assert.equal(failedAfterPass.action, "recover");
  assert.equal(failedAfterPass.reason, "verification_not_passing");

  const requested = foldRunFacts({
    runRecord: record,
    facts: [started(), finished(), verification(), review("changes_requested", 5)],
    gitFacts: local,
    githubFacts: {},
  });
  assert.equal(requested.action, "redispatch");
  assert.equal(requested.reason, "changes_requested");
});

test("#1207 keeps an unavailable forge distinct from a proven local delivery", () => {
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [started(), finished()],
    gitFacts: { head_sha: HEAD, reviewable_work: true },
    githubFacts: { available: false },
  });
  assert.equal(result.action, "none");
  assert.equal(result.reason, "github_unavailable");
});

test("#1207 local dirty work, dead attempts, and durable PR contradictions stay singular", () => {
  const local = {
    local_delivery: true, head_sha: HEAD, tree_sha: TREE,
    reviewable_work: true, reviewable_dirty: true,
  };
  const dirty = foldRunFacts({
    runRecord: { ...runRecord(), repo: { remote: "local/repo" } },
    facts: [started(), finished()], gitFacts: local, githubFacts: {}, hostFacts: { live: false },
  });
  assert.equal(dirty.reason, "publication_incomplete");
  assert.deepEqual(recoverySteps(dirty, { git: local, github: {}, host: { live: false } }), ["commit_work"]);

  const dead = foldRunFacts({
    runRecord: { ...runRecord(), repo: { remote: "local/repo" } },
    facts: [started()], gitFacts: { ...local, reviewable_work: false, reviewable_dirty: false },
    githubFacts: {}, hostFacts: { live: false },
  });
  assert.equal(dead.reason, "attempt_liveness_unknown");
  assert.deepEqual(recoverySteps(dead, {
    git: { ...local, reviewable_work: false, reviewable_dirty: false }, github: {}, host: { live: false },
  }), ["close_dead_attempt"]);

  const localPr = pr();
  localPr.payload.repo = "local/repo";
  const contradiction = foldRunFacts({
    runRecord: { ...runRecord(), repo: { remote: "local/repo" } }, facts: [started(), finished(), localPr],
    gitFacts: { ...local, reviewable_dirty: false }, githubFacts: {}, hostFacts: { live: false },
  });
  assert.equal(contradiction.reason, "fact_conflict");
  assert.equal(contradiction.diagnostics[0].code, "local_delivery_pull_request_conflict");
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
  assert.equal(unavailable.reviewed_sha, HEAD);

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
    assert.equal(result.reviewed_sha, HEAD, missing);
  }
  const closedPr = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: livePrFacts(42, { pr_state: "CLOSED" }),
  });
  assert.equal(closedPr.action, "none");
  assert.equal(closedPr.reason, "github_pr_closed_unmerged");
  assert.equal(closedPr.reviewed_sha, HEAD);

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

test("reviewed-result close is terminal, exposes its reviewed SHA, and rejects any durable PR history", () => {
  const close = fact("run_closed", 6, {
    reason: "reviewed_result_ready", operator: "owner", last_sha: HEAD, pr_number: null,
  });
  const localGit = { local_delivery: true, head_sha: HEAD, tree_sha: TREE };
  const terminal = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), verification(7), close, started(8, "a2")],
    gitFacts: localGit,
  });
  assert.equal(terminal.action, "none");
  assert.equal(terminal.reason, "reviewed_result_ready");
  assert.equal(terminal.terminal_kind, "closed");
  assert.equal(terminal.reviewed_sha, HEAD);
  assert.equal(terminal.verification_event_id, "e4");
  assert.ok(terminal.diagnostics.some((entry) => entry.code === "active_fact_after_terminal"));

  const liveDiverged = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), close],
    gitFacts: { head_sha: START, tree_sha: START },
  });
  assert.equal(liveDiverged.reason, "reviewed_result_ready");
  assert.ok(liveDiverged.diagnostics.some((entry) => entry.code === "terminal_live_head_diverged"));
  assert.ok(liveDiverged.diagnostics.some((entry) => entry.code === "terminal_live_tree_diverged"));

  const branchDiverged = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), close],
    gitFacts: { branch: "later-branch", base_branch: "later-base" },
  });
  assert.equal(branchDiverged.reason, "reviewed_result_ready");
  assert.equal(branchDiverged.terminal, true);
  assert.ok(branchDiverged.diagnostics.some((entry) => entry.code === "terminal_live_branch_diverged"));
  assert.ok(branchDiverged.diagnostics.some((entry) => entry.code === "terminal_live_base_diverged"));

  const retroactive = foldRunFacts({
    runRecord: runRecord(),
    facts: [close, verification(7), review("pass", 8)],
    gitFacts: localGit,
  });
  assert.equal(retroactive.reason, "fact_conflict");

  const failedBeforeReview = foldRunFacts({
    runRecord: runRecord(),
    facts: [
      verification(4),
      verification(5, { status: "failed", exit_code: 1 }),
      review("pass", 6),
      fact("run_closed", 7, {
        reason: "reviewed_result_ready", operator: "owner", last_sha: HEAD, pr_number: null,
      }),
    ],
  });
  assert.equal(failedBeforeReview.reason, "fact_conflict");

  const prConflict = foldRunFacts({ runRecord: runRecord(), facts: [verification(4), review("pass", 5), pr(), close], gitFacts: localGit });
  assert.equal(prConflict.action, "none");
  assert.equal(prConflict.reason, "fact_conflict");
  assert.equal(prConflict.terminal, true);
});

test("the first reviewed-result close remains authoritative over later close and merge facts", () => {
  const close = fact("run_closed", 6, {
    reason: "reviewed_result_ready", operator: "owner", last_sha: HEAD, pr_number: null,
  });
  const genericClose = fact("run_closed", 7, {
    reason: "operator", operator: "owner", last_sha: START, pr_number: null,
  });
  const merge = fact("merge_recorded", 8, {
    pr_number: 42, reviewed_source_sha: HEAD, pr_head_sha: HEAD,
    result_target_sha: TARGET, method: "squash", operator: "owner",
    override_reason: null, operation_id: "merge-op-1",
    authorization_id: "merge-auth-1", observation_nonce: "merge-observation-1",
    done_criteria_sha256: HASH,
  });
  for (const [label, laterFact] of [["generic close", genericClose], ["merge delivery", merge]]) {
    const folded = foldRunFacts({
      runRecord: runRecord(),
      facts: [verification(4), review("pass", 5), close, laterFact],
      gitFacts: { local_delivery: true, head_sha: HEAD, tree_sha: TREE },
    });
    assert.equal(folded.action, "none", label);
    assert.equal(folded.reason, "reviewed_result_ready", label);
    assert.equal(folded.head_sha, HEAD, label);
    assert.equal(folded.reviewed_sha, HEAD, label);
    assert.equal(folded.terminal_kind, "closed", label);
    assert.deepEqual(
      folded.diagnostics.filter((entry) => entry.code === "conflicting_terminal_facts"),
      [{ code: "conflicting_terminal_facts", event_id: laterFact.event_id, type: laterFact.type }],
      label,
    );
  }

  const laterDeliveryPair = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), close, pr(9), merge],
    gitFacts: { head_sha: HEAD, tree_sha: TREE },
    githubFacts: livePrFacts(42, { pr_state: "MERGED", merge_sha: TARGET }),
  });
  assert.equal(laterDeliveryPair.reason, "reviewed_result_ready");
  assert.equal(laterDeliveryPair.reviewed_sha, HEAD);
  assert.equal(laterDeliveryPair.pr_number, null);
  assert.ok(laterDeliveryPair.diagnostics.some((entry) => entry.code === "evidence_fact_after_terminal"));
  assert.deepEqual(
    laterDeliveryPair.diagnostics.filter((entry) => entry.code === "conflicting_terminal_facts"),
    [{ code: "conflicting_terminal_facts", event_id: merge.event_id, type: "merge_recorded" }],
  );

  const mismatchedLaterPr = {
    ...pr(9),
    payload: { ...pr(9).payload, repo: "other/repo", head_ref: "other-branch" },
  };
  const afterMismatchedPr = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), close, mismatchedLaterPr],
    githubFacts: { repo: "other/repo", head_ref: "other-branch" },
  });
  assert.equal(afterMismatchedPr.reason, "reviewed_result_ready");
  assert.ok(afterMismatchedPr.diagnostics.some((entry) => entry.code === "pull_request_identity_after_terminal"));

  const secondLaterPr = { ...pr(10), payload: { ...pr(10).payload, pr_number: 43 } };
  const afterDuplicatePr = foldRunFacts({
    runRecord: runRecord(),
    facts: [verification(4), review("pass", 5), close, pr(9), secondLaterPr],
  });
  assert.equal(afterDuplicatePr.reason, "reviewed_result_ready");
  assert.ok(afterDuplicatePr.diagnostics.some((entry) => entry.code === "pull_request_identity_after_terminal"));
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

test("#1209 freezes GitHub action, reason, and action-key contracts", async () => {
  const baseFacts = [started(), finished(), pr(), verification()];
  const open = livePrFacts(42, {
    pr_lookup_complete: true,
    lookup_complete: true,
    matching_pr_count: 1,
  });
  const publication = {
    git: {
      head_sha: HEAD, tree_sha: TREE, branch: "work", base_branch: "main",
      branch_commit_exists: true, reviewable_work: true, reviewable_dirty: false,
      remote_head_sha: START, remote_relation: "behind_local",
    },
    github: {
      available: true, lookup_complete: true, pr_lookup_complete: true,
      matching_pr_count: 0, repo: "owner/repo", pr_number: null,
      pr_head_sha: null, head_ref: "work", base_ref: "main", pr_state: null,
    },
    host: { live: false }, verification: { pending: false },
  };
  const cases = [
    ["publication recovery", [started(), finished()], publication,
      "recover", "publication_incomplete", "17783b1eb88a4ae0bedfd64c697c7280d8bebf6cf2649e244228de1c61ae722a"],
    ["review", baseFacts, { ...publication, github: open },
      "review", "review_missing", "4d8ae47b98c90b1ba1b7c0c81abea2f29f934b9d8e38f3e7e320fec0bceb1354"],
    ["stale review", [...baseFacts, review("pass", 5, START)], { ...publication, github: open },
      "review", "review_stale", "bfca830e29b3f3108cb7f61fda91d2197ab8115bab12942f45267e1e6da3018d"],
    ["ready to merge", [...baseFacts, review("pass", 5)], { ...publication, github: open },
      "merge", "ready_to_merge", "d0a837542d6801de5c0205e3c2f0a0ff9e2536f66a36309440cbeca3819816bd"],
    ["externally merged", [started(), finished(), pr()], {
      ...publication,
      github: { ...open, pr_state: "MERGED", merge_sha: TARGET },
    }, "recover", "merged_pr_unrecorded", "5b3a7c5628fafee5c631bbd798eee56c7dce2ace4e22b28db502ddeae300ac53"],
    ["GitHub unavailable", baseFacts, {
      ...publication,
      github: { ...open, available: false },
    }, "none", "github_unavailable", "3d5880c22fafe7de50341e9271c1e7e644ed288f280421220b4341f75d8e948e"],
    ["merge conflict observation", [started(), finished()], {
      ...publication,
      git: { ...publication.git, remote_relation: "diverged" },
    }, "operator_attention", "remote_branch_conflict", "3b00be359fc8b47859f8839e3ac81b8bfa42a853d1a662e637322f1e8b4f98ee"],
  ];
  const observedKeys = {};
  for (const [name, scenarioFacts, seen, kind, reason, key] of cases) {
    const snapshot = {
      run_sha256: crypto.createHash("sha256").update(JSON.stringify(runRecord())).digest("hex"),
      facts_sha256: crypto.createHash("sha256").update(JSON.stringify(scenarioFacts)).digest("hex"),
      fact_count: scenarioFacts.length,
      last_event_id: scenarioFacts.at(-1)?.event_id || null,
      tail_status: "complete",
    };
    const readSnapshot = async () => ({
      runDir: "/run", runRecord: runRecord(), facts: scenarioFacts, snapshot,
    });
    const input = { runDir: "/run", observer: async () => seen, readSnapshot };
    const first = await inspectRun(input);
    const replay = await inspectRun(input);
    assert.equal(first.recommended_action.kind, kind, name);
    assert.equal(first.recommended_action.reason, reason, name);
    observedKeys[name] = first.recommended_action.key;
    assert.equal(replay.recommended_action.key, first.recommended_action.key, `${name} replay`);
  }
  assert.deepEqual(observedKeys, Object.fromEntries(cases.map(([name, , , , , key]) => [name, key])));
});

test("#1209 exact repository, base, head, and live SHA bindings fail closed", () => {
  const ready = {
    runRecord: runRecord(),
    facts: [pr(), verification(), review("pass", 5)],
    gitFacts: { head_sha: HEAD, tree_sha: TREE, branch: "work", base_branch: "main" },
    githubFacts: livePrFacts(),
  };
  const untouched = foldRunFacts(ready);
  assert.equal(untouched.action, "merge");
  assert.equal(untouched.reason, "ready_to_merge");
  for (const [name, override, expectedReason, expectedDiagnostic] of [
    ["repository", { repo: "other/repo" }, "fact_conflict", "external_identity_mismatch"],
    ["base", { base_ref: "release" }, "fact_conflict", "external_identity_mismatch"],
    ["head branch", { head_ref: "other-work" }, "fact_conflict", "external_identity_mismatch"],
    ["live SHA", { pr_head_sha: START }, "verification_observation_incomplete", "verification_tree_observation_incomplete"],
  ]) {
    const result = foldRunFacts({
      ...ready,
      githubFacts: { ...ready.githubFacts, ...override },
    });
    assert.notEqual(result.action, "merge", name);
    assert.equal(result.reason, expectedReason, name);
    assert.equal(result.diagnostics.at(-1).code, expectedDiagnostic, name);
  }
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
