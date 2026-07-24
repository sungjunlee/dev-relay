"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseManifest, durableFacts } = require("../../../skills/braid/scripts/lib/manifest");

// A representative relay manifest head (frontmatter only is read).
const MANIFEST = [
  "---",
  "relay_version: 2",
  "run_id: 'issue-1-abc'",
  "state: 'merged'",
  "# a comment line",
  "",
  "git:",
  "  base_branch: 'main'",
  "  pr_number: 1069",
  "issue:",
  "  number: 1063",
  "  source: 'github'",
  "policy:",
  "  merge: 'manual_after_lgtm'",
  "---",
  "",
  "# Body starts here (must be ignored)",
  "state: not-this-one",
].join("\n");

test("parseManifest reads top-level scalars and one level of nesting", () => {
  const fm = parseManifest(MANIFEST);
  assert.equal(fm.state, "merged");
  assert.equal(fm["git.pr_number"], "1069");
  assert.equal(fm["issue.number"], "1063");
  assert.equal(fm["policy.merge"], "manual_after_lgtm");
});

test("parseManifest strips quotes, skips comments/blanks, and stops at the closing ---", () => {
  const fm = parseManifest(MANIFEST);
  assert.equal(fm.run_id, "issue-1-abc"); // single-quoted stripped
  assert.ok(!("source" in fm)); // nested key exposed only as issue.source
  assert.equal(fm["issue.source"], "github");
  // a body line after the closing --- must not leak in
  assert.equal(fm.state, "merged");
});

test("parseManifest returns {} when the text has no leading frontmatter", () => {
  assert.deepEqual(parseManifest("no frontmatter here\nstate: merged"), {});
  assert.deepEqual(parseManifest(""), {});
  assert.deepEqual(parseManifest(null), {});
});

test("durableFacts derives done-shaped facts from a merged manifest", () => {
  const facts = durableFacts(MANIFEST);
  assert.equal(facts.state, "merged");
  assert.equal(facts.pr_number, 1069);
  assert.equal(facts.issue_number, 1063);
  // v0 acceptance: state==='merged' is trusted as the merge+close record.
  assert.equal(facts.pr_merged, true);
  assert.equal(facts.issue_closed, true);
});

test("durableFacts on a non-terminal manifest yields not-merged facts", () => {
  const running = MANIFEST.replace("state: 'merged'", "state: 'review_pending'");
  const facts = durableFacts(running);
  assert.equal(facts.state, "review_pending");
  assert.equal(facts.pr_merged, false);
  assert.equal(facts.issue_closed, false);
});

test("durableFacts overrides take precedence over the state-derived defaults", () => {
  // this is the path a future live-gh read uses to make the fail-closed branch reachable
  const facts = durableFacts(MANIFEST, { issue_closed: false });
  assert.equal(facts.pr_merged, true); // still derived from merged
  assert.equal(facts.issue_closed, false); // override wins
});

test("durableFacts on a manifest with no state is null-safe", () => {
  const facts = durableFacts("---\nrun_id: 'x'\n---");
  assert.equal(facts.state, null);
  assert.equal(facts.pr_merged, false);
  assert.equal(facts.issue_closed, false);
  assert.equal(facts.pr_number, null);
});
