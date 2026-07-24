"use strict";

// The heart of braid: a PURE recursive evidence fold over a decomposition tree.
//
// braid's thesis is "decompose deep, execute flat": the tree is cheap structure with no
// per-node lifecycle; ordinary `relay` runs only at the leaves; a parent is DONE only when
// every child is DONE-with-durable-evidence. This module is that fold. It performs NO I/O —
// the caller injects `leafFacts(node)` returning the durable truth already read from relay
// manifests (or null when a leaf has no mapped run yet). Completion is NEVER inferred from a
// signal (no worker_done, no task status); a leaf is DONE only on merged PR + closed issue.

const STATUS = Object.freeze({
  NOT_STARTED: "not_started",
  RUNNING: "running",
  DONE: "done",
  BLOCKED: "blocked",
});

// A leaf's durable status, derived ONLY from relay's durable truth. `facts` is either null
// (no relay run mapped → not started) or { state, pr_merged, issue_closed } read from the
// leaf's relay manifest. Fail closed: a terminal manifest that did NOT reach merged+closed is
// an abandoned/superseded attempt that needs a human, so it is BLOCKED, never silently done.
function leafStatus(facts) {
  if (!facts) return STATUS.NOT_STARTED;
  if (facts.state === "merged" && facts.pr_merged === true && facts.issue_closed === true) {
    return STATUS.DONE;
  }
  if (facts.state === "merged" || facts.state === "closed") return STATUS.BLOCKED;
  return STATUS.RUNNING;
}

// Fold N child statuses into a parent status. Precedence is fail-closed: BLOCKED dominates;
// then all-DONE is DONE; then any progress makes it RUNNING; only all-untouched is NOT_STARTED.
function combine(childStatuses) {
  if (childStatuses.length === 0) return STATUS.NOT_STARTED;
  if (childStatuses.some((s) => s === STATUS.BLOCKED)) return STATUS.BLOCKED;
  if (childStatuses.every((s) => s === STATUS.DONE)) return STATUS.DONE;
  if (childStatuses.every((s) => s === STATUS.NOT_STARTED)) return STATUS.NOT_STARTED;
  return STATUS.RUNNING;
}

function isLeaf(node) {
  return !Array.isArray(node.children) || node.children.length === 0;
}

// Recursively fold a node into { id, kind, status, run_id?, children? }. Leaf status comes
// from injected facts; internal status is the combine() of its children's statuses.
function foldNode(node, leafFacts) {
  if (isLeaf(node)) {
    const facts = leafFacts(node) || null;
    return {
      id: node.id,
      kind: "leaf",
      status: leafStatus(facts),
      run_id: (node.leaf && node.leaf.run_id) || null,
    };
  }
  const children = node.children.map((child) => foldNode(child, leafFacts));
  return {
    id: node.id,
    kind: "internal",
    status: combine(children.map((c) => c.status)),
    children,
  };
}

// Fold a whole braid plan. Returns { program_id, root, complete }. `complete` is true only
// when the root folds to DONE — i.e. every leaf reached merged+closed durable evidence.
function foldPlan(plan, leafFacts) {
  const root = foldNode(plan.root, leafFacts);
  return { program_id: plan.id, root, complete: root.status === STATUS.DONE };
}

// Which leaves are ready to dispatch next: NOT_STARTED leaves whose own depends_on and every
// ancestor's depends_on are all DONE. Dependency ordering is thus pure data computed from the
// same fold — no live coordinator loop. `depends_on` ids resolve against the folded status map.
function readyLeaves(plan, folded) {
  const statusById = new Map();
  (function index(node) {
    statusById.set(node.id, node.status);
    if (node.children) node.children.forEach(index);
  })(folded.root);

  const depsSatisfied = (node) =>
    (node.depends_on || []).every((dep) => statusById.get(dep) === STATUS.DONE);

  const ready = [];
  (function walk(planNode, ancestorsEligible) {
    const eligible = ancestorsEligible && depsSatisfied(planNode);
    if (isLeaf(planNode)) {
      if (eligible && statusById.get(planNode.id) === STATUS.NOT_STARTED) {
        ready.push(planNode.id);
      }
      return;
    }
    planNode.children.forEach((child) => walk(child, eligible));
  })(plan.root, true);

  return ready;
}

module.exports = { STATUS, leafStatus, combine, foldNode, foldPlan, readyLeaves };
