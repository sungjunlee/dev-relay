const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  EXECUTION_EVIDENCE_FILENAME,
  applyQualityExecutionStatus,
  buildMissingExecutionEvidenceVerdict,
  computeQualityExecutionStatus,
  parseExecutionEvidenceArtifact,
  readExecutionEvidenceArtifact,
} = require("./review-runner/execution-evidence");

function makeArtifact(headSha, overrides = {}) {
  return {
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test skills/relay-review/scripts/*.test.js",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
    ...overrides,
  };
}

function writeArtifact(runDir, artifact) {
  const artifactPath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return artifactPath;
}

test("execution-evidence parses a strict schema_version=1 artifact", () => {
  const parsed = parseExecutionEvidenceArtifact(JSON.stringify(makeArtifact("a".repeat(40))));
  assert.equal(parsed.head_sha, "a".repeat(40));
  assert.equal(parsed.schema_version, 1);
});

test("execution-evidence accepts an explicitly empty test_command for verbatim capture", () => {
  const parsed = parseExecutionEvidenceArtifact(JSON.stringify(makeArtifact("a".repeat(40), {
    test_command: "",
  })));
  assert.equal(parsed.test_command, "");
});

test("execution-evidence returns pass when artifact head matches reviewed head", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-pass-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40)));

  assert.deepEqual(
    computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) }),
    { status: "pass", reason: null }
  );
});

test("execution-evidence returns fail with stale reason when artifact head mismatches reviewed head", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-stale-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40)));

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "b".repeat(40) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /stale artifact: recorded at a{40}, reviewed at b{40}/);
});

test("execution-evidence returns missing when artifact file is absent", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-missing-"));

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(result.status, "missing");
  assert.match(result.reason, /pre-261 run, no artifact/);
});

test("execution-evidence rejects replay attack artifact from another head as stale", () => {
  const currentRunDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-replay-"));
  writeArtifact(currentRunDir, makeArtifact("c".repeat(40), {
    test_result_hash: "d".repeat(64),
    test_result_summary: "codex result.txt hashed",
  }));

  const result = computeQualityExecutionStatus({ runDir: currentRunDir, reviewedHead: "e".repeat(40) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /stale artifact/);
});

test("execution-evidence strict policy fails when required fields are missing", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-invalid-"));
  writeArtifact(runDir, {
    head_sha: "a".repeat(40),
    test_command: "unspecified",
  });

  const loaded = readExecutionEvidenceArtifact(runDir);
  assert.equal(loaded.state, "invalid");
  assert.match(loaded.error, /missing required field 'schema_version'/);

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /missing required field 'schema_version'/);
});

test("execution-evidence schema evolution fails closed with a clear schema_version error", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-schema-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    schema_version: 2,
  }));

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /unsupported execution evidence schema_version=2/);
});

test("execution-evidence override drops a reviewer-forged execution status in favor of the runner value", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-override-"));
  const computed = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  const verdict = applyQualityExecutionStatus({
    verdict: "pass",
    quality_execution_status: "pass",
  }, computed);

  assert.equal(verdict.quality_execution_status, "missing");
  assert.match(verdict.quality_execution_reason, /pre-261 run, no artifact/);
});

test("execution-evidence builds a fail-closed changes_requested verdict for missing artifacts", () => {
  const verdict = buildMissingExecutionEvidenceVerdict({
    verdict: "pass",
    summary: "Inspection passed.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "missing",
    quality_execution_reason: 'execution-evidence.json missing; if this is a pre-261 run, use finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"',
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.equal(verdict.verdict, "changes_requested");
  assert.equal(verdict.next_action, "changes_requested");
  assert.match(verdict.summary, /fail-closed reviewer PASS/);
  assert.equal(verdict.issues[0].file, EXECUTION_EVIDENCE_FILENAME);
  assert.match(verdict.issues[0].body, /pre-261 run, no artifact/);
});
