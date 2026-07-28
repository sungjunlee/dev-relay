const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  EXECUTION_EVIDENCE_FILENAME,
  applyQualityExecutionStatus,
  buildExecutionEvidenceFailureVerdict,
  buildMissingExecutionEvidenceVerdict,
  buildExecutionEvidencePreflight,
  computeQualityExecutionStatus,
  parseExecutionEvidenceArtifact,
  readExecutionEvidenceArtifact,
} = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

function makeArtifact(headSha, overrides = {}) {
  return {
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test tests/relay-review/scripts/*.test.js",
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

test("execution-evidence strict mode requires command and result hash", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-strict-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "unspecified",
    test_result_hash: "unspecified",
  }));

  const result = computeQualityExecutionStatus({
    runDir,
    reviewedHead: "a".repeat(40),
    strict: true,
  });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /non-empty test_command/);

  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "node --test",
    test_result_hash: "unspecified",
  }));
  const missingHash = computeQualityExecutionStatus({
    runDir,
    reviewedHead: "a".repeat(40),
    strict: true,
  });
  assert.equal(missingHash.status, "fail");
  assert.match(missingHash.reason, /sha256 test_result_hash/);
});

test("execution-evidence strict mode fails nonzero test_exit_code and accepts zero", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-exit-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "node --test",
    test_result_hash: "b".repeat(64),
  }));

  const missing = computeQualityExecutionStatus({
    runDir,
    reviewedHead: "a".repeat(40),
    strict: true,
  });
  assert.equal(missing.status, "fail");
  assert.match(missing.reason, /requires test_exit_code=0/);

  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "node --test",
    test_result_hash: "b".repeat(64),
    test_exit_code: 1,
  }));

  const failed = computeQualityExecutionStatus({
    runDir,
    reviewedHead: "a".repeat(40),
    strict: true,
  });
  assert.equal(failed.status, "fail");
  assert.match(failed.reason, /nonzero test_exit_code=1/);

  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "node --test",
    test_result_hash: "b".repeat(64),
    test_exit_code: 0,
  }));
  assert.deepEqual(
    computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true }),
    { status: "pass", reason: null }
  );
});

test("execution-evidence strict mode prefers verification_runs when present", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-runs-pass-"));
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "evaluation:",
    "  verification:",
    "    checks:",
    "      - name: required gate",
    "        type: command",
    "        command: node --test required.test.js",
  ].join("\n"), "utf-8");
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "unspecified",
    test_result_hash: "unspecified",
    verification_runs: [{
      command: "node --test",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      output_hash: "b".repeat(64),
      recorded_by: "orchestrator",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
  }));

  const unrecorded = computeQualityExecutionStatus({
    runDir,
    reviewedHead: "a".repeat(40),
    strict: true,
  });
  assert.equal(unrecorded.status, "fail");
  assert.match(unrecorded.reason, /verification gate went unrecorded: 'required gate'/);

  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "unspecified",
    test_result_hash: "unspecified",
    verification_runs: [{
      command: "node --test required.test.js",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      output_hash: "b".repeat(64),
      recorded_by: "orchestrator",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
  }));
  assert.deepEqual(
    computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true }),
    { status: "pass", reason: null }
  );
});

test("execution-evidence strict verification_runs fail on nonzero exit and stale head", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-runs-fail-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    verification_runs: [{
      command: "node --test",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 1,
      output_hash: "b".repeat(64),
      recorded_by: "orchestrator",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
  }));

  const failed = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true });
  assert.equal(failed.status, "fail");
  assert.match(failed.reason, /nonzero exit_code=1/);

  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    verification_runs: [{
      command: "node --test",
      cwd: "/repo",
      head_sha: "c".repeat(40),
      exit_code: 0,
      output_hash: "b".repeat(64),
      recorded_by: "orchestrator",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
  }));

  const stale = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true });
  assert.equal(stale.status, "fail");
  assert.match(stale.reason, /verification_runs evidence is stale/);
});

test("execution-evidence verification_runs require hashed output evidence", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-runs-hash-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    verification_runs: [{
      command: "node --test",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      recorded_by: "orchestrator",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
  }));

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /requires at least one of output_hash, stdout_hash, stderr_hash/);
});

test("execution-evidence strict mode preserves legacy fallback when verification_runs is absent", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-runs-legacy-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    test_command: "node --test",
    test_result_hash: "b".repeat(64),
    test_exit_code: 0,
  }));

  assert.deepEqual(
    computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40), strict: true }),
    { status: "pass", reason: null }
  );
});

test("execution-evidence rejects symlink artifacts", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-symlink-"));
  const outside = path.join(os.tmpdir(), `relay-review-execution-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify(makeArtifact("a".repeat(40))), "utf-8");
  fs.symlinkSync(outside, path.join(runDir, EXECUTION_EVIDENCE_FILENAME));

  const loaded = readExecutionEvidenceArtifact(runDir);
  assert.equal(loaded.state, "invalid");
  assert.match(loaded.error, /regular file/);
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

test("execution-evidence preflight reports actionable head-bound status", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-execution-preflight-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40)));

  assert.deepEqual(
    buildExecutionEvidencePreflight({ runDir, reviewedHead: "a".repeat(40) }),
    {
      status: "pass",
      qualityExecutionStatus: "pass",
      reason: null,
      reviewedHeadSha: "a".repeat(40),
      evidenceHeadSha: "a".repeat(40),
      artifactPath: path.join(runDir, EXECUTION_EVIDENCE_FILENAME),
      browserEvidence: { present: false },
      nextAction: "invoke_primary_reviewer",
    }
  );

  const stale = buildExecutionEvidencePreflight({ runDir, reviewedHead: "b".repeat(40) });
  assert.equal(stale.status, "blocked");
  assert.equal(stale.qualityExecutionStatus, "fail");
  assert.match(stale.reason, /stale artifact/);
  assert.equal(stale.reviewedHeadSha, "b".repeat(40));
  assert.equal(stale.evidenceHeadSha, "a".repeat(40));
  assert.deepEqual(stale.browserEvidence, { present: false });
  assert.equal(stale.nextAction, "repair_execution_evidence");
});

test("execution-evidence accepts optional browser evidence inside the run directory", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-browser-evidence-"));
  const screenshotPath = path.join(runDir, "browser", "home-1440.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png bytes\n", "utf-8");
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      command: "pnpm exec playwright test tests/demo-flow.spec.ts --project=chromium",
      viewports: ["1440x900", "390x844"],
      screenshots: ["browser/home-1440.png"],
      console_errors: 0,
      inspected_states: ["baseline result visible", "evidence panel expanded"],
    },
  }));

  const preflight = buildExecutionEvidencePreflight({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(preflight.status, "pass");
  assert.deepEqual(preflight.browserEvidence, {
    present: true,
    command: "pnpm exec playwright test tests/demo-flow.spec.ts --project=chromium",
    viewportCount: 2,
    screenshotCount: 1,
    consoleErrors: 0,
    inspectedStateCount: 2,
  });
});

test("execution-evidence allows hashed browser evidence outside the run directory", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-browser-evidence-hashed-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      screenshots: [{
        path: path.join(os.tmpdir(), "relay-browser-outside.png"),
        sha256: "b".repeat(64),
      }],
    },
  }));

  const preflight = buildExecutionEvidencePreflight({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(preflight.status, "pass");
  assert.equal(preflight.browserEvidence.present, true);
  assert.equal(preflight.browserEvidence.screenshotCount, 1);
});

test("execution-evidence rejects un-hashed browser paths outside the run directory", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-browser-evidence-outside-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      screenshots: [path.join(os.tmpdir(), "relay-browser-outside.png")],
    },
  }));

  const result = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /browser_evidence screenshots\[0\] path must stay inside the run directory or include sha256/);
});

test("execution-evidence rejects missing or non-file in-run browser screenshot paths", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-browser-evidence-missing-"));
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      screenshots: ["browser/missing.png"],
    },
  }));

  const missing = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(missing.status, "fail");
  assert.match(missing.reason, /browser_evidence screenshots\[0\] path must resolve to an existing regular file/);

  const screenshotDir = path.join(runDir, "browser", "directory.png");
  fs.mkdirSync(screenshotDir, { recursive: true });
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      screenshots: ["browser/directory.png"],
    },
  }));

  const directory = computeQualityExecutionStatus({ runDir, reviewedHead: "a".repeat(40) });
  assert.equal(directory.status, "fail");
  assert.match(directory.reason, /browser_evidence screenshots\[0\] path must resolve to an existing regular file/);
});

test("execution-evidence reports browser evidence presence even when artifact head is stale", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-browser-evidence-stale-"));
  const screenshotPath = path.join(runDir, "browser", "home-1440.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, "png bytes\n", "utf-8");
  writeArtifact(runDir, makeArtifact("a".repeat(40), {
    browser_evidence: {
      screenshots: ["browser/home-1440.png"],
    },
  }));

  const preflight = buildExecutionEvidencePreflight({ runDir, reviewedHead: "b".repeat(40) });
  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.qualityExecutionStatus, "fail");
  assert.match(preflight.reason, /stale artifact/);
  assert.equal(preflight.browserEvidence.present, true);
  assert.equal(preflight.browserEvidence.screenshotCount, 1);
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

test("execution-evidence builds a fail-closed changes_requested verdict for stale or invalid artifacts", () => {
  const verdict = buildExecutionEvidenceFailureVerdict({
    verdict: "pass",
    summary: "Inspection passed.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "fail",
    quality_execution_reason: "stale artifact: recorded at aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, reviewed at bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.equal(verdict.verdict, "changes_requested");
  assert.equal(verdict.next_action, "changes_requested");
  assert.match(verdict.summary, /quality_execution_status=fail/);
  assert.equal(verdict.issues[0].file, EXECUTION_EVIDENCE_FILENAME);
  assert.match(verdict.issues[0].body, /stale artifact/);
});
