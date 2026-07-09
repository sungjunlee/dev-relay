const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractClineAdvisoryCandidates,
  extractClineRunResultText,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters/cline-jsonl");

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

test("cline advisory extraction reports missing run_result with stderr tail", () => {
  const stdout = [
    JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "{\"ok\":true}" } }),
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
