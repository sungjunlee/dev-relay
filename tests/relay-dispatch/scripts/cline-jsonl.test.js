const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractClineAdvisoryCandidates,
  extractClineRunResultText,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters/cline-jsonl");
const { parseAdvisoryReview } = require("../../../skills/relay-review/scripts/advisory-review-schema");

test("cline advisory extraction reports empty stdout with stderr tail", () => {
  assert.throws(
    () => extractClineAdvisoryCandidates("", {
      adapter: "cline",
      phase: "advisory_review",
      stderr: `${"x".repeat(510)} session not found`,
    }),
    (error) => {
      assert.match(error.message, /adapter=cline phase=advisory_review/);
      assert.match(error.message, /Cline JSONL output is empty/);
      assert.match(error.message, /stderr tail:/);
      assert.match(error.message, /session not found/);
      assert.ok(!error.message.includes("x".repeat(510)));
      return true;
    }
  );
});

test("cline advisory extraction names invalid JSONL line number", () => {
  assert.throws(
    () => extractClineAdvisoryCandidates("not-json\n", {
      adapter: "cline",
      phase: "advisory_review",
    }),
    /Cline JSONL line 1 must be valid JSON/
  );
});

test("cline advisory extraction falls back to text content_end when run_result is missing", () => {
  const payload = JSON.stringify({
    profile: "blindspot",
    summary: "Schema-valid content_end fallback with empty finding arrays.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  });
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: payload } }),
  ].join("\n");

  const candidates = extractClineAdvisoryCandidates(stdout, {
    adapter: "cline",
    phase: "advisory_review",
    stderr: "session not found",
  });
  assert.deepEqual(candidates, [payload]);

  const parsed = parseAdvisoryReview(candidates[0], {
    adapter: "cline",
    phase: "advisory_review",
    profile: "blindspot",
  });
  assert.equal(parsed.summary, "Schema-valid content_end fallback with empty finding arrays.");
  assert.equal(parsed.required_findings.length, 0);
  assert.equal(parsed.advisory_findings.length, 0);
  assert.equal(parsed.duplicate_or_low_confidence.length, 0);
});

test("cline advisory extraction falls back to plain advisory JSON stdout when run_result is missing", () => {
  const advisoryJson = JSON.stringify({
    schema_version: 1,
    profile: "blindspot",
    summary: "Survival issue-172 R5 shape: whole stdout is plain advisory JSON.",
    required_findings: [
      {
        title: "Real finding",
        body: "Present in plain JSON stdout without a run_result envelope.",
        file: "skills/relay-dispatch/scripts/agent-adapters/cline-jsonl.js",
        severity: "P2",
        category: "edge-case",
        confidence: 0.9,
      },
    ],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  });

  const candidates = extractClineAdvisoryCandidates(advisoryJson, {
    adapter: "cline",
    phase: "advisory_review",
  });
  assert.deepEqual(candidates, [advisoryJson]);

  const parsed = parseAdvisoryReview(candidates[0], {
    adapter: "cline",
    phase: "advisory_review",
    profile: "blindspot",
  });
  assert.equal(parsed.required_findings.length, 1);
  assert.deepEqual(parsed.required_findings[0], {
    title: "Real finding",
    body: "Present in plain JSON stdout without a run_result envelope.",
    file: "skills/relay-dispatch/scripts/agent-adapters/cline-jsonl.js",
    line: null,
    severity: "P2",
    category: "edge-case",
    confidence: 0.9,
  });
});

test("cline advisory extraction reports missing run_result with stderr tail when no fallback exists", () => {
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "reasoning", text: "thinking only" } }),
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "tool", text: "tool only" } }),
  ].join("\n");

  assert.throws(
    () => extractClineAdvisoryCandidates(stdout, {
      adapter: "cline",
      phase: "advisory_review",
      stderr: "session not found",
    }),
    /no run_result events found.*stderr tail: session not found/
  );
});

test("cline advisory extraction fails on non-completed finishReason without parsing candidates", () => {
  const stdout = JSON.stringify({
    type: "run_result",
    finishReason: "error",
    durationMs: 313,
    text: `invalid model format. Expected format: modelType/model ${"a".repeat(400)}`,
    model: { id: "glm-5.2", provider: "cline-pass" },
  });

  assert.throws(
    () => extractClineAdvisoryCandidates(stdout, {
      adapter: "cline",
      phase: "advisory_review",
    }),
    (error) => {
      assert.match(error.message, /finishReason "error"/);
      assert.match(error.message, /invalid model format\. Expected format: modelType\/model/);
      assert.ok(error.message.length < 520, "run_result.text preview should be bounded");
      return true;
    }
  );
});

test("cline advisory extraction does not fall back past explicit non-completed finishReason", () => {
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "{\"ok\":true}" } }),
    JSON.stringify({
      type: "run_result",
      finishReason: "error",
      text: "explicit failure",
    }),
  ].join("\n");

  assert.throws(
    () => extractClineAdvisoryCandidates(stdout, {
      adapter: "cline",
      phase: "advisory_review",
    }),
    /finishReason "error"/
  );
});

test("cline advisory extraction returns run_result.text then last text content_end", () => {
  const yoloJson = JSON.stringify({
    schema_version: 1,
    profile: "blindspot",
    summary: "From content_end.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  });
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "older text" } }),
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "reasoning", text: "skip me" } }),
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "tool", text: "skip me too" } }),
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: yoloJson } }),
    JSON.stringify({
      type: "run_result",
      finishReason: "completed",
      text: "Submission recorded (verified): Output the requested JSON object verbatim ...",
    }),
  ].join("\n");

  assert.deepEqual(
    extractClineAdvisoryCandidates(stdout, {
      adapter: "cline",
      phase: "advisory_review",
    }),
    [
      "Submission recorded (verified): Output the requested JSON object verbatim ...",
      yoloJson,
    ]
  );
});

test("cline dispatch run_result extraction behavior remains unchanged", () => {
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "{\"ok\":false}" } }),
    JSON.stringify({
      type: "run_result",
      finishReason: "error",
      text: "{\"ok\": true}",
    }),
  ].join("\n");

  assert.equal(extractClineRunResultText(stdout, { adapter: "cline", phase: "dispatch" }), "{\"ok\": true}");
});
