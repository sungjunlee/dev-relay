"use strict";

// Pure relay-manifest reader (#945 D4). Relay manifests are YAML-frontmatter `.md`
// files; `status` reads ONLY the durable lifecycle facts it needs — the manifest
// `state`, the git PR number, and the tracker issue number — from the frontmatter.
// The top-level script reads the file bytes; this module parses the text and never
// touches the filesystem, so plan.js's frozen lib source-scan keeps passing.
//
// The frontmatter is walked with a small indentation-stack scanner (not a general
// YAML engine): it captures scalar leaves and nested maps, which is sufficient for
// the pinned `state` / `git.pr_number` / `issue.number` lookups against both the
// real relay manifest shape and the self-contained test fixtures.

// Relay lifecycle states that count as a durable terminal for completion evidence
// (D4/D5): a run reaches `merged` (or `closed` as the contract requires). Everything
// else (draft/dispatched/review_pending/ready_to_merge/changes_requested) is
// non-terminal. `escalated` is treated separately as an escalation signal.
const TERMINAL_MANIFEST_STATES = new Set(["merged", "closed"]);
const ESCALATED_MANIFEST_STATES = new Set(["escalated"]);

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  const unquoted = value.replace(/^['"]/, "").replace(/['"]$/, "");
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function frontmatterBlock(text) {
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

// Build a nested object from the frontmatter by tracking indentation depth. List
// items and comments are skipped — `status` never reads list-valued manifest fields.
function parseFrontmatter(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const line of frontmatterBlock(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) continue;
    const indent = line.match(/^ */)[0].length;
    const rest = line.slice(indent);
    const colon = rest.indexOf(":");
    if (colon < 0) continue;
    const key = rest.slice(0, colon).trim();
    const valuePart = rest.slice(colon + 1);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (valuePart.trim() === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = parseScalar(valuePart);
    }
  }
  return root;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Extract the durable lifecycle facts `status` reconciles against. Every field is
// null when absent so the classifier can distinguish "unknown" from a real value.
function parseManifest(text) {
  const frontmatter = parseFrontmatter(text);
  const git = asObject(frontmatter.git);
  const issue = asObject(frontmatter.issue);
  return {
    run_id: typeof frontmatter.run_id === "string" ? frontmatter.run_id : null,
    state: typeof frontmatter.state === "string" ? frontmatter.state : null,
    pr_number: typeof git.pr_number === "number" ? git.pr_number : null,
    working_branch: typeof git.working_branch === "string" ? git.working_branch : null,
    base_branch: typeof git.base_branch === "string" ? git.base_branch : null,
    head_sha: typeof git.head_sha === "string" ? git.head_sha : null,
    issue_number: typeof issue.number === "number" ? issue.number : null,
  };
}

function isTerminalManifestState(state) {
  return typeof state === "string" && TERMINAL_MANIFEST_STATES.has(state);
}

function isEscalatedManifestState(state) {
  return typeof state === "string" && ESCALATED_MANIFEST_STATES.has(state);
}

module.exports = {
  TERMINAL_MANIFEST_STATES,
  ESCALATED_MANIFEST_STATES,
  parseFrontmatter,
  parseManifest,
  isTerminalManifestState,
  isEscalatedManifestState,
};
