const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KIND_NAME,
  buildRecap,
  buildOpencodeAugmentationPrompt,
} = require("../../../../skills/relay-sidecar/scripts/kinds/docs-sync");

const REQUIRED_HEADINGS = [
  "## Run summary",
  "## Likely stale docs",
  "## Recommended updates",
  "## Optional patch hints",
  "## Confidence and limitations",
];

function makeRunContext(overrides = {}) {
  return {
    manifest: {
      run_id: "issue-375-20260508010203000-1234abcd",
      state: "review_pending",
      git: { working_branch: "issue-375-docs-sync" },
    },
    events: [],
    verdicts: [],
    redispatchPrompts: [],
    dispatchResult: "",
    runDir: "/tmp/run",
    runId: "issue-375-20260508010203000-1234abcd",
    prNumber: 375,
    diff: "",
    docCandidates: {},
    ...overrides,
  };
}

function assertRecapShape(recap) {
  assert.match(recap, /^# Docs sync report: /);
  let lastIndex = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const index = recap.indexOf(heading);
    assert.notEqual(index, -1, `${heading} should be present`);
    assert.ok(index > lastIndex, `${heading} should appear in order`);
    lastIndex = index;
  }
}

function section(recap, heading) {
  const start = recap.indexOf(`${heading}\n\n`);
  if (start === -1) return "";
  const contentStart = start + heading.length + 2;
  const nextHeading = recap.indexOf("\n## ", contentStart);
  return recap.slice(contentStart, nextHeading === -1 ? undefined : nextHeading).trim();
}

test("exports the docs-sync kind name", () => {
  assert.equal(KIND_NAME, "docs-sync");
});

test("buildRecap includes all required headings on minimal input", () => {
  const recap = buildRecap({ runContext: makeRunContext() });

  assertRecapShape(recap);
  assert.match(recap, /kind: docs-sync/);
  assert.match(section(recap, "## Likely stale docs"), /No likely stale docs detected\./);
  assert.match(section(recap, "## Recommended updates"), /No update recommendations available\./);
  assert.match(section(recap, "## Optional patch hints"), /No patch hints available\./);
});

test("buildRecap lists docs that mention changed source path basenames", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      diff: [
        "diff --git a/skills/relay-foo/scripts/baz.js b/skills/relay-foo/scripts/baz.js",
        "+++ b/skills/relay-foo/scripts/baz.js",
        "+function changedBaz() {}",
      ].join("\n"),
      docCandidates: {
        "README.md": "Use baz.js for relay foo behavior.\n",
      },
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Likely stale docs"), /README\.md/);
  assert.match(section(recap, "## Likely stale docs"), /baz\.js/);
});

test("buildRecap reports no stale docs when docs do not overlap the diff", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      diff: [
        "diff --git a/skills/relay-foo/scripts/baz.js b/skills/relay-foo/scripts/baz.js",
        "+++ b/skills/relay-foo/scripts/baz.js",
        "+function changedBaz() {}",
      ].join("\n"),
      docCandidates: {
        "README.md": "Unrelated relay notes.\n",
      },
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Likely stale docs"), /No likely stale docs detected\./);
});

test("buildRecap emits patch hints for sections containing changed symbols", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      diff: [
        "diff --git a/skills/relay-sidecar/scripts/kinds/docs-sync.js b/skills/relay-sidecar/scripts/kinds/docs-sync.js",
        "+++ b/skills/relay-sidecar/scripts/kinds/docs-sync.js",
        "+function exportedFn() {",
        "+  return true;",
        "+}",
      ].join("\n"),
      docCandidates: {
        "docs/architecture.md": [
          "# Architecture",
          "",
          "## Components",
          "",
          "The exportedFn helper powers docs-sync matching.",
        ].join("\n"),
      },
    }),
  });

  assertRecapShape(recap);
  const hints = section(recap, "## Optional patch hints");
  assert.match(hints, /docs\/architecture\.md/);
  assert.match(hints, /Architecture > Components/);
  assert.match(hints, /exportedFn/);
});

test("buildRecap falls back for all content sections when docCandidates is empty", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      diff: [
        "diff --git a/skills/relay-sidecar/scripts/kinds/docs-sync.js b/skills/relay-sidecar/scripts/kinds/docs-sync.js",
        "+++ b/skills/relay-sidecar/scripts/kinds/docs-sync.js",
        "+function exportedFn() {}",
      ].join("\n"),
      docCandidates: {},
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Likely stale docs"), /No likely stale docs detected\./);
  assert.match(section(recap, "## Recommended updates"), /No update recommendations available\./);
  assert.match(section(recap, "## Optional patch hints"), /No patch hints available\./);
});

test("buildRecap avoids standalone completion claims", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      manifest: {
        run_id: "issue-375-20260508010203000-1234abcd",
        state: "ready_to_merge",
        git: { working_branch: "issue-375-docs-sync" },
      },
      diff: [
        "diff --git a/skills/x/scripts/claim.js b/skills/x/scripts/claim.js",
        "+++ b/skills/x/scripts/claim.js",
        "+function passed() {}",
      ].join("\n"),
      docCandidates: {
        "README.md": "complete LGTM all clear ready to merge passed\n",
      },
    }),
  });

  assertRecapShape(recap);
  for (const phrase of ["ready to merge", "complete", "all clear", "LGTM", "passed"]) {
    assert.doesNotMatch(recap, new RegExp(`^\\s*${phrase}\\s*$`, "im"));
  }
});

test("buildRecap confidence disclaimer states all required limitations", () => {
  const recap = buildRecap({ runContext: makeRunContext() });
  const confidence = section(recap, "## Confidence and limitations");

  assert.match(confidence, /advisory/i);
  assert.match(confidence, /simple heuristics/i);
  assert.match(confidence, /reviewer is the final gate/i);
  assert.match(confidence, /absence of a stale-doc signal/i);
  assert.match(confidence, /does not apply patches/i);
});

test("buildOpencodeAugmentationPrompt includes marker and baseline report", () => {
  const baselineRecap = "# Docs sync report: run\n\n## Run summary\n";
  const prompt = buildOpencodeAugmentationPrompt({
    runContext: makeRunContext(),
    baselineRecap,
  });

  assert.match(prompt, /DOCS_SYNC_AUGMENTATION_REQUEST/);
  assert.match(prompt, /BASELINE REPORT/);
  assert.match(prompt, /# Docs sync report: run/);
});
