"use strict";

// Minimal relay-manifest reader — braid needs ONLY the three durable-truth fields the fold
// judges completion on: the lifecycle `state`, the git `pr_number`, and the tracker
// `issue.number`. Relay manifests are YAML-frontmatter `.md` files under
// `~/.relay/runs/<repo-slug>/<run-id>.md`. This is a deliberately tiny frontmatter scanner
// (not a general YAML engine, not a require into the relay skillset) so braid stays a
// standalone sibling. The caller owns the read boundary; parseManifest takes bytes.

function parseScalar(raw) {
  let value = raw.trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return value;
}

// Walk the leading `---`…`---` frontmatter, capturing top-level scalars and one level of
// nesting (enough for `git:`/`issue:` maps). Returns a flat lookup keyed by dotted path.
function parseManifest(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const out = {};
  let parent = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "---") break;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indented = /^\s+/.test(line);
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rest = match[2];
    if (!indented) {
      if (rest === "") {
        parent = key;
      } else {
        parent = null;
        out[key] = parseScalar(rest);
      }
    } else if (parent && rest !== "") {
      out[`${parent}.${key}`] = parseScalar(rest);
    }
  }
  return out;
}

// Derive the three durable facts the fold consumes.
//
// v0 ACCEPTANCE (deliberate, not an oversight): braid trusts a relay manifest in state `merged`
// as the atomic merge+close record. This is sound for relay's contract — `state: merged` is set
// by relay finalize-run ONLY after a squash-merge whose body carries `Fixes #N`, which closes the
// tracker issue. So `pr_merged`/`issue_closed` are DERIVED from `state === "merged"` here. The
// consequence the reviewer must see: the fold's "merged PR but issue still open → blocked" branch
// is unreachable through the default CLI path (only a `closed`/abandoned run reaches `blocked`).
// `overrides` is the seam a future version uses to make that branch reachable by passing a live
// `gh issue view` result as `issue_closed`. Until then, live issue re-verification is deferred
// (see references/design.md). Kept explicit and minimal.
function durableFacts(manifestText, overrides = {}) {
  const fm = parseManifest(manifestText);
  const state = fm.state || null;
  return {
    state,
    pr_number: fm["git.pr_number"] ? Number(fm["git.pr_number"]) : null,
    issue_number: fm["issue.number"] ? Number(fm["issue.number"]) : null,
    pr_merged: overrides.pr_merged !== undefined ? overrides.pr_merged : state === "merged",
    issue_closed: overrides.issue_closed !== undefined ? overrides.issue_closed : state === "merged",
  };
}

module.exports = { parseManifest, durableFacts };
