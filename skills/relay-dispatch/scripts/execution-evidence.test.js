const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  EXECUTION_EVIDENCE_FILENAME,
  buildExecutionEvidence,
  hashFileSha256,
  rebrandEvidence,
  writeExecutionEvidence,
} = require("./execution-evidence");

test("dispatch execution evidence records all fields and uses an atomic rename in the run dir", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-"));
  const resultFile = path.join(runDir, "result.txt");
  fs.writeFileSync(resultFile, "ok\n", "utf-8");
  const evidence = buildExecutionEvidence({
    headSha: "a".repeat(40),
    testCommand: "node --test skills/relay-review/scripts/*.test.js",
    resultFilePath: resultFile,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
  });

  let renameCall = null;
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (sourcePath, destPath) => {
      renameCall = { sourcePath, destPath };
      assert.equal(path.dirname(sourcePath), runDir);
      assert.equal(destPath, path.join(runDir, EXECUTION_EVIDENCE_FILENAME));
      assert.equal(fs.existsSync(destPath), false);
      return originalRenameSync(sourcePath, destPath);
    };

    const finalPath = writeExecutionEvidence(runDir, evidence);
    const written = JSON.parse(fs.readFileSync(finalPath, "utf-8"));

    assert.ok(renameCall);
    assert.equal(written.schema_version, 1);
    assert.equal(written.head_sha, "a".repeat(40));
    assert.equal(written.test_command, "node --test skills/relay-review/scripts/*.test.js");
    assert.equal(written.test_result_hash, hashFileSha256(resultFile));
    assert.equal(written.test_result_summary, "codex result.txt hashed");
    assert.equal(written.recorded_by, "dispatch-orchestrator-v1");
  } finally {
    fs.renameSync = originalRenameSync;
  }
});

test("dispatch execution evidence preserves the caller test-command verbatim", () => {
  const result = buildExecutionEvidence({
    headSha: "b".repeat(40),
    testCommand: "npm run test -- --grep='relay review'",
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
  });

  assert.equal(result.test_command, "npm run test -- --grep='relay review'");
  assert.equal(result.test_result_hash, "unspecified");
  assert.equal(result.test_result_summary, "unspecified");
});

test("dispatch execution evidence distinguishes an absent test-command from an explicit empty string", () => {
  const omitted = buildExecutionEvidence({
    headSha: "c".repeat(40),
    testCommand: undefined,
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
  });
  const explicitEmpty = buildExecutionEvidence({
    headSha: "d".repeat(40),
    testCommand: "",
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
  });

  assert.equal(omitted.test_command, "unspecified");
  assert.equal(explicitEmpty.test_command, "");
});

test("dispatch execution evidence is not corrupted by a second tmp file in the run dir", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-concurrent-"));
  const staleTmpPath = path.join(runDir, `${EXECUTION_EVIDENCE_FILENAME}.stale.tmp`);
  fs.writeFileSync(staleTmpPath, "garbage\n", "utf-8");

  const finalPath = writeExecutionEvidence(runDir, buildExecutionEvidence({
    headSha: "e".repeat(40),
    testCommand: "unspecified",
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
  }));

  const written = JSON.parse(fs.readFileSync(finalPath, "utf-8"));
  assert.equal(written.head_sha, "e".repeat(40));
  assert.equal(fs.readFileSync(staleTmpPath, "utf-8"), "garbage\n");
});

test("rebrandEvidence rewrites existing evidence to the new head and preserves audit trail", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-rebrand-"));
  const evidencePath = writeExecutionEvidence(runDir, {
    schema_version: 1,
    head_sha: "a".repeat(40),
    test_command: "node --test",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  });

  const result = rebrandEvidence(runDir, {
    newHeadSha: "b".repeat(40),
    recordedBy: "recover-commit-rebrand",
    reason: "recover-commit added new commit",
  });
  const written = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));

  assert.deepEqual(result, {
    rewritten: true,
    previousSha: "a".repeat(40),
    newHeadSha: "b".repeat(40),
  });
  assert.equal(written.head_sha, "b".repeat(40));
  assert.equal(written.recorded_by, "recover-commit-rebrand");
  assert.equal(written.rebrand.previous_head_sha, "a".repeat(40));
  assert.equal(written.rebrand.previous_recorded_by, "dispatch-orchestrator-v1");
  assert.equal(written.rebrand.reason, "recover-commit added new commit");
  assert.match(written.rebrand.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("rebrandEvidence skips when execution evidence is absent", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-no-evidence-"));

  assert.deepEqual(rebrandEvidence(runDir, { newHeadSha: "b".repeat(40) }), {
    skipped: "no_existing_evidence",
  });
  assert.equal(fs.existsSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME)), false);
});

test("rebrandEvidence skips unchanged SHA without rewriting", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-unchanged-"));
  const evidencePath = writeExecutionEvidence(runDir, {
    schema_version: 1,
    head_sha: "c".repeat(40),
    test_command: "node --test",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  });
  const before = fs.readFileSync(evidencePath, "utf-8");

  assert.deepEqual(rebrandEvidence(runDir, { newHeadSha: "c".repeat(40) }), {
    skipped: "sha_unchanged",
  });
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), before);
});
