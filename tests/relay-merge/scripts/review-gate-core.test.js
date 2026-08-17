"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { requireMergeAction } = require("../../../skills/relay-merge/scripts/review-gate");

const head = "a".repeat(40);
const tree = "b".repeat(40);
const base = "e".repeat(40);
const criteria = "c".repeat(64);
const record = {
  repo: { remote: "owner/repo" },
  git: { branch: "issue-42", base_branch: "main" },
  contract: { done_criteria_sha256: criteria },
  roles: { reviewer: "codex" },
};

function inspection() {
  return {
    operation: "inspect",
    blockers: [],
    derived: { action: "merge", head_sha: head, reviewed_sha: head, pr_number: 42 },
    recommended_action: { kind: "merge", key: "d".repeat(64) },
    observations: {
      github: {
        available: true,
        lookup_complete: true,
        pr_state: "OPEN",
        pr_number: 42,
        repo: "owner/repo",
        head_ref: "issue-42",
        base_ref: "main",
        pr_head_sha: head,
        pr_base_sha: base,
      },
      git: {
        head_sha: head,
        remote_head_sha: head,
        tree_sha: tree,
        reviewable_dirty: false,
      },
    },
    facts: [
      { type: "pull_request_recorded", payload: { pr_number: 42, repo: "owner/repo", head_ref: "issue-42", base_ref: "main", head_sha: head } },
      { type: "verification_recorded", payload: { status: "passed", exit_code: 0, head_sha: head, tree_sha: tree, done_criteria_sha256: criteria } },
      { type: "review_recorded", payload: { verdict: "lgtm", reviewed_sha: head, base_sha: base, done_criteria_sha256: criteria, reviewer: "codex" } },
    ],
  };
}

test("merge gate binds live PR, remote/worktree head, verification, review, and Done Criteria", () => {
  const binding = requireMergeAction(inspection(), record);
  assert.equal(binding.head, head);
  assert.equal(binding.prNumber, 42);
  assert.equal(binding.reviewedBase, base);
  assert.equal(binding.liveBase, base);
  assert.equal(binding.liveBaseRef, "main");
});

test("merge gate adopts a live PR whose base differs from the frozen run.json base", () => {
  const value = inspection();
  const adopted = { ...record, git: { ...record.git, base_branch: "deleted-docs" } };
  value.observations.github.base_ref = "main";
  value.facts[0].payload.base_ref = "main";
  const binding = requireMergeAction(value, adopted);
  assert.equal(binding.prNumber, 42);
  assert.equal(binding.liveBaseRef, "main");
});

test("merge gate refuses when the durable PR base and live PR base disagree", () => {
  const value = inspection();
  value.observations.github.base_ref = "release";
  value.facts[0].payload.base_ref = "main";
  assert.throws(() => requireMergeAction(value, record), /MERGE_PR_FACT_MISMATCH|does not match the exact live PR/);
});

test("merge gate rejects mutable observation, review, and verification drift", () => {
  const mutations = [
    (value) => { value.observations.github.pr_head_sha = "e".repeat(40); },
    (value) => { value.observations.github.pr_state = "CLOSED"; },
    (value) => { value.observations.git.remote_head_sha = "e".repeat(40); },
    (value) => { value.observations.git.reviewable_dirty = true; },
    (value) => { value.facts[1].payload.tree_sha = "e".repeat(40); },
    (value) => { value.facts[2].payload.reviewed_sha = "e".repeat(40); },
    (value) => { value.facts[2].payload.reviewer = "other"; },
  ];
  for (const mutate of mutations) {
    const value = inspection();
    mutate(value);
    assert.throws(() => requireMergeAction(value, record));
  }
});

test("merge gate rejects blockers and every derived action other than merge", () => {
  const blocked = inspection();
  blocked.blockers.push({ code: "github_unavailable" });
  assert.throws(() => requireMergeAction(blocked, record), /github_unavailable/);
  const review = inspection();
  review.derived.action = "review";
  review.recommended_action.kind = "review";
  assert.throws(() => requireMergeAction(review, record), /not 'merge'/);
});
