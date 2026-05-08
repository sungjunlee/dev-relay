const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KIND_NAME,
  buildRecap,
  buildOpencodeAugmentationPrompt,
} = require("../../../../skills/relay-sidecar/scripts/kinds/context-recap");

const REQUIRED_HEADINGS = [
  "## Run summary",
  "## Round history",
  "## Repeated reviewer findings",
  "## Unresolved requirements",
  "## Likely misses",
];

function makeRunContext(overrides = {}) {
  return {
    manifest: {
      run_id: "issue-373-20260508010203000-1234abcd",
      state: "changes_requested",
      git: { working_branch: "issue-373-context-recap" },
      roles: { executor: "codex" },
    },
    events: [],
    verdicts: [],
    redispatchPrompts: [],
    dispatchResult: "",
    runDir: "/tmp/run",
    runId: "issue-373-20260508010203000-1234abcd",
    prNumber: 373,
    ...overrides,
  };
}

function assertRecapShape(recap) {
  assert.match(recap, /^# Recap: /);
  for (const heading of REQUIRED_HEADINGS) {
    assert.match(recap, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
}

test("exports the context-recap kind name", () => {
  assert.equal(KIND_NAME, "context-recap");
});

test("buildRecap handles zero review rounds", () => {
  const recap = buildRecap({ runContext: makeRunContext() });

  assertRecapShape(recap);
  assert.match(recap, /total round count: 0/);
  assert.match(recap, /No review rounds found\./);
});

test("buildRecap lists a single round issue title", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      verdicts: [
        { round: 1, verdict: "changes_requested", issues: [{ title: "Add sidecar index assertion" }] },
      ],
    }),
  });

  assertRecapShape(recap);
  assert.match(recap, /### Round 1: changes_requested/);
  assert.match(recap, /Add sidecar index assertion/);
});

test("buildRecap names repeated findings across rounds", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      verdicts: [
        { round: 1, verdict: "changes_requested", issues: [{ title: "Preserve advisory snapshot" }] },
        { round: 2, verdict: "changes_requested", issues: [{ title: "Preserve advisory snapshot" }] },
      ],
    }),
  });

  assertRecapShape(recap);
  assert.match(recap, /Preserve advisory snapshot \(rounds 1, 2\)/);
});

test("buildRecap detects repeated findings from issue bodies when titles do not match", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      verdicts: [
        {
          round: 1,
          verdict: "changes_requested",
          issues: [{ title: "First title", body: "Forbidden zone touched outside sidecar scope." }],
        },
        {
          round: 2,
          verdict: "changes_requested",
          issues: [{ title: "Different title", body: "Forbidden zone touched outside sidecar scope." }],
        },
      ],
    }),
  });

  assertRecapShape(recap);
  assert.match(recap, /Forbidden zone touched outside sidecar scope\. \(rounds 1, 2\)/);
});

test("buildRecap names latest partial Done Criteria items", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      verdicts: [
        {
          round: 1,
          verdict: "changes_requested",
          scope_drift: {
            missing: [
              { criteria: "Support --executor none without opencode", status: "partial" },
            ],
          },
          issues: [],
        },
      ],
    }),
  });

  assertRecapShape(recap);
  assert.match(recap, /Support --executor none without opencode \(partial\)/);
});

test("buildRecap reports orphan Done Criteria lines and forbidden-zone diff paths", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      verdicts: [
        {
          round: 1,
          verdict: "changes_requested",
          scope_drift: {
            missing: [
              { criteria: "Add deterministic recap output", status: "partial" },
            ],
          },
          issues: [],
        },
      ],
      doneCriteriaSnapshots: [
        { round: 1, text: "- Add deterministic recap output\n- Preserve sidecar index events\n" },
      ],
      diffs: [
        {
          round: 1,
          text: [
            "diff --git a/docs/issue-373.md b/docs/issue-373.md",
            "diff --git a/skills/relay-dispatch/scripts/dispatch.js b/skills/relay-dispatch/scripts/dispatch.js",
            "diff --git a/tests/relay-plan/scripts/probe.test.js b/tests/relay-plan/scripts/probe.test.js",
            "",
          ].join("\n"),
        },
      ],
    }),
  });

  assertRecapShape(recap);
  assert.match(recap, /Orphan Done Criteria line.*Preserve sidecar index events/);
  assert.match(recap, /Forbidden-zone path appears in latest diff: docs\/issue-373\.md/);
  assert.match(recap, /Forbidden-zone path appears in latest diff: skills\/relay-dispatch\/scripts\/dispatch\.js/);
  assert.match(recap, /Forbidden-zone path appears in latest diff: tests\/relay-plan\/scripts\/probe\.test\.js/);
});

test("buildRecap avoids standalone completion claims on a clean pass input", () => {
  const recap = buildRecap({
    runContext: makeRunContext({
      manifest: {
        run_id: "issue-373-20260508010203000-1234abcd",
        state: "ready_to_merge",
        git: { working_branch: "issue-373-context-recap" },
        roles: { executor: "codex" },
      },
      verdicts: [
        {
          round: 1,
          verdict: "pass",
          next_action: "ready_to_merge",
          scope_drift: {
            missing: [
              { criteria: "Add context recap builder", status: "verified" },
            ],
          },
          issues: [],
        },
      ],
      doneCriteriaSnapshots: [
        { round: 1, text: "- Add context recap builder\n" },
      ],
    }),
  });

  assertRecapShape(recap);
  for (const phrase of ["ready to merge", "complete", "all clear", "LGTM", "passed"]) {
    assert.doesNotMatch(recap, new RegExp(`^\\s*${phrase}\\s*$`, "im"));
  }
});

test("buildOpencodeAugmentationPrompt includes a stable marker and baseline recap", () => {
  const baselineRecap = "# Recap: run\n\n## Run summary\n";
  const prompt = buildOpencodeAugmentationPrompt({
    runContext: makeRunContext(),
    baselineRecap,
  });

  assert.match(prompt, /CONTEXT_RECAP_AUGMENTATION_REQUEST/);
  assert.match(prompt, /# Recap: run/);
});
