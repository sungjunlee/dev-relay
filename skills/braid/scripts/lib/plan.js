"use strict";

// Pure validator/parser for a braid plan — a human-authored decomposition tree (v0: no auto
// decomposition). A node is a LEAF (a relay-able unit) iff it has `leaf` and no children; it is
// INTERNAL iff it has a non-empty `children` array and no `leaf`. The validator enforces the
// tree shape, unique ids, and acyclic sibling-scoped `depends_on`; it reads no filesystem.

class BraidPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "BraidPlanError";
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Validate one node; collect ids and depends_on edges for the global cycle/ref check.
function validateNode(node, ids, edges, path) {
  if (!isObject(node)) throw new BraidPlanError(`${path} must be an object`);
  if (!nonEmptyString(node.id)) throw new BraidPlanError(`${path} must have a non-empty string id`);
  if (ids.has(node.id)) throw new BraidPlanError(`duplicate node id "${node.id}"`);
  ids.add(node.id);

  const hasLeaf = node.leaf !== undefined;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  if (hasLeaf && hasChildren) {
    throw new BraidPlanError(`node "${node.id}" is both a leaf and an internal node`);
  }
  if (!hasLeaf && !hasChildren) {
    throw new BraidPlanError(`node "${node.id}" is neither a leaf (needs \`leaf\`) nor internal (needs \`children\`)`);
  }

  if (node.depends_on !== undefined) {
    if (!Array.isArray(node.depends_on)) throw new BraidPlanError(`node "${node.id}" depends_on must be an array`);
    for (const dep of node.depends_on) {
      if (!nonEmptyString(dep)) throw new BraidPlanError(`node "${node.id}" has an empty depends_on entry`);
      if (dep === node.id) throw new BraidPlanError(`node "${node.id}" depends on itself`);
      edges.push([node.id, dep]);
    }
  }

  if (hasLeaf) {
    if (!isObject(node.leaf)) throw new BraidPlanError(`node "${node.id}" leaf must be an object`);
    const hasIssue = Number.isInteger(node.leaf.issue);
    const hasTask = nonEmptyString(node.leaf.task);
    if (!hasIssue && !hasTask) {
      throw new BraidPlanError(`leaf "${node.id}" must carry an integer \`issue\` or a non-empty \`task\``);
    }
    if (node.leaf.run_id !== undefined && !nonEmptyString(node.leaf.run_id)) {
      throw new BraidPlanError(`leaf "${node.id}" run_id must be a non-empty string when present`);
    }
    return;
  }

  node.children.forEach((child, index) => validateNode(child, ids, edges, `${path}.children[${index}]`));
}

// Every depends_on id must reference a known node, and the dependency graph must be acyclic.
function assertResolvableAcyclic(ids, edges) {
  for (const [from, dep] of edges) {
    if (!ids.has(dep)) throw new BraidPlanError(`node "${from}" depends on unknown id "${dep}"`);
  }
  const adjacency = new Map();
  for (const [from, dep] of edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(dep);
  }
  const state = new Map(); // id -> 0 visiting, 1 done
  const visit = (id) => {
    if (state.get(id) === 1) return;
    if (state.get(id) === 0) throw new BraidPlanError(`dependency cycle involving "${id}"`);
    state.set(id, 0);
    for (const dep of adjacency.get(id) || []) visit(dep);
    state.set(id, 1);
  };
  for (const id of adjacency.keys()) visit(id);
}

// Accept `{ braid: {...} }` or the bare plan object. Returns the validated plan `{ id, root }`.
function validatePlan(input) {
  const plan = isObject(input) && isObject(input.braid) ? input.braid : input;
  if (!isObject(plan)) throw new BraidPlanError("braid plan must be an object");
  if (!nonEmptyString(plan.id)) throw new BraidPlanError("braid plan must have a non-empty id");
  if (!isObject(plan.root)) throw new BraidPlanError("braid plan must have a root node");

  const ids = new Set();
  const edges = [];
  validateNode(plan.root, ids, edges, "root");
  assertResolvableAcyclic(ids, edges);
  return { id: plan.id, root: plan.root };
}

module.exports = { validatePlan, BraidPlanError };
