const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  EXECUTION_EVIDENCE_FILENAME,
  VERIFICATION_OUTPUT_FILENAME,
  buildExecutionEvidence,
  extractVerificationGates,
  hashFileSha256,
  rebrandEvidence,
  resolveExecutionEvidenceTestCommand,
  runVerificationGates,
  writeExecutionEvidence,
} = require("../../../skills/relay-dispatch/scripts/execution-evidence");

test("verification gates seed the evidence command and identify malformed command gates", () => {
  const rubric = [
    "evaluation:",
    "  schema_version: 2",
    "  outcome_contract:",
    "    source: done_criteria",
    "  verification:",
    "    checks:",
    "      - name: dispatch suite",
    "        type: command",
    "        command: \"node --test tests/relay-dispatch/scripts/*.test.js\"",
    "      - name: review suite",
    "        type: command",
    "        command: 'node --test tests/relay-review/scripts/*.test.js'",
    "  earned_rubric:",
    "    factors: []",
  ].join("\n");

  assert.deepEqual(extractVerificationGates(rubric), [{
    name: "dispatch suite",
    type: "command",
    command: "node --test tests/relay-dispatch/scripts/*.test.js",
  }, {
    name: "review suite",
    type: "command",
    command: "node --test tests/relay-review/scripts/*.test.js",
  }]);
  assert.equal(
    resolveExecutionEvidenceTestCommand({ rubricYaml: rubric }),
    "node --test tests/relay-dispatch/scripts/*.test.js && node --test tests/relay-review/scripts/*.test.js"
  );
  assert.equal(
    resolveExecutionEvidenceTestCommand({ explicitTestCommand: "node --test focused.test.js", rubricYaml: rubric }),
    "node --test focused.test.js"
  );

  assert.throws(
    () => resolveExecutionEvidenceTestCommand({
      rubricYaml: rubric.replace(
        "command: 'node --test tests/relay-review/scripts/*.test.js'",
        "target: exit code 0"
      ),
    }),
    /verification gate 'review suite' did not record a command/
  );
});

test("dispatch execution evidence records all fields and uses an atomic rename in the run dir", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-"));
  const resultFile = path.join(runDir, "result.txt");
  fs.writeFileSync(resultFile, "ok\n", "utf-8");
  const evidence = buildExecutionEvidence({
    headSha: "a".repeat(40),
    testCommand: "node --test tests/relay-review/scripts/*.test.js",
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
    assert.equal(written.test_command, "node --test tests/relay-review/scripts/*.test.js");
    assert.equal(written.test_result_hash, hashFileSha256(resultFile));
    assert.equal(written.test_result_summary, "codex result.txt hashed");
    assert.equal(written.recorded_by, "dispatch-orchestrator-v1");
  } finally {
    fs.renameSync = originalRenameSync;
  }
});

test("verification gates execute in the worktree and persist SHA-bound output evidence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-cwd-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-run-"));
  const headSha = "b".repeat(40);
  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('gate executed\\\\n')"`;

  const result = runVerificationGates({
    gates: [{ name: "focused gate", type: "command", command }],
    cwd,
    headSha,
    runDir,
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].name, "focused gate");
  assert.equal(result.runs[0].command, command);
  assert.equal(result.runs[0].cwd, cwd);
  assert.equal(result.runs[0].head_sha, headSha);
  assert.equal(result.runs[0].exit_code, 0);
  assert.equal(result.runs[0].recorded_by, "dispatch-verification-gate-v1");
  assert.equal(
    result.runs[0].output_hash,
    hashFileSha256(path.join(runDir, result.runs[0].output_path))
  );
  assert.equal(path.basename(result.outputPath), VERIFICATION_OUTPUT_FILENAME);
  assert.match(fs.readFileSync(result.outputPath, "utf-8"), /gate executed/);
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

test("dispatch execution evidence can include verification_runs without rewriting them", () => {
  const verificationRuns = [{
    command: "node --test tests/relay-dispatch/scripts/execution-evidence.test.js",
    cwd: "/repo",
    head_sha: "b".repeat(40),
    exit_code: 0,
    output_hash: "c".repeat(64),
    recorded_by: "operator",
    recorded_at: "2026-04-22T00:01:00.000Z",
  }];

  const result = buildExecutionEvidence({
    headSha: "b".repeat(40),
    testCommand: "node --test",
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
    testExitCode: 0,
    verificationRuns,
  });

  assert.deepEqual(result.verification_runs, verificationRuns);
});

test("dispatch execution evidence can include browser_evidence without rewriting it", () => {
  const browserEvidence = {
    command: "pnpm exec playwright test tests/demo-flow.spec.ts --project=chromium",
    viewports: ["1440x900"],
    screenshots: ["browser/home-1440.png"],
    console_errors: 0,
    inspected_states: ["baseline visible"],
  };

  const result = buildExecutionEvidence({
    headSha: "b".repeat(40),
    testCommand: "node --test",
    resultFilePath: null,
    executor: "codex",
    recordedAt: "2026-04-22T00:00:00.000Z",
    testExitCode: 0,
    browserEvidence,
  });

  assert.deepEqual(result.browser_evidence, browserEvidence);
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

  assert.equal(result.rewritten, true);
  assert.equal(result.previousSha, "a".repeat(40));
  assert.equal(result.newHeadSha, "b".repeat(40));
  assert.equal(result.evidencePath, evidencePath);
  assert.equal(result.evidenceHash, hashFileSha256(evidencePath));
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

test("rebrandEvidence returns structured rejected outcome for invalid SHA without rewriting", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-bad-sha-"));
  const evidencePath = writeExecutionEvidence(runDir, {
    schema_version: 1,
    head_sha: "d".repeat(40),
    test_command: "node --test",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  });
  const before = fs.readFileSync(evidencePath, "utf-8");

  const result = rebrandEvidence(runDir, { newHeadSha: "not-a-sha" });
  assert.equal(result.skipped, "rejected_bad_sha");
  assert.match(result.reason, /40-character lowercase hex/);
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), before);
});
