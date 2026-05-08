const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KIND_NAME,
  buildRecap,
  buildOpencodeAugmentationPrompt,
} = require("../../../../skills/relay-sidecar/scripts/kinds/test-gap");

const REQUIRED_HEADINGS = [
  "## Run summary",
  "## Required gaps",
  "## Optional hardening",
  "## Done Criteria coverage",
  "## Confidence and limitations",
];

function makeRunContext(overrides = {}) {
  return {
    manifest: {
      run_id: "issue-374-20260508010203000-1234abcd",
      state: "review_pending",
      git: { working_branch: "issue-374-test-gap" },
    },
    events: [],
    verdicts: [],
    redispatchPrompts: [],
    dispatchResult: "",
    runDir: "/tmp/run",
    runId: "issue-374-20260508010203000-1234abcd",
    prNumber: 374,
    rubric: "",
    doneCriteria: "- Add test-gap sidecar\n",
    diff: "",
    ...overrides,
  };
}

function assertRecapShape(recap) {
  assert.match(recap, /^# Test gap report: /);
  let lastIndex = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const index = recap.indexOf(heading);
    assert.notEqual(index, -1, `${heading} should be present`);
    assert.ok(index > lastIndex, `${heading} should appear in order`);
    lastIndex = index;
  }
}

function section(recap, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = recap.match(new RegExp(`^${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |\\n*$)`, "m"));
  return match ? match[1] : "";
}

test("exports the test-gap kind name", () => {
  assert.equal(KIND_NAME, "test-gap");
});

test("buildRecap includes all required headings on minimal input", () => {
  const recap = buildRecap({ runContext: makeRunContext({ doneCriteria: undefined }) });

  assertRecapShape(recap);
  assert.match(recap, /kind: test-gap/);
  assert.match(recap, /Done Criteria text was unavailable in this run context\./);
});

test("buildRecap lists rubric node --test paths missing from the diff as required gaps", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      rubric: [
        "factors:",
        "  - name: Unit tests",
        "    command: node --test tests/foo.test.js",
        "    target: pass",
      ].join("\n"),
      diff: [
        "diff --git a/skills/foo/scripts/foo.js b/skills/foo/scripts/foo.js",
        "+++ b/skills/foo/scripts/foo.js",
      ].join("\n"),
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Required gaps"), /tests\/foo\.test\.js/);
});

test("buildRecap lists block-scalar rubric node --test paths missing from the diff as required gaps", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      rubric: [
        "factors:",
        "  - name: Sidecar integration tests",
        "    command: |",
        "      node --test tests/relay-sidecar/scripts/kinds/block-scalar.test.js",
        "    target: pass",
      ].join("\n"),
      diff: [
        "diff --git a/skills/relay-sidecar/scripts/kinds/test-gap.js b/skills/relay-sidecar/scripts/kinds/test-gap.js",
        "+++ b/skills/relay-sidecar/scripts/kinds/test-gap.js",
      ].join("\n"),
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Required gaps"), /tests\/relay-sidecar\/scripts\/kinds\/block-scalar\.test\.js/);
});

test("buildRecap reports empty required gaps when rubric has no test-invoking factors", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      rubric: "factors:\n  - name: Manual review\n    target: inspect\n",
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Required gaps"), /No required test gaps detected\./);
});

test("buildRecap suggests optional hardening for changed source without paired test diff", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      diff: [
        "diff --git a/skills/x/scripts/foo.js b/skills/x/scripts/foo.js",
        "+++ b/skills/x/scripts/foo.js",
      ].join("\n"),
    }),
  });

  assertRecapShape(recap);
  assert.match(section(recap, "## Optional hardening"), /skills\/x\/scripts\/foo\.js/);
  assert.match(section(recap, "## Optional hardening"), /tests\/x\/scripts\/foo\.test\.js/);
});

test("buildRecap keeps required findings out of optional hardening", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      rubric: "command: node --test tests/x/scripts/foo.test.js\n",
      diff: [
        "diff --git a/skills/x/scripts/foo.js b/skills/x/scripts/foo.js",
        "+++ b/skills/x/scripts/foo.js",
      ].join("\n"),
    }),
  });

  const required = section(recap, "## Required gaps");
  const optional = section(recap, "## Optional hardening");
  assert.match(required, /tests\/x\/scripts\/foo\.test\.js/);
  assert.doesNotMatch(optional, /tests\/x\/scripts\/foo\.test\.js/);
});

test("buildRecap avoids standalone completion claims", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      manifest: {
        run_id: "issue-374-20260508010203000-1234abcd",
        state: "ready_to_merge",
        git: { working_branch: "issue-374-test-gap" },
      },
      rubric: "command: node --test tests/foo.test.js\n",
      diff: "diff --git a/tests/foo.test.js b/tests/foo.test.js\n+++ b/tests/foo.test.js\n",
      doneCriteria: "- Complete the test-gap report\n- LGTM must not be emitted as a status\n",
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
  assert.match(confidence, /simple substring and path-glob heuristics/i);
  assert.match(confidence, /reviewer remains the final gate/i);
  assert.match(confidence, /absence of a gap signal does not mean coverage is complete/i);
});

test("buildOpencodeAugmentationPrompt includes marker and baseline report", () => {
  const baselineRecap = "# Test gap report: run\n\n## Run summary\n";
  const prompt = buildOpencodeAugmentationPrompt({
    runContext: makeRunContext(),
    baselineRecap,
  });

  assert.match(prompt, /TEST_GAP_AUGMENTATION_REQUEST/);
  assert.match(prompt, /BASELINE REPORT/);
  assert.match(prompt, /# Test gap report: run/);
});
