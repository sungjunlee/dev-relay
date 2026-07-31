const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const contract = require("../../../docs/contracts/relay-runtime-contracts.v1.json");
const driver = require("../fixtures/runtime-contract-driver");

test("runtime contract manifest resolves every evidence and vNext test reference to a named test", () => {
  assert.equal(contract.contract_version, 1);
  assert.equal(contract.invariants.length, 12);
  assert.equal(new Set(contract.invariants.map((entry) => entry.id)).size, 12);
  for (const invariant of contract.invariants) {
    const evidence = invariant.evidence || [];
    assert.equal(typeof invariant.vnext_test_path, "string", `${invariant.id} needs a named vNext gate`);
    assert.ok(
      invariant.status === "legacy_black_box_evidence" || invariant.status === "vnext_gate",
      `${invariant.id} must declare its compatibility status`
    );
    if (invariant.status === "legacy_black_box_evidence") {
      assert.ok(evidence.length > 0, `${invariant.id} claims legacy evidence but names none`);
    } else {
      assert.deepEqual(evidence, [], `${invariant.id} is vNext-only and must not claim legacy evidence`);
    }
    for (const reference of [...evidence, invariant.vnext_test_path].filter(Boolean)) {
      const [relativeFile, testName] = reference.split("#");
      const absoluteFile = path.join(__dirname, "..", "..", "..", relativeFile);
      assert.equal(fs.existsSync(absoluteFile), true, `${invariant.id} missing ${relativeFile}`);
      const source = fs.readFileSync(absoluteFile, "utf-8");
      assert.match(source, new RegExp(`test\\([\\"']${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  }
});

test("RR-01 worktree containment", () => {
  const fixture = driver.setupRepo("relay-runtime-contract-containment-");
  const mainBefore = driver.remoteBranchHead(fixture, "main");
  const activeOnly = path.join(fixture.repoRoot, "active-only.txt");
  fs.writeFileSync(activeOnly, "must remain in active checkout\n", "utf-8");

  const result = driver.runExecutorWriteDispatch(fixture, "contract-isolated-work");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.notEqual(fs.realpathSync(plan.worktree), fs.realpathSync(fixture.repoRoot));
  assert.ok(fs.realpathSync(plan.worktree).startsWith(`${fs.realpathSync(fixture.relayHome)}${path.sep}`));
  assert.equal(fs.existsSync(path.join(plan.worktree, "active-only.txt")), false);
  assert.equal(fs.readFileSync(path.join(plan.worktree, "executor-owned.txt"), "utf-8"), "written by executor\n");
  assert.equal(fs.readFileSync(activeOnly, "utf-8"), "must remain in active checkout\n");
  assert.equal(driver.remoteBranchHead(fixture, "main"), mainBefore);

  const untrusted = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-untrusted-"), { kind: "unreviewed" });
  const rejected = driver.rejectSymlinkedUntrustedWorktree(untrusted);
  assert.notEqual(rejected.result.status, 0);
  assert.equal(rejected.sentinel, "safe\n");
});

test("RR-02 frozen outcome contract", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-frozen-"), { kind: "recoverable" });
  const gh = driver.writeFakeGh(run);
  const before = driver.frozenContractHash(run);
  driver.addReviewableChange(run);
  const result = driver.runRecover(run, gh, "contract-preserving recovery");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(driver.frozenContractHash(run), before);
});

test("RR-03 immutable identity", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-identity-"), { kind: "recoverable" });
  const gh = driver.writeFakeGh(run);
  const before = driver.identityProjection(run);
  driver.addReviewableChange(run);
  const result = driver.runRecover(run, gh, "identity-preserving recovery");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(driver.identityProjection(run), before);
});

test("RR-04 single actor exclusion", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-lock-"), { kind: "inflight" });
  driver.addReviewableChange(run);
  const stop = driver.startLiveLease(run);
  try {
    const result = driver.runRecover(run, run.env, "must respect live actor");
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(run.worktreePath, "recovered.txt")), true);
  } finally {
    stop();
  }
});

test("RR-08 explicit merge boundary", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-merge-"), { kind: "unreviewed" });
  const mainBefore = driver.remoteBranchHead(run, "main");
  const result = driver.runFinalizeUnreviewed(run);

  assert.notEqual(result.status, 0);
  assert.ok(driver.isExplicitMergeBoundaryRefusal(result), result.stderr);
  assert.equal(driver.remoteBranchHead(run, "main"), mainBefore);
});

test("RR-10 crash-safe idempotent recovery publication", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-recovery-"), { kind: "recoverable" });
  const gh = driver.writeFakeGh(run);
  driver.addReviewableChange(run);

  const first = driver.runRecover(run, gh, "first recovery");
  assert.equal(first.status, 0, first.stderr);
  const firstHead = driver.remoteBranchHead(run, run.branch);
  const second = driver.runRecover(run, gh, "repeat recovery");
  assert.equal(second.status, 0, second.stderr);

  assert.equal(driver.remoteBranchHead(run, run.branch), firstHead);
  assert.deepEqual(gh.readGhState(), { created: 1, pr: 901 });
});

test("RR-11 terminal irreversibility and selector fail closed", () => {
  const run = driver.createLegacyRun(driver.setupRepo("relay-runtime-contract-terminal-"), { kind: "terminal" });
  const before = driver.manifestBytes(run);
  const terminalAttempt = driver.runRecover(run, run.env, "must not reopen");
  assert.notEqual(terminalAttempt.status, 0);
  assert.ok(driver.isTerminalRecoveryRefusal(terminalAttempt), terminalAttempt.stderr);
  assert.equal(driver.manifestBytes(run), before);

  const missingAttempt = driver.runRecover({ ...run, runId: "unknown-contract-run" }, run.env, "unknown selector");
  assert.notEqual(missingAttempt.status, 0);
  assert.equal(driver.manifestBytes(run), before);
});
