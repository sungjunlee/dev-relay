const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildGuidanceMetadata,
  extractReviewAssuranceFromPrompt,
  extractTaskProfileSummaryFromPrompt,
  persistGuidanceMetadata,
} = require("../../../skills/relay-dispatch/scripts/manifest/guidance");

function prompt(lines) {
  return [
    "## Task Profile",
    "",
    "```yaml",
    "task_profile:",
    ...lines.map((line) => `  ${line}`),
    "```",
    "",
    "## Task",
    "Make the requested change.",
  ].join("\n");
}

test("risk-aware task profiles derive and persist compact assurance without guidance filler", () => {
  const text = prompt([
    "size: S",
    "change_type: docs",
    "authority: workspace",
    "reversibility: easy",
    "blast_radius: isolated",
    "trust_boundaries: []",
    "guidance_packs: []",
  ]);

  const summary = extractTaskProfileSummaryFromPrompt(text);
  assert.equal(summary.risk_level, "low");
  assert.equal(summary.minimum_review_assurance, "compact");
  assert.equal(summary.review_assurance, "compact");
  assert.deepEqual(summary.trust_boundaries, []);
  assert.equal(extractReviewAssuranceFromPrompt(text), "compact");

  const metadata = buildGuidanceMetadata({
    promptText: text,
    manifest: {},
    promptSource: "cli",
    rubricPath: "rubric.yaml",
  });
  assert.deepEqual(metadata.guidance_packs, []);
  assert.equal(metadata.task_profile_summary.risk_level, "low");

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-risk-guidance-"));
  const manifest = persistGuidanceMetadata({
    runDir,
    manifest: {},
    metadata,
  });
  assert.equal(
    manifest.advisory.guidance.task_profile_summary.review_assurance,
    "compact"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(
      path.join(runDir, "guidance-metadata.json"),
      "utf8"
    )).task_profile_summary.risk_level,
    "low"
  );
});

test("high-risk profiles cannot declare a lower assurance tier", () => {
  const text = prompt([
    "authority: privileged",
    "reversibility: difficult",
    "blast_radius: broad",
    "trust_boundaries:",
    "  - authorization",
    "review_assurance: standard",
  ]);

  assert.throws(
    () => extractReviewAssuranceFromPrompt(text),
    /below.*hardened.*risk floor/i
  );
});

test("legacy task profiles without risk properties remain readable", () => {
  const text = prompt([
    "size: M",
    "change_type: feature",
    "review_assurance: hardened",
  ]);

  const summary = extractTaskProfileSummaryFromPrompt(text);
  assert.equal(summary.risk_level, undefined);
  assert.equal(summary.review_assurance, "hardened");
  assert.equal(extractReviewAssuranceFromPrompt(text), "hardened");
});
