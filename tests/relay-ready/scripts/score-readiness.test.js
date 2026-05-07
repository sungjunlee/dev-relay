const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  READINESS_CONDITIONS,
  scoreReadiness,
} = require("../../../skills/relay-ready/scripts/score-readiness");

const SOURCE = path.join(__dirname, "..", "..", "..", "skills", "relay-ready", "scripts", "score-readiness.js");

function hasSignal(result, dimension, condition) {
  return result.signals.some((signal) => signal.dimension === dimension && signal.condition === condition);
}

function signalEvidence(result, dimension, condition) {
  const signal = result.signals.find((entry) => entry.dimension === dimension && entry.condition === condition);
  return signal ? signal.evidence : null;
}

function assertSignalShape(result) {
  assert.ok(Array.isArray(result.signals));
  for (const signal of result.signals) {
    assert.ok(["clarity", "granularity", "verifiability", "bypass"].includes(signal.dimension));
    assert.equal(typeof signal.condition, "string");
    assert.equal(typeof signal.evidence, "string");
    assert.ok(signal.evidence.length <= 80, `oversized evidence: ${signal.evidence}`);
  }
}

test("borderline_ac keeps subjective AC out of bypass and marks verifiability low", () => {
  const body = `Improve dashboard performance

## Done Criteria

- The system feels faster and smoother to use.
`;

  const result = scoreReadiness(body);

  assert.equal(result.readiness.verifiability, "low");
  assert.equal(result.bypass, false);
  assert.equal(result.next_action, "qa_needed");
  assert.ok(hasSignal(result, "verifiability", READINESS_CONDITIONS.SUBJECTIVE_LANGUAGE));
  assert.ok(hasSignal(result, "verifiability", READINESS_CONDITIONS.MISSING_OBSERVABLE_DONE_CRITERIA));
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.DONE_CRITERIA_HEADING));
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.OBSERVABLE_ASSERTION));
  assertSignalShape(result);
});

test("multi_verb_single_leaf does not lower granularity for shared-subsystem verbs", () => {
  const body = `Refactor and document the X parser in \`src/parser/x-parser.js\`.

## Done Criteria

- \`src/parser/x-parser.js\` keeps \`parseRecord()\` behavior stable.
- \`tests/parser/x-parser.test.js\` passes.
`;

  const result = scoreReadiness(body);

  assert.notEqual(result.readiness.granularity, "low");
  assert.equal(result.readiness.granularity, "medium");
  assert.equal(result.bypass, false);
  assert.equal(result.next_action, "qa_needed");
  assert.ok(hasSignal(result, "granularity", READINESS_CONDITIONS.MULTI_VERB_OPENER));
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.SINGLE_LEAF));
  assertSignalShape(result);
});

test("high_risk_in_codeblock strips fenced blocks before high-risk scanning", () => {
  const body = `Fix cleanup output in \`tools/cleanup.js\`.

\`\`\`sql
DROP TABLE users;
-- auth migration example from docs
\`\`\`

## Done Criteria

- \`tools/cleanup.js\` prints \`cleanup complete\`.
- \`tests/tools/cleanup.test.js\` passes.
`;

  const result = scoreReadiness(body);

  assert.equal(result.bypass, true);
  assert.equal(result.next_action, "proceed");
  assert.equal(result.readiness.verifiability, "high");
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.HIGH_RISK_KEYWORD));
  assert.match(signalEvidence(result, "bypass", READINESS_CONDITIONS.HIGH_RISK_KEYWORD), /^pass:/);
  assert.doesNotMatch(signalEvidence(result, "bypass", READINESS_CONDITIONS.HIGH_RISK_KEYWORD), /drop|auth|migration/i);
  assertSignalShape(result);
});

test("vague_heading_long_body requires observable assertions inside the AC section", () => {
  const body = `Polish the operator experience for the request review flow.

This request gives a deliberately long explanation so body length alone cannot make the
request look precise. The intent is to make the flow more helpful, smoother, clearer,
friendlier, and generally better for future readers without naming a concrete file,
function, test path, log line, or numeric threshold.

## Acceptance Criteria

- The result feels good to use.
- The language is nicer for reviewers.
- The overall flow is smoother.

## Notes

Keep the existing architecture intact.
`;

  const result = scoreReadiness(body);

  assert.equal(result.bypass, false);
  assert.equal(result.readiness.verifiability, "low");
  assert.equal(result.next_action, "qa_needed");
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.OBSERVABLE_ASSERTION));
  assert.ok(hasSignal(result, "verifiability", READINESS_CONDITIONS.MISSING_OBSERVABLE_DONE_CRITERIA));
  assertSignalShape(result);
});

test("all-high scores proceed even without bypass", () => {
  const body = "Update `src/relay-ready/parser.js` so `parseRequestTitle()` returns trimmed titles for blank-padded input while preserving existing null-safe behavior; keep the parser deterministic without I/O; verify `tests/relay-ready/parser.test.js` passes with p95 < 50ms.";

  const result = scoreReadiness(body);

  assert.deepEqual(result.readiness, {
    clarity: "high",
    granularity: "high",
    verifiability: "high",
  });
  assert.equal(result.bypass, false);
  assert.equal(result.next_action, "proceed");
  assertSignalShape(result);
});

test("bypass rejects opener with top-level and before non-verb target", () => {
  const body = `Update parser and docs in \`src/parser/index.js\`.

## Done Criteria

- \`src/parser/index.js\` keeps parse output stable.
- \`tests/parser/index.test.js\` passes.
`;

  const result = scoreReadiness(body);

  assert.equal(result.bypass, false);
  assert.equal(result.readiness.granularity, "low");
  assert.ok(hasSignal(result, "granularity", READINESS_CONDITIONS.TOP_LEVEL_AND));
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.SINGLE_LEAF));
  assert.match(signalEvidence(result, "bypass", READINESS_CONDITIONS.SINGLE_LEAF), /^fail:/);
  assertSignalShape(result);
});

test("bypass_true requires all four bypass checks to pass", () => {
  const body = `Fix \`skills/relay-ready/scripts/relay-request.js\` request ID normalization.

## Done Criteria

- \`skills/relay-ready/scripts/relay-request.js\` keeps \`createRequestId()\` deterministic.
- \`tests/relay-ready/scripts/request-store.test.js\` passes.
- p95 < 50ms for 100 runs.
`;

  const result = scoreReadiness(body);

  assert.equal(result.bypass, true);
  assert.equal(result.next_action, "proceed");
  for (const condition of [
    READINESS_CONDITIONS.DONE_CRITERIA_HEADING,
    READINESS_CONDITIONS.OBSERVABLE_ASSERTION,
    READINESS_CONDITIONS.HIGH_RISK_KEYWORD,
    READINESS_CONDITIONS.SINGLE_LEAF,
  ]) {
    assert.ok(hasSignal(result, "bypass", condition), `missing bypass signal: ${condition}`);
    assert.match(signalEvidence(result, "bypass", condition), /^pass:/);
  }
  assertSignalShape(result);
});

test("minimal input marks clarity low and asks for QA", () => {
  const result = scoreReadiness("Polish the thing.");

  assert.equal(result.readiness.clarity, "low");
  assert.equal(result.bypass, false);
  assert.equal(result.next_action, "qa_needed");
  assert.ok(hasSignal(result, "clarity", READINESS_CONDITIONS.VAGUE_VERB));
  assert.ok(hasSignal(result, "clarity", READINESS_CONDITIONS.SHORT_BODY));
  assertSignalShape(result);
});

test("short input with a file target still marks clarity low", () => {
  const result = scoreReadiness("Fix `src/a.js`.");

  assert.equal(result.readiness.clarity, "low");
  assert.ok(hasSignal(result, "clarity", READINESS_CONDITIONS.SHORT_BODY));
  assert.ok(hasSignal(result, "clarity", READINESS_CONDITIONS.EXPLICIT_TARGET));
  assertSignalShape(result);
});

test("missing target alone marks clarity low", () => {
  const body = `Implement deterministic scoring so reviewer-visible output stays stable across repeated runs.

The request names an observable p95 < 50ms threshold and enough details to avoid the short-body rule, but it intentionally omits a file path or function target so the clarity scorer must not promote it.`;

  const result = scoreReadiness(body);

  assert.equal(result.readiness.clarity, "low");
  assert.ok(hasSignal(result, "clarity", READINESS_CONDITIONS.MISSING_TARGET));
  assertSignalShape(result);
});

test("high-risk low-score input escalates", () => {
  const result = scoreReadiness({
    title: "Delete the production auth schema",
    body: "Delete the production auth schema and clean up related secrets.",
  });

  assert.equal(result.next_action, "escalate");
  assert.equal(result.bypass, false);
  assert.ok(Object.values(result.readiness).includes("low"));
  assert.ok(hasSignal(result, "bypass", READINESS_CONDITIONS.HIGH_RISK_KEYWORD));
  assert.match(signalEvidence(result, "bypass", READINESS_CONDITIONS.HIGH_RISK_KEYWORD), /^fail:/);
  assertSignalShape(result);
});

test("score-readiness source does not reference child process APIs", () => {
  const source = fs.readFileSync(SOURCE, "utf-8");
  const forbiddenSubprocessTokens = [
    /child_process/,
    /child-process/,
    /node:child_process/,
    /\bexecFileSync\b/,
    /\bexecSync\b/,
    /\bspawn\b/,
    /\bspawnSync\b/,
    /\bexec\b/,
    /\bfork\b/,
  ];

  for (const token of forbiddenSubprocessTokens) {
    assert.doesNotMatch(source, token);
  }
});

test("scores deterministic 5KB bodies with p95 latency under 50ms", () => {
  const base = `Update \`skills/relay-ready/scripts/score-readiness.js\` scoring.

## Done Criteria

- \`skills/relay-ready/scripts/score-readiness.js\` returns deterministic readiness scores.
- \`tests/relay-ready/scripts/score-readiness.test.js\` passes.
- p95 < 50ms over 100 runs.

`;
  const filler = "The scorer only inspects text and keeps evidence slices bounded for audit. ";
  const body = (base + filler.repeat(100)).slice(0, 5 * 1024);
  assert.equal(Buffer.byteLength(body, "utf-8"), 5 * 1024);

  const durations = [];
  for (let index = 0; index < 150; index += 1) {
    const start = process.hrtime.bigint();
    scoreReadiness(body);
    const end = process.hrtime.bigint();
    durations.push(Number(end - start) / 1_000_000);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];

  assert.ok(p95 < 50, `p95=${p95}ms`);
});
