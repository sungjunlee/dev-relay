const test = require("node:test");
const assert = require("node:assert/strict");

const {
  emitQaEvents,
  runQaLoop,
  selectQuestionDimension,
} = require("../../../skills/relay-ready/scripts/run-qa-loop");

const VERIFIABILITY_LOW_BODY = `Update \`skills/relay-ready/scripts/run-qa-loop.js\` so the sequential Q&A loop returns deterministic action objects for a caller that stores answers externally.

The implementation should stay pure, keep caller I/O outside this module, and preserve a compact event ledger that a post-hook can replay through relay-ready request helpers.

## Done Criteria

- The loop returns stable actions for repeated invocations with the same answer history.
`;

const GRANULARITY_LOW_BODY = `Update parser and docs in \`src/parser/index.js\` while keeping the parse API stable for existing callers across the relay-ready parser surface.

The request is deliberately long enough to avoid the short-body gate, names a concrete file target, and keeps verification objective so only the opener's top-level conjunction should remain low.

## Done Criteria

- \`src/parser/index.js\` keeps parse output stable.
- \`tests/parser/index.test.js\` passes.
`;

function eventNames(result) {
  return result.events.map((event) => event.event);
}

function askedDimensions(result) {
  return result.events
    .filter((event) => event.event === "question_asked")
    .map((event) => event.payload.dimension);
}

test("all_yes accepts extracted defaults and proceeds when the default closes the low score", () => {
  const result = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    leaf_id: "leaf-yes",
    answers: [{ dimension: "verifiability", answer: "yes" }],
  });

  assert.equal(result.action, "proceed");
  assert.equal(result.budget_used, 1);
  assert.deepEqual(askedDimensions(result), ["verifiability"]);
  assert.deepEqual(eventNames(result), [
    "question_asked",
    "question_answered",
    "proposal_accepted",
  ]);

  const helperCalls = [];
  emitQaEvents({
    repoRoot: "/tmp/repo",
    requestId: "req-1",
    events: result.events,
    helpers: {
      clarify(_repoRoot, _requestId, data) {
        helperCalls.push(["clarify", data.dimension, data.default]);
      },
      answerQuestion(_repoRoot, _requestId, data) {
        helperCalls.push(["answerQuestion", data.dimension, data.accepted_default]);
      },
      acceptProposal(_repoRoot, _requestId, data) {
        helperCalls.push(["acceptProposal", data.dimension, data.default]);
      },
      editProposal() {
        helperCalls.push(["editProposal"]);
      },
    },
  });
  assert.deepEqual(helperCalls.map((call) => call[0]), [
    "clarify",
    "answerQuestion",
    "acceptProposal",
  ]);
  assert.equal(helperCalls[0][1], "verifiability");
  assert.match(helperCalls[0][2], /tests\/relay-ready\/scripts\/run-qa-loop\.test\.js/);
});

test("all_no_or_silent does not charge budget and escalates after one retry", () => {
  const result = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    answers: [
      { dimension: "verifiability", answer: "skip" },
      { dimension: "verifiability", answer: "  " },
    ],
  });

  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "clarification_retry_exhausted");
  assert.equal(result.budget_used, 0);
  assert.deepEqual(result.dimensions_low, ["verifiability"]);
  assert.deepEqual(askedDimensions(result), ["verifiability", "verifiability"]);
  assert.deepEqual(eventNames(result), [
    "question_asked",
    "question_answered",
    "question_asked",
    "question_answered",
  ]);
});

test("override_with_specific_text advances to proceed when the override re-scores high", () => {
  const result = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    answers: [{
      dimension: "verifiability",
      answer: "`tests/relay-ready/scripts/run-qa-loop.test.js` passes and the event ledger lists Q&A events in order.",
    }],
  });

  assert.equal(result.action, "proceed");
  assert.equal(result.budget_used, 1);
  assert.deepEqual(askedDimensions(result), ["verifiability"]);
  assert.deepEqual(eventNames(result), [
    "question_asked",
    "question_answered",
    "proposal_edited",
  ]);

  const helperCalls = [];
  emitQaEvents({
    repoRoot: "/tmp/repo",
    requestId: "req-override",
    events: result.events,
    helpers: {
      clarify(_repoRoot, _requestId, data) {
        helperCalls.push(["clarify", data.dimension]);
      },
      answerQuestion(_repoRoot, _requestId, data) {
        helperCalls.push(["answerQuestion", data.dimension]);
      },
      acceptProposal() {
        helperCalls.push(["acceptProposal"]);
      },
      editProposal(_repoRoot, _requestId, data) {
        helperCalls.push(["editProposal", data.dimension, data.override]);
      },
    },
  });
  assert.deepEqual(helperCalls.map((call) => call[0]), [
    "clarify",
    "answerQuestion",
    "editProposal",
  ]);
  assert.equal(helperCalls[2][1], "verifiability");
  assert.match(helperCalls[2][2], /run-qa-loop\.test\.js/);
});

test("override_with_vague_text is re-asked without laundering the budget", () => {
  const result = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    answers: [{ dimension: "verifiability", answer: "improve it" }],
  });

  assert.equal(result.action, "ask");
  assert.equal(result.dimension, "verifiability");
  assert.equal(result.budget_used, 0);
  assert.match(result.question, /"improve it"/);
  assert.deepEqual(askedDimensions(result), ["verifiability", "verifiability"]);
  assert.deepEqual(eventNames(result), [
    "question_asked",
    "question_answered",
    "proposal_edited",
    "question_asked",
  ]);
});

test("escalation_path triggers instead of asking a fourth budgeted question", () => {
  const result = runQaLoop({
    body: GRANULARITY_LOW_BODY,
    answers: [
      { dimension: "granularity", answer: "yes" },
      { dimension: "granularity", answer: "yes" },
      { dimension: "granularity", answer: "yes" },
    ],
  });

  assert.equal(result.action, "escalate");
  assert.equal(result.reason, "question_budget_exhausted");
  assert.equal(result.budget_used, 3);
  assert.deepEqual(result.dimensions_low, ["granularity"]);
  assert.deepEqual(askedDimensions(result), ["granularity", "granularity", "granularity"]);
});

test("reentry_with_prior_escalation asks the recovery question first without charging budget", () => {
  const first = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    reentry: true,
    leaf_id: "leaf-reentry",
  });

  assert.equal(first.action, "ask");
  assert.equal(first.dimension, "_reentry");
  assert.equal(first.question, "Discard prior or update?");
  assert.equal(first.budget_used, 0);
  assert.deepEqual(askedDimensions(first), ["_reentry"]);

  const resumed = runQaLoop({
    body: VERIFIABILITY_LOW_BODY,
    reentry: true,
    leaf_id: "leaf-reentry",
    answers: [
      { dimension: "_reentry", answer: "update" },
      { dimension: "verifiability", answer: "yes" },
    ],
  });

  assert.equal(resumed.action, "proceed");
  assert.equal(resumed.budget_used, 1);
  assert.deepEqual(askedDimensions(resumed), ["_reentry", "verifiability"]);
});

test("bypass_input proceeds immediately and suppresses all Q&A events", () => {
  const result = runQaLoop({
    scored: {
      readiness: {
        clarity: "high",
        granularity: "high",
        verifiability: "high",
      },
      bypass: true,
      signals: [],
      next_action: "proceed",
    },
  });

  assert.equal(result.action, "proceed");
  assert.equal(result.budget_used, 0);
  assert.deepEqual(result.events, []);
});

test("initial call returns an ask action for the highest-priority low dimension", () => {
  const result = runQaLoop({ body: VERIFIABILITY_LOW_BODY });

  assert.equal(result.action, "ask");
  assert.equal(result.dimension, "verifiability");
  assert.equal(result.budget_used, 0);
  assert.equal(result.budget_max, 3);
});

test("question priority is deterministic across score combinations", () => {
  const cases = [
    [{
      verifiability: "low",
      clarity: "low",
      granularity: "low",
    }, "verifiability"],
    [{
      verifiability: "medium",
      clarity: "low",
      granularity: "low",
    }, "clarity"],
    [{
      verifiability: "high",
      clarity: "medium",
      granularity: "low",
    }, "granularity"],
    [{
      verifiability: "medium",
      clarity: "medium",
      granularity: "medium",
    }, null],
  ];

  for (const [readiness, expected] of cases) {
    assert.equal(selectQuestionDimension(readiness), expected);
  }
});
