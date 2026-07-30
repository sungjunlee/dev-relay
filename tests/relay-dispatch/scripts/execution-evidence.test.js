const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  EXECUTION_EVIDENCE_FILENAME,
  VERIFICATION_OUTPUT_FILENAME,
  buildExecutionEvidence,
  buildExecutorVerificationInstructions,
  collectExecutorVerificationEvidence,
  extractVerificationGates,
  hashFileSha256,
  rebrandEvidence,
  resolveExecutionEvidenceTestCommand,
  verificationTreeProofGitAddArgs,
  verificationTreeProofStagedRuntimeAdditionsGitDiffArgs,
  verificationTreeProofStagedRuntimeAdditionsGitUpdateIndexArgs,
  verificationTreeProofTrackedGitAddArgs,
  writeExecutionEvidence,
} = require("../../../skills/relay-dispatch/scripts/execution-evidence");
const {
  buildExecutionEvidencePreflight,
} = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

function git(repoPath, ...args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

test("executor verification instructions keep gate execution inside the dispatched policy", () => {
  const instructions = buildExecutorVerificationInstructions([{
    name: "focused gate",
    command: "node --test focused.test.js",
  }]);

  assert.match(instructions, /inside this same executor session/);
  assert.match(instructions, /current sandbox and network policy/);
  assert.match(instructions, /Do not delegate them back to the relay orchestrator/);
  assert.match(instructions, /After all required gates finish/);
  assert.match(instructions, /temporary Git index/);
  assert.match(instructions, /GIT_INDEX_FILE/);
  assert.match(instructions, /git write-tree/);
  assert.match(instructions, /:\(exclude\)\.antigravitycli/);
  assert.match(instructions, /intentionally staged runtime-root additions/);
  assert.match(instructions, /tracked runtime-root modifications and deletions remain reviewable/);
  assert.match(instructions, /gate-time worktree/);
  assert.match(instructions, /update-index/);
  assert.match(instructions, /--remove/);
  assert.match(instructions, /before any later commit or commit hook can mutate the tree/);
  assert.match(instructions, /verification_tree_sha/);
  assert.match(instructions, /"command":"node --test focused\.test\.js"/);
});

test("verification tree proof keeps tracked runtime changes and excludes adjacent metadata", (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-tree-"));
  const verificationIndex = path.join(
    os.tmpdir(),
    `relay-verification-index-${process.pid}-${Date.now()}`
  );
  t.after(() => fs.rmSync(verificationIndex, { force: true }));

  git(repoPath, "init");
  git(repoPath, "config", "user.name", "Relay Test");
  git(repoPath, "config", "user.email", "relay@example.com");
  fs.writeFileSync(path.join(repoPath, "reviewable.txt"), "before\n", "utf-8");
  fs.mkdirSync(path.join(repoPath, ".antigravitycli"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, ".antigravitycli", "tracked-config"),
    "tracked before\n",
    "utf-8"
  );
  fs.writeFileSync(
    path.join(repoPath, ".antigravitycli", "tracked-obsolete"),
    "remove after verification\n",
    "utf-8"
  );
  git(
    repoPath,
    "add",
    "reviewable.txt",
    ".antigravitycli/tracked-config",
    ".antigravitycli/tracked-obsolete"
  );
  git(repoPath, "commit", "-m", "base");

  fs.writeFileSync(path.join(repoPath, "reviewable.txt"), "after\n", "utf-8");
  fs.writeFileSync(
    path.join(repoPath, ".antigravitycli", "tracked-config"),
    "tracked after\n",
    "utf-8"
  );
  fs.unlinkSync(path.join(repoPath, ".antigravitycli", "tracked-obsolete"));
  fs.writeFileSync(
    path.join(repoPath, ".antigravitycli", "runtime-state.json"),
    '{"session":"runtime-only"}\n',
    "utf-8"
  );
  const stagedAdditionPath = path.join(
    repoPath,
    ".antigravitycli",
    "staged-tool"
  );
  fs.writeFileSync(stagedAdditionPath, "staged addition\n", "utf-8");
  fs.chmodSync(stagedAdditionPath, 0o755);
  git(repoPath, "add", ".antigravitycli/staged-tool");
  const stagedDeletedPath = path.join(
    repoPath,
    ".antigravitycli",
    "staged-deleted"
  );
  fs.writeFileSync(stagedDeletedPath, "deleted after staging\n", "utf-8");
  git(repoPath, "add", ".antigravitycli/staged-deleted");
  const intentToAddPath = path.join(
    repoPath,
    ".antigravitycli",
    "intent-to-add"
  );
  fs.writeFileSync(intentToAddPath, "intent-to-add content\n", "utf-8");
  git(repoPath, "add", "-N", ".antigravitycli/intent-to-add");
  fs.writeFileSync(stagedAdditionPath, "later unstaged content\n", "utf-8");
  fs.chmodSync(stagedAdditionPath, 0o644);
  fs.unlinkSync(stagedDeletedPath);

  const proofEnv = {
    ...process.env,
    GIT_INDEX_FILE: verificationIndex,
  };
  execFileSync("git", ["read-tree", "HEAD"], {
    cwd: repoPath,
    env: proofEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", verificationTreeProofGitAddArgs(), {
    cwd: repoPath,
    env: proofEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", verificationTreeProofTrackedGitAddArgs(), {
    cwd: repoPath,
    env: proofEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stagedRuntimePaths = path.join(
    os.tmpdir(),
    `relay-verification-runtime-additions-${process.pid}-${Date.now()}.paths`
  );
  t.after(() => fs.rmSync(stagedRuntimePaths, { force: true }));
  const realIndexPath = git(repoPath, "rev-parse", "--git-path", "index");
  const stagedRuntimePathList = execFileSync(
    "git",
    verificationTreeProofStagedRuntimeAdditionsGitDiffArgs(),
    {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_INDEX_FILE: realIndexPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  fs.writeFileSync(stagedRuntimePaths, stagedRuntimePathList);
  execFileSync(
    "git",
    verificationTreeProofStagedRuntimeAdditionsGitUpdateIndexArgs(),
    {
      cwd: repoPath,
      env: proofEnv,
      input: stagedRuntimePathList,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const verificationTreeSha = execFileSync("git", ["write-tree"], {
    cwd: repoPath,
    env: proofEnv,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const realIndexTreeSha = git(repoPath, "write-tree");

  assert.deepEqual(
    git(repoPath, "ls-tree", "-r", "--name-only", verificationTreeSha).split("\n"),
    [
      ".antigravitycli/intent-to-add",
      ".antigravitycli/staged-tool",
      ".antigravitycli/tracked-config",
      "reviewable.txt",
    ]
  );
  assert.equal(
    git(repoPath, "show", `${verificationTreeSha}:.antigravitycli/tracked-config`),
    "tracked after"
  );
  assert.equal(
    git(repoPath, "show", `${verificationTreeSha}:.antigravitycli/staged-tool`),
    "later unstaged content"
  );
  assert.equal(
    git(repoPath, "show", `${verificationTreeSha}:.antigravitycli/intent-to-add`),
    "intent-to-add content"
  );
  assert.match(
    git(repoPath, "ls-tree", verificationTreeSha, ".antigravitycli/staged-tool"),
    /^100644 blob /
  );
  assert.match(
    git(repoPath, "ls-tree", "-r", "--name-only", realIndexTreeSha),
    /\.antigravitycli\/staged-tool/
  );
  assert.match(
    git(repoPath, "ls-tree", "-r", "--name-only", verificationTreeSha),
    /\.antigravitycli\/tracked-config/
  );
  assert.doesNotMatch(
    git(repoPath, "ls-tree", "-r", "--name-only", verificationTreeSha),
    /\.antigravitycli\/(?:runtime-state\.json|staged-deleted|tracked-obsolete)/
  );
  assert.doesNotMatch(
    git(repoPath, "show", `${verificationTreeSha}:.antigravitycli/staged-tool`),
    /staged addition/
  );
  assert.notEqual(verificationTreeSha, realIndexTreeSha);
});

test("executor-confirmed verification results persist SHA-bound output evidence without executing commands", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-cwd-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-run-"));
  const headSha = "b".repeat(40);
  const sentinelPath = path.join(runDir, "must-not-execute");
  const command = `printf leaked > ${JSON.stringify(sentinelPath)}`;
  const resultText = [
    "Verification completed under executor policy.",
    "RELAY_VERIFICATION_RESULT_BEGIN",
    JSON.stringify({
      schema_version: 1,
      verification_tree_sha: "c".repeat(40),
      runs: [{
        command,
        exit_code: 1,
        output: "sandbox policy denied write",
      }],
    }),
    "RELAY_VERIFICATION_RESULT_END",
  ].join("\n");

  const result = collectExecutorVerificationEvidence({
    gates: [{ name: "focused gate", type: "command", command }],
    cwd,
    headSha,
    finalTreeSha: "c".repeat(40),
    runDir,
    resultText,
    executor: "codex",
    recordedAt: "2026-07-28T00:00:00.000Z",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].name, "focused gate");
  assert.equal(result.runs[0].command, command);
  assert.equal(result.runs[0].cwd, cwd);
  assert.equal(result.runs[0].head_sha, headSha);
  assert.equal(result.runs[0].verification_tree_sha, "c".repeat(40));
  assert.equal(result.runs[0].exit_code, 1);
  assert.equal(result.runs[0].recorded_by, "codex-confirmed-verification-v1");
  assert.equal(result.runs[0].recorded_at, "2026-07-28T00:00:00.000Z");
  assert.equal(
    result.runs[0].output_hash,
    hashFileSha256(path.join(runDir, result.runs[0].output_path))
  );
  assert.equal(path.basename(result.outputPath), VERIFICATION_OUTPUT_FILENAME);
  assert.equal(result.verificationTreeSha, "c".repeat(40));
  assert.match(fs.readFileSync(result.outputPath, "utf-8"), /sandbox policy denied write/);
  assert.equal(fs.existsSync(sentinelPath), false);
});

test("executor verification evidence fails closed on missing or mismatched confirmations", () => {
  const options = {
    gates: [{ name: "focused gate", command: "node --test focused.test.js" }],
    cwd: "/repo",
    headSha: "b".repeat(40),
    finalTreeSha: "c".repeat(40),
    runDir: fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-verification-invalid-")),
    executor: "codex",
  };

  assert.throws(
    () => collectExecutorVerificationEvidence({ ...options, resultText: "completed" }),
    /did not return the required verification result envelope/
  );
  assert.throws(
    () => collectExecutorVerificationEvidence({
      ...options,
      resultText: [
        "RELAY_VERIFICATION_RESULT_BEGIN",
        `{"schema_version":1,"verification_tree_sha":"${"c".repeat(40)}","runs":[{"command":"npm test","exit_code":0,"output":"ok"}]}`,
        "RELAY_VERIFICATION_RESULT_END",
      ].join("\n"),
    }),
    /did not match required gate/
  );

  for (const verificationTreeSha of [undefined, "not-a-tree", "a".repeat(39)]) {
    const envelope = {
      schema_version: 1,
      ...(verificationTreeSha === undefined ? {} : { verification_tree_sha: verificationTreeSha }),
      runs: [{
        command: "node --test focused.test.js",
        exit_code: 0,
        output: "ok",
      }],
    };
    assert.throws(
      () => collectExecutorVerificationEvidence({
        ...options,
        resultText: [
          "RELAY_VERIFICATION_RESULT_BEGIN",
          JSON.stringify(envelope),
          "RELAY_VERIFICATION_RESULT_END",
        ].join("\n"),
      }),
      /verification_tree_proof_invalid.*40-character hex Git tree SHA.*re-run the executor verification gates/
    );
  }

  assert.throws(
    () => collectExecutorVerificationEvidence({
      ...options,
      resultText: [
        "RELAY_VERIFICATION_RESULT_BEGIN",
        JSON.stringify({
          schema_version: 1,
          verification_tree_sha: "d".repeat(40),
          runs: [{
            command: "node --test focused.test.js",
            exit_code: 0,
            output: "ok",
          }],
        }),
        "RELAY_VERIFICATION_RESULT_END",
      ].join("\n"),
    }),
    /verification_tree_mismatch.*final HEAD\^\{tree\}.*re-run the executor verification gates/
  );
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

test("rebrandEvidence removes stale verification_runs and strict preflight names the rebrand", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-execution-rebrand-runs-"));
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "evaluation:",
    "  verification:",
    "    checks:",
    "      - name: required after rebrand",
    "        type: command",
    "        command: node --test required.test.js",
  ].join("\n"), "utf-8");
  const evidencePath = writeExecutionEvidence(runDir, {
    schema_version: 1,
    head_sha: "a".repeat(40),
    test_command: "unspecified",
    test_result_hash: "unspecified",
    test_result_summary: "verified before rebrand",
    verification_runs: [{
      name: "required after rebrand",
      command: "node --test required.test.js",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      output_hash: "c".repeat(64),
      recorded_by: "codex-confirmed-verification-v1",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  });

  const rebrand = rebrandEvidence(runDir, {
    newHeadSha: "b".repeat(40),
    reason: "recover-commit added new commit",
  });
  const written = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const preflight = buildExecutionEvidencePreflight({
    runDir,
    reviewedHead: "b".repeat(40),
    strict: true,
  });

  assert.equal(rebrand.verificationRunsPolicy, "removed_stale_after_rebrand");
  assert.equal(rebrand.removedVerificationRuns, 1);
  assert.equal(written.verification_runs, undefined);
  assert.deepEqual(written.rebrand.verification_runs, {
    policy: "removed_stale_after_rebrand",
    removed_count: 1,
    previous_head_shas: ["a".repeat(40)],
    removed_runs: [{
      name: "required after rebrand",
      command: "node --test required.test.js",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      output_hash: "c".repeat(64),
      recorded_by: "codex-confirmed-verification-v1",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
    next_action: "re-verify at the new HEAD or record audited operator evidence",
  });
  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.qualityExecutionStatus, "fail");
  assert.match(preflight.reason, /rebrand removed 1 stale verification_run/);
  assert.match(preflight.reason, /re-verify at the new HEAD or record audited operator evidence/);
});

test("rebrandEvidence safely audits malformed verification_runs and strict preflight names the rebrand", () => {
  const malformedValues = [{
    name: "object",
    value: { command: "node --test required.test.js" },
    reason: /must be an array when present; found object/,
  }, {
    name: "null",
    value: null,
    reason: /must be an array when present; found null/,
  }, {
    name: "array with invalid entry",
    value: [null],
    reason: /verification_runs\[0\] must be a JSON object/,
  }];

  for (const entry of malformedValues) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-rebrand-malformed-"));
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
      "evaluation:",
      "  verification:",
      "    checks:",
      "      - name: required after malformed rebrand",
      "        type: command",
      "        command: node --test required.test.js",
    ].join("\n"), "utf-8");
    const evidencePath = writeExecutionEvidence(runDir, {
      schema_version: 1,
      head_sha: "a".repeat(40),
      test_command: "unspecified",
      test_result_hash: "unspecified",
      test_result_summary: "malformed verification evidence",
      verification_runs: entry.value,
      recorded_at: "2026-04-22T00:00:00.000Z",
      recorded_by: "dispatch-orchestrator-v1",
    });

    const rebrand = rebrandEvidence(runDir, {
      newHeadSha: "b".repeat(40),
      reason: `recover malformed ${entry.name}`,
    });
    const written = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
    const preflight = buildExecutionEvidencePreflight({
      runDir,
      reviewedHead: "b".repeat(40),
      strict: true,
    });

    assert.equal(rebrand.rewritten, true, entry.name);
    assert.equal(rebrand.verificationRunsPolicy, "removed_malformed_after_rebrand", entry.name);
    assert.match(rebrand.verificationRunsMalformation, entry.reason, entry.name);
    assert.equal(written.verification_runs, undefined, entry.name);
    assert.equal(
      written.rebrand.verification_runs.policy,
      "removed_malformed_after_rebrand",
      entry.name
    );
    assert.deepEqual(written.rebrand.verification_runs.removed_value, entry.value, entry.name);
    assert.match(written.rebrand.verification_runs.malformation_reason, entry.reason, entry.name);
    assert.equal(preflight.status, "blocked", entry.name);
    assert.equal(preflight.qualityExecutionStatus, "fail", entry.name);
    assert.match(preflight.reason, /rebrand removed malformed verification_runs/, entry.name);
    assert.match(preflight.reason, entry.reason, entry.name);
    assert.match(
      preflight.reason,
      /Re-verify at the new HEAD or record audited operator evidence/,
      entry.name
    );
  }
});

test("strict preflight blocks a malformed verification rebrand audit with zero command gates", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-rebrand-gateless-"));
  const rubric = [
    "evaluation:",
    "  verification:",
    "    checks:",
    "      - name: inspect artifact",
    "        type: observation",
  ].join("\n");
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), rubric, "utf-8");
  const legacyFields = {
    schema_version: 1,
    test_command: "node --test legacy.test.js",
    test_result_hash: "c".repeat(64),
    test_result_summary: "legacy gate passed",
    test_exit_code: 0,
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  };
  writeExecutionEvidence(runDir, {
    ...legacyFields,
    head_sha: "a".repeat(40),
    verification_runs: { command: "node --test malformed.test.js" },
  });

  rebrandEvidence(runDir, {
    newHeadSha: "b".repeat(40),
    reason: "recover malformed gateless evidence",
  });
  const blocked = buildExecutionEvidencePreflight({
    runDir,
    reviewedHead: "b".repeat(40),
    strict: true,
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.qualityExecutionStatus, "fail");
  assert.match(blocked.reason, /removed malformed verification_runs/);
  assert.match(blocked.reason, /must be an array when present; found object/);
  assert.match(blocked.reason, new RegExp(`from ${"a".repeat(40)} to ${"b".repeat(40)}`));
  assert.match(blocked.reason, /Re-verify at the new HEAD or record audited operator evidence/);
  assert.doesNotMatch(blocked.reason, /Required verification gates?:/);

  const cleanRunDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-clean-gateless-"));
  fs.writeFileSync(path.join(cleanRunDir, "rubric.yaml"), rubric, "utf-8");
  writeExecutionEvidence(cleanRunDir, {
    ...legacyFields,
    head_sha: "b".repeat(40),
  });
  assert.deepEqual(
    buildExecutionEvidencePreflight({
      runDir: cleanRunDir,
      reviewedHead: "b".repeat(40),
      strict: true,
    }),
    {
      status: "pass",
      qualityExecutionStatus: "pass",
      reason: null,
      reviewedHeadSha: "b".repeat(40),
      evidenceHeadSha: "b".repeat(40),
      artifactPath: path.join(cleanRunDir, EXECUTION_EVIDENCE_FILENAME),
      browserEvidence: { present: false },
      nextAction: "invoke_primary_reviewer",
    }
  );
});

test("rebrandEvidence retains verification removal provenance across repeated rebrands", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-double-rebrand-"));
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "evaluation:",
    "  verification:",
    "    checks:",
    "      - name: required after repeated rebrand",
    "        type: command",
    "        command: node --test required.test.js",
  ].join("\n"), "utf-8");
  const evidencePath = writeExecutionEvidence(runDir, {
    schema_version: 1,
    head_sha: "a".repeat(40),
    test_command: "unspecified",
    test_result_hash: "unspecified",
    test_result_summary: "verified before repeated rebrand",
    verification_runs: [{
      name: "required after repeated rebrand",
      command: "node --test required.test.js",
      cwd: "/repo",
      head_sha: "a".repeat(40),
      exit_code: 0,
      output_hash: "c".repeat(64),
      recorded_by: "codex-confirmed-verification-v1",
      recorded_at: "2026-04-22T00:00:00.000Z",
    }],
    recorded_at: "2026-04-22T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  });

  rebrandEvidence(runDir, {
    newHeadSha: "b".repeat(40),
    reason: "first recovery commit",
  });
  rebrandEvidence(runDir, {
    newHeadSha: "c".repeat(40),
    reason: "second recovery commit",
  });

  const written = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const preflight = buildExecutionEvidencePreflight({
    runDir,
    reviewedHead: "c".repeat(40),
    strict: true,
  });

  assert.equal(written.rebrand.previous_head_sha, "b".repeat(40));
  assert.equal(written.rebrand.new_head_sha, "c".repeat(40));
  assert.equal(written.rebrand.verification_runs, undefined);
  assert.equal(written.rebrand_history.length, 1);
  assert.equal(written.rebrand_history[0].previous_head_sha, "a".repeat(40));
  assert.equal(written.rebrand_history[0].new_head_sha, "b".repeat(40));
  assert.equal(
    written.rebrand_history[0].verification_runs.policy,
    "removed_stale_after_rebrand"
  );
  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.qualityExecutionStatus, "fail");
  assert.match(preflight.reason, /rebrand removed 1 stale verification_run/);
  assert.match(preflight.reason, /from a{40} to b{40}; evidence is now at c{40}/);
  assert.match(preflight.reason, /re-verify at the new HEAD or record audited operator evidence/);
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
