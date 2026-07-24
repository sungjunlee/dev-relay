"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, leafStatus, combine, foldPlan, readyLeaves } = require("../../../skills/braid/scripts/lib/fold");

// --- leafStatus: completion is durable-evidence only, never a signal ---

test("leaf with no mapped run is not_started", () => {
  assert.equal(leafStatus(null), STATUS.NOT_STARTED);
});

test("leaf is DONE only on merged + pr_merged + issue_closed", () => {
  assert.equal(leafStatus({ state: "merged", pr_merged: true, issue_closed: true }), STATUS.DONE);
});

test("merged manifest without closed issue is NOT done (fail closed → blocked)", () => {
  assert.equal(leafStatus({ state: "merged", pr_merged: true, issue_closed: false }), STATUS.BLOCKED);
});

test("a closed-but-not-merged relay run is an abandoned attempt → blocked", () => {
  assert.equal(leafStatus({ state: "closed", pr_merged: false, issue_closed: false }), STATUS.BLOCKED);
});

test("a non-terminal manifest is running", () => {
  for (const state of ["dispatched", "review_pending", "ready_to_merge", "changes_requested"]) {
    assert.equal(leafStatus({ state, pr_merged: false, issue_closed: false }), STATUS.RUNNING);
  }
});

// --- combine: fail-closed precedence (BLOCKED dominates) ---

test("combine: all done → done", () => {
  assert.equal(combine([STATUS.DONE, STATUS.DONE]), STATUS.DONE);
});

test("combine: any blocked dominates even amid dones", () => {
  assert.equal(combine([STATUS.DONE, STATUS.BLOCKED, STATUS.DONE]), STATUS.BLOCKED);
});

test("combine: mixed progress is running", () => {
  assert.equal(combine([STATUS.DONE, STATUS.NOT_STARTED]), STATUS.RUNNING);
  assert.equal(combine([STATUS.RUNNING, STATUS.NOT_STARTED]), STATUS.RUNNING);
});

test("combine: all untouched is not_started", () => {
  assert.equal(combine([STATUS.NOT_STARTED, STATUS.NOT_STARTED]), STATUS.NOT_STARTED);
});

// --- foldPlan: a parent is DONE only when every leaf reached durable evidence ---

const doneFacts = { state: "merged", pr_merged: true, issue_closed: true };

function factsByRun(map) {
  return (node) => {
    const runId = node.leaf && node.leaf.run_id;
    return runId && map[runId] ? map[runId] : null;
  };
}

const twoLevelPlan = {
  id: "goal-1",
  root: {
    id: "root",
    children: [
      { id: "a", leaf: { issue: 1, run_id: "run-a" } },
      { id: "b", leaf: { issue: 2, run_id: "run-b" } },
    ],
  },
};

test("root is not complete until BOTH leaves are done", () => {
  const partial = foldPlan(twoLevelPlan, factsByRun({ "run-a": doneFacts }));
  assert.equal(partial.complete, false);
  assert.equal(partial.root.status, STATUS.RUNNING);

  const full = foldPlan(twoLevelPlan, factsByRun({ "run-a": doneFacts, "run-b": doneFacts }));
  assert.equal(full.complete, true);
  assert.equal(full.root.status, STATUS.DONE);
});

test("a blocked leaf blocks the whole tree (worker_done can never override durable truth)", () => {
  const folded = foldPlan(twoLevelPlan, factsByRun({ "run-a": doneFacts, "run-b": { state: "closed" } }));
  assert.equal(folded.root.status, STATUS.BLOCKED);
  assert.equal(folded.complete, false);
});

test("deep tree folds recursively", () => {
  const deep = {
    id: "goal-deep",
    root: {
      id: "root",
      children: [
        { id: "g1", children: [{ id: "l1", leaf: { run_id: "r1" } }, { id: "l2", leaf: { run_id: "r2" } }] },
        { id: "l3", leaf: { run_id: "r3" } },
      ],
    },
  };
  const facts = factsByRun({ r1: doneFacts, r2: doneFacts, r3: doneFacts });
  assert.equal(foldPlan(deep, facts).complete, true);
  const partial = factsByRun({ r1: doneFacts, r2: doneFacts });
  const f = foldPlan(deep, partial);
  assert.equal(f.root.status, STATUS.RUNNING);
  // the fully-done subtree g1 is DONE while its sibling leaf l3 is not_started
  const g1 = f.root.children.find((c) => c.id === "g1");
  assert.equal(g1.status, STATUS.DONE);
});

// --- readyLeaves: dependency ordering as pure data ---

const depPlan = {
  id: "goal-dep",
  root: {
    id: "root",
    children: [
      { id: "a", leaf: { run_id: "run-a" } },
      { id: "b", leaf: { run_id: "run-b" }, depends_on: ["a"] },
    ],
  },
};

test("only dependency-satisfied not_started leaves are ready", () => {
  const none = foldPlan(depPlan, factsByRun({}));
  assert.deepEqual(readyLeaves(depPlan, none), ["a"]); // b waits on a

  const aDone = foldPlan(depPlan, factsByRun({ "run-a": doneFacts }));
  assert.deepEqual(readyLeaves(depPlan, aDone), ["b"]); // a done → b now ready

  const bothDone = foldPlan(depPlan, factsByRun({ "run-a": doneFacts, "run-b": doneFacts }));
  assert.deepEqual(readyLeaves(depPlan, bothDone), []); // nothing left
});

test("a blocked leaf nested DEEP under internal nodes still blocks the root (fail-closed at any depth)", () => {
  const deep = {
    id: "goal-deep-blocked",
    root: {
      id: "root",
      children: [
        { id: "mid", children: [{ id: "inner", children: [{ id: "bad", leaf: { run_id: "r-bad" } }] }] },
        { id: "ok", leaf: { run_id: "r-ok" } },
      ],
    },
  };
  const folded = foldPlan(deep, factsByRun({ "r-ok": doneFacts, "r-bad": { state: "closed" } }));
  assert.equal(folded.root.status, STATUS.BLOCKED);
  const mid = folded.root.children.find((c) => c.id === "mid");
  assert.equal(mid.status, STATUS.BLOCKED); // propagated up through two internal levels
});

test("a blocked leaf does NOT gate an INDEPENDENT not_started sibling (readyLeaves is depends_on-only)", () => {
  const plan = {
    id: "goal-indep",
    root: {
      id: "root",
      children: [
        { id: "blocked", leaf: { run_id: "r-blocked" } },
        { id: "free", leaf: { run_id: "r-free" } },
      ],
    },
  };
  const folded = foldPlan(plan, factsByRun({ "r-blocked": { state: "closed" } }));
  // the free sibling has no depends_on on the blocked one, so it remains ready
  assert.deepEqual(readyLeaves(plan, folded), ["free"]);
  assert.equal(folded.root.status, STATUS.BLOCKED); // but the whole tree is still blocked
});

test("readyLeaves resolves a dependency on an INTERNAL node (whole subtree must be done)", () => {
  const plan = {
    id: "goal-dep-internal",
    root: {
      id: "root",
      children: [
        { id: "phase1", children: [{ id: "p1a", leaf: { run_id: "r-p1a" } }, { id: "p1b", leaf: { run_id: "r-p1b" } }] },
        { id: "phase2", depends_on: ["phase1"], leaf: { run_id: "r-p2" } },
      ],
    },
  };
  const partial = foldPlan(plan, factsByRun({ "r-p1a": doneFacts })); // phase1 not fully done
  assert.deepEqual(readyLeaves(plan, partial), ["p1b"]); // phase2 gated by internal phase1
  const phase1Done = foldPlan(plan, factsByRun({ "r-p1a": doneFacts, "r-p1b": doneFacts }));
  assert.deepEqual(readyLeaves(plan, phase1Done), ["phase2"]); // phase1 subtree done → phase2 ready
});

test("a leaf under an internal node with an unmet dependency is not ready", () => {
  const gated = {
    id: "goal-gated",
    root: {
      id: "root",
      children: [
        { id: "pre", leaf: { run_id: "run-pre" } },
        { id: "wave2", depends_on: ["pre"], children: [{ id: "w2a", leaf: { run_id: "run-w2a" } }] },
      ],
    },
  };
  const before = foldPlan(gated, factsByRun({}));
  assert.deepEqual(readyLeaves(gated, before), ["pre"]); // w2a gated by its parent's dep
  const after = foldPlan(gated, factsByRun({ "run-pre": doneFacts }));
  assert.deepEqual(readyLeaves(gated, after), ["w2a"]);
});
