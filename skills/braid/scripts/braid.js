#!/usr/bin/env node
"use strict";

// braid v0 — decompose deep, execute flat. This CLI is the ONLY I/O boundary; the fold/plan
// libs stay pure. Two read-only intents in v0:
//   validate --plan <file>   → check a human-authored decomposition tree
//   status   --plan <file>   → fold relay's durable truth over the tree, print rolled-up
//                              status + which leaves are ready to dispatch next
// braid never dispatches, supervises, or couples to any runtime. Leaves are driven by ordinary
// `relay`; braid only tells you what is ready and whether the whole tree is done.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validatePlan, BraidPlanError } = require("./lib/plan");
const { foldPlan, readyLeaves, STATUS } = require("./lib/fold");
const { durableFacts } = require("./lib/manifest");

function fail(message, code = 1) {
  process.stderr.write(`braid: ${message}\n`);
  process.exit(code);
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function loadPlan(planPath) {
  if (!planPath) fail("--plan <file> is required");
  let raw;
  try {
    raw = fs.readFileSync(planPath, "utf8");
  } catch (error) {
    fail(`cannot read plan ${planPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`plan ${planPath} is not valid JSON: ${error.message}`);
  }
  try {
    return validatePlan(parsed);
  } catch (error) {
    if (error instanceof BraidPlanError) fail(error.message, 2);
    throw error;
  }
}

// Resolve a leaf's durable facts by reading its mapped relay manifest. v0 maps ONLY via an
// explicit `leaf.run_id` (no guessing); a leaf without a run_id is "not started". The runs
// root honors RELAY_HOME. Returns null when unmapped or unreadable (→ NOT_STARTED, fail-open
// to "not started" is safe here because an unmapped leaf genuinely has no evidence yet).
function makeLeafFacts(repoSlug) {
  const relayHome = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const runsRoot = path.join(relayHome, "runs", repoSlug);
  return (node) => {
    const runId = node.leaf && node.leaf.run_id;
    if (!runId) return null;
    const manifestPath = path.join(runsRoot, `${runId}.md`);
    let text;
    try {
      text = fs.readFileSync(manifestPath, "utf8");
    } catch {
      return null;
    }
    return durableFacts(text);
  };
}

function printStatus(planPath, repoSlug, json) {
  const plan = loadPlan(planPath);
  const folded = foldPlan(plan, makeLeafFacts(repoSlug));
  const ready = readyLeaves(plan, folded);
  const report = { ok: true, program_id: folded.program_id, complete: folded.complete, status: folded.root.status, ready_leaves: ready, tree: folded.root };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`braid ${folded.program_id}: ${folded.root.status}${folded.complete ? " (COMPLETE)" : ""}\n`);
  const lines = [];
  (function render(node, depth) {
    lines.push(`${"  ".repeat(depth)}- ${node.id} [${node.status}]${node.kind === "leaf" && node.run_id ? ` ← ${node.run_id}` : ""}`);
    if (node.children) node.children.forEach((child) => render(child, depth + 1));
  })(folded.root, 0);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(`ready to dispatch next: ${ready.length ? ready.join(", ") : "(none)"}\n`);
}

function main(argv) {
  const intent = argv[0];
  const json = argv.includes("--json");
  const planPath = readArg(argv, "--plan");
  const repoSlug = readArg(argv, "--repo-slug") || process.env.BRAID_REPO_SLUG || "";
  if (intent === "validate") {
    loadPlan(planPath);
    process.stdout.write(json ? `${JSON.stringify({ ok: true }, null, 2)}\n` : "braid: plan is valid\n");
    return;
  }
  if (intent === "status") {
    if (!repoSlug) fail("status requires --repo-slug <slug> (or BRAID_REPO_SLUG) to locate relay manifests");
    printStatus(planPath, repoSlug, json);
    return;
  }
  fail("usage: braid <validate|status> --plan <file> [--repo-slug <slug>] [--json]", 64);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
