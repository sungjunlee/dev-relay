const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runtimePath = process.env.RELAY_VNEXT_RUNTIME_PATH
  ? path.resolve(process.env.RELAY_VNEXT_RUNTIME_PATH)
  : path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/runtime-vnext.js");

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-vnext-${label}-`));
}

function createIdentity(runtime, label, runId = "r1") {
  const root = tempRoot(label);
  fs.mkdirSync(path.join(root, runId));
  const runDir = fs.realpathSync(path.join(root, runId));
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "done\n");
  const criteriaHash = crypto.createHash("sha256").update("done\n").digest("hex");
  const record = {
    version: 3,
    run_id: runId,
    repo: { root: "/repo", remote: "owner/repo" },
    git: {
      branch: "work",
      base_branch: "main",
      worktree: "/wt",
      start_sha: "a".repeat(40),
    },
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: criteriaHash,
    },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-07-31T00:00:00Z",
  };
  runtime.createRunRecord({ runDir, record });
  return { runDir, record, criteriaHash };
}

function gate(assertions) {
  return async () => {
    assert.equal(fs.existsSync(runtimePath), true, "vNext runtime entrypoint must exist");
    const runtime = require(runtimePath);
    await assertions(runtime);
  };
}

test("RR-01 vNext worktree containment", gate(async (runtime) => {
  const root = tempRoot("containment");
  const repoRoot = path.join(root, "repo");
  const activeCheckout = path.join(repoRoot, "active");
  const relayBase = path.join(root, "relay-worktrees");
  const trusted = path.join(relayBase, "run-1", "repo");
  const outside = path.join(root, "outside");
  fs.mkdirSync(activeCheckout, { recursive: true });
  fs.mkdirSync(trusted, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const activeNestedBase = path.join(activeCheckout, "relay-worktrees");
  const activeNested = path.join(activeNestedBase, "run-2");
  fs.mkdirSync(activeNested, { recursive: true });
  assert.equal(runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: trusted }), true);
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: activeCheckout }));
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: path.join(relayBase, "..", "outside") }));
  assert.throws(() => runtime.assertTrustedWorktree({
    repoRoot,
    activeCheckout,
    relayWorktreeBase: activeNestedBase,
    worktree: activeNested,
  }));
  const symlink = path.join(relayBase, "escaped-link");
  fs.symlinkSync(outside, symlink);
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: symlink }));
}));

test("RR-02 vNext frozen outcome contract", gate(async (runtime) => {
  const root = tempRoot("criteria");
  const sourcePath = path.join(root, "criteria.md");
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(sourcePath, "criterion A\n", "utf-8");
  const frozen = await runtime.freezeDoneCriteria({ sourcePath, runDir });
  const expected = crypto.createHash("sha256").update("criterion A\n").digest("hex");
  assert.equal(frozen.sha256, expected);
  assert.equal(fs.readFileSync(frozen.path, "utf-8"), "criterion A\n");
  fs.writeFileSync(sourcePath, "criterion B\n", "utf-8");
  assert.equal(fs.readFileSync(frozen.path, "utf-8"), "criterion A\n");
  assert.equal(await runtime.hashDoneCriteria(frozen.path), expected);
}));

test("RR-03 vNext immutable identity", gate(async (runtime) => {
  const root = fs.realpathSync(tempRoot("identity"));
  const runDir = path.join(root, "run-1");
  fs.mkdirSync(runDir);
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "done\n", "utf-8");
  const criteriaHash = crypto.createHash("sha256").update("done\n").digest("hex");
  const record = {
    version: 3,
    run_id: "run-1",
    repo: { root: "/repo", remote: "owner/repo" },
    git: {
      branch: "work",
      base_branch: "main",
      worktree: "/wt",
      start_sha: "a".repeat(40),
    },
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: criteriaHash,
    },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-07-31T00:00:00Z",
  };
  const created = await runtime.createRunRecord({ runDir, record });
  assert.deepEqual(created, record);
  assert.throws(() => runtime.createRunRecord({
    runDir,
    record: { ...record, run_id: "run-2" },
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8")), record);
}));

test("RR-04 vNext single actor", gate(async (runtime) => {
  const runDir = tempRoot("lock");
  let release;
  let entered = false;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = runtime.withRunLock(runDir, async () => { entered = true; await blocker; });
  const acquisitionDeadline = Date.now() + 100;
  while (!entered && Date.now() < acquisitionDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(entered, true, "first actor must acquire the lock");
  await assert.rejects(runtime.withRunLock(runDir, async () => "second actor"));
  release();
  await first;
  assert.equal(await runtime.withRunLock(runDir, async () => "after release"), "after release");
}));

test("RR-05 vNext append-only attempts", gate(async (runtime) => {
  const { runDir } = createIdentity(runtime, "events");
  const eventsPath = path.join(runDir, "events.jsonl");
  const first = {
    event_id: "e1",
    run_id: "r1",
    attempt_id: "a1",
    type: "attempt_started",
    at: "2026-07-31T00:00:00Z",
    actor: "codex",
    payload: {
      executor: "codex",
      model: null,
      start_sha: "a".repeat(40),
      host_kind: "local",
      host_handle: "host-1",
      stdout_path: "/run/stdout.log",
      stderr_path: "/run/stderr.log",
      result_path: "/run/result.json",
      timeout_ms: 60000,
    },
  };
  const second = {
    ...first,
    event_id: "e2",
    type: "attempt_finished",
    at: "2026-07-31T00:01:00Z",
    payload: {
      status: "completed",
      start_sha: "a".repeat(40),
      final_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
      result_path: "/run/result.json",
      exit_code: 0,
      verification_status: "passed",
    },
  };
  await assert.rejects(runtime.appendFact({
    eventsPath,
    fact: { ...first, event_id: "invalid", payload: {} },
  }));
  await runtime.appendFact({ eventsPath, fact: first });
  await runtime.appendFact({ eventsPath, fact: second });
  const prefix = fs.readFileSync(eventsPath, "utf-8");
  assert.equal(prefix.endsWith("\n"), true);
  assert.equal(prefix.trimEnd().split("\n").length, 2);
  fs.appendFileSync(eventsPath, '{"event_id":"torn"', "utf-8");
  const read = await runtime.readFacts({ eventsPath });
  assert.deepEqual(read.facts, [first, second]);
  assert.equal(read.tailIncomplete, true);
  const repair = await runtime.repairTornTail({ eventsPath });
  assert.equal(fs.existsSync(repair.quarantinePath), true);
  assert.equal(fs.readFileSync(eventsPath, "utf-8"), prefix);
}));

test("RR-06 vNext exact review binding", gate(async (runtime) => {
  const verdict = { reviewed_sha: "a".repeat(40), done_criteria_sha256: "b".repeat(64), verdict: "lgtm" };
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, true);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: "c".repeat(40), doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, false);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: "d".repeat(64) }).valid, false);
}));

test("RR-07 vNext independent review", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "review");
  const diffPath = path.join(runDir, "review.diff");
  const promptPath = path.join(runDir, "review.prompt.md");
  fs.writeFileSync(diffPath, "diff\n");
  fs.writeFileSync(promptPath, "review this\n");
  const request = {
    diff_path: diffPath,
    prompt_path: promptPath,
    done_criteria_path: record.contract.done_criteria_path,
    reviewed_sha: "a".repeat(40),
    current_sha: "a".repeat(40),
  };
  const verdict = runtime.invokeIndependentReviewer({
    runDir,
    request,
    command: process.execPath,
    args: [{
      kind: "staged_file",
      value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js"),
    }],
  });
  assert.equal(verdict.verdict, "lgtm");
  assert.equal(verdict.run_id, "r1");
  assert.equal(verdict.reviewed_sha, request.reviewed_sha);
  const artifacts = fs.readdirSync(runDir).filter((entry) => entry.startsWith("review-request-"));
  assert.equal(artifacts.length, 0);
  assert.equal(verdict.prompt_text, "review this\n");
  assert.equal(verdict.request_paths.every((entry) => entry.startsWith(verdict.cwd)), true);
  assert.equal(verdict.request_paths.every((entry) => !entry.startsWith(runDir)), true);
  assert.equal(verdict.executor_session_token, null);
  assert.equal(verdict.executor_worktree, null);
  assert.equal(verdict.cwd.startsWith(runDir), false);
  assert.equal(
    verdict.home === verdict.cwd || `/private${verdict.home}` === verdict.cwd,
    true,
  );
  fs.writeFileSync(promptPath, "mutated executor-side prompt\n");
  assert.throws(() => runtime.invokeIndependentReviewer({
    runDir,
    request,
    command: process.execPath,
    args: [{ kind: "staged_file", value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js") }],
    env: { EXECUTOR_SESSION_TOKEN: "leak" },
  }), /not allowed/);
  assert.throws(() => runtime.invokeIndependentReviewer({
    runDir,
    request,
    command: process.execPath,
    args: [{ kind: "literal", value: "worker.js", executorSession: "leak" }],
  }), /must match/);
  const transcriptPath = path.join(runDir, "executor-transcript.txt");
  const maliciousPath = path.join(runDir, "malicious-reviewer.js");
  fs.writeFileSync(transcriptPath, "private executor reasoning\n");
  fs.writeFileSync(maliciousPath, `
const fs = require("fs");
let leak = null;
let denied = false;
try { leak = fs.readFileSync(${JSON.stringify(transcriptPath)}, "utf8"); }
catch { denied = true; }
process.stdout.write(JSON.stringify({ verdict: "lgtm", leak, denied }));
`);
  const isolated = runtime.invokeIndependentReviewer({
    runDir,
    request,
    command: process.execPath,
    args: [{ kind: "staged_file", value: maliciousPath }],
  });
  assert.equal(isolated.leak, null);
  assert.equal(isolated.denied, true);
}));

test("RR-07 Node 18 capability simulation fails closed without isolation", gate(async (runtime) => {
  assert.throws(() => runtime.selectFilesystemIsolation({
    darwinSandboxAvailable: false,
    nodePermissionModelAvailable: false,
    isNodeCommand: true,
  }), /filesystem isolation unavailable/);
}));

test("RR-08 vNext explicit merge", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "merge-plan");
  const head = "a".repeat(40);
  const verdict = { verdict: "lgtm", reviewed_sha: head, done_criteria_sha256: record.contract.done_criteria_sha256 };
  assert.throws(() => runtime.planOperatorMerge({ currentHead: head, verdict }));
  await runtime.withRunLock({
    runDir,
    attemptId: "merge-plan",
    operation: "merge-plan",
    hostKind: "local_supervisor",
    hostHandle: `merge-plan:${process.pid}`,
    worktreeDir: runDir,
  }, async (lockContext) => {
    const fresh = await runtime.revalidateExternalFacts({
      runDir,
      lockContext,
      observer: {
        command: process.execPath,
        args: [
          { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js") },
          { kind: "literal", value: "--observe" },
        ],
      },
      request: { pr_number: 42, expected_pr_head_sha: head },
      authorize: () => ({ authorized: true }),
    });
    assert.throws(() => runtime.planOperatorMerge({
      runDir,
      lockContext,
      freshObservation: fresh.observationCapability,
      operatorAction: { actor: "owner", method: "squash" },
      currentHead: "c".repeat(40),
      currentDoneCriteriaSha256: verdict.done_criteria_sha256,
      prNumber: 42,
      verdict,
    }));
    const plan = runtime.planOperatorMerge({
      runDir,
      lockContext,
      freshObservation: fresh.observationCapability,
      operatorAction: { actor: "owner", method: "squash" },
      currentHead: head,
      currentDoneCriteriaSha256: verdict.done_criteria_sha256,
      prNumber: 42,
      verdict,
    });
    assert.equal(plan.authorized, true);
    assert.equal(plan.headSha, head);
    assert.equal(fs.existsSync(path.join(runDir, `merge-authorization-${plan.operationId}.json`)), true);
  });
}));

test("RR-09 vNext merge provenance", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "merge");
  const eventsPath = path.join(runDir, "events.jsonl");
  const at = "2026-07-31T00:00:00Z";
  const provenance = { pr_number: 42, reviewed_source_sha: "a".repeat(40), pr_head_sha: "a".repeat(40), result_target_sha: "b".repeat(40), method: "squash", operator: "owner", override_reason: null };
  let fact;
  await runtime.withRunLock({
    runDir,
    attemptId: "merge-record",
    operation: "merge-record",
    hostKind: "local_supervisor",
    hostHandle: `merge-record:${process.pid}`,
    worktreeDir: runDir,
  }, async (lockContext) => {
    const observer = {
      command: process.execPath,
      args: [
        { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js") },
        { kind: "literal", value: "--observe" },
      ],
    };
    const fresh = await runtime.revalidateExternalFacts({
      runDir,
      lockContext,
      observer,
      request: { pr_number: 42, expected_pr_head_sha: provenance.pr_head_sha },
      authorize: () => ({ authorized: true }),
    });
    const authorization = runtime.planOperatorMerge({
      runDir,
      lockContext,
      freshObservation: fresh.observationCapability,
      operatorAction: { actor: "owner", method: "squash" },
      currentHead: provenance.pr_head_sha,
      currentDoneCriteriaSha256: record.contract.done_criteria_sha256,
      prNumber: 42,
      verdict: {
        verdict: "lgtm",
        reviewed_sha: provenance.pr_head_sha,
        done_criteria_sha256: record.contract.done_criteria_sha256,
      },
    });
    await assert.rejects(runtime.recordMerge({
      eventsPath,
      at,
      provenance,
      authorization: { ...authorization },
      lockContext,
      observer,
    }));
    await assert.rejects(runtime.recordMerge({
      eventsPath,
      at,
      provenance,
      authorization,
      lockContext,
      observer: {
        ...observer,
        args: [...observer.args, { kind: "literal", value: "--forge-open" }],
      },
    }), /exact merged PR/);
    await assert.rejects(runtime.recordMerge({
      eventsPath,
      at,
      provenance,
      authorization,
      lockContext,
      observer: {
        ...observer,
        args: [...observer.args, { kind: "literal", value: "--forge-target" }],
      },
    }), /exact merged PR/);
    fact = await runtime.recordMerge({
      eventsPath, at, provenance, authorization, lockContext, observer,
    });
  });
  assert.equal(fact.at, at);
  assert.equal(fact.payload.pr_number, provenance.pr_number);
  assert.equal(typeof fact.payload.operation_id, "string");
  const persisted = JSON.parse(fs.readFileSync(eventsPath, "utf-8").trim());
  assert.equal(persisted.at, at);
  assert.deepEqual(persisted.payload, fact.payload);
}));

test("RR-10 vNext crash-safe idempotency", gate(async (runtime) => {
  const runDir = tempRoot("recover");
  const effects = [];
  let published = false;
  const operation = {
    runDir,
    recoveryKey: "publish-head-a",
    observe: async ({ phase }) => ({ phase, head: "a", converged: published }),
    apply: async (_observation, context) => {
      effects.push(`publish:${context.operationId}`);
      published = true;
      return { pr: 42 };
    },
  };
  const first = await runtime.recoverRun(operation);
  const second = await runtime.recoverRun(operation);
  assert.deepEqual(second, first);
  assert.equal(effects.length, 1);
  assert.equal(first.final_observation.converged, true);
}));

test("RR-11 vNext terminal irreversibility", gate(async (runtime) => {
  const startedPayload = {
    executor: "codex",
    model: null,
    start_sha: "a".repeat(40),
    host_kind: "local",
    host_handle: "host-1",
    stdout_path: "/run/stdout.log",
    stderr_path: "/run/stderr.log",
    result_path: "/run/result.json",
    timeout_ms: 60000,
  };
  const folded = runtime.foldRun({
    runRecord: { run_id: "r1" },
    facts: [
      { event_id: "e1", run_id: "r1", type: "attempt_started", attempt_id: "a1", at: "2026-07-31T00:00:00Z", actor: "codex", payload: startedPayload },
      { event_id: "e2", run_id: "r1", type: "run_closed", at: "2026-07-31T00:01:00Z", actor: "owner", payload: { reason: "operator", operator: "owner", last_sha: "a".repeat(40), pr_number: null } },
      { event_id: "e3", run_id: "r1", type: "attempt_started", attempt_id: "a2", at: "2026-07-31T00:02:00Z", actor: "codex", payload: startedPayload },
    ],
  });
  assert.equal(folded.terminal, true);
  assert.equal(folded.activeAttempt, null);
  assert.equal(folded.action, "none");
}));

test("RR-12 vNext external revalidation", gate(async (runtime) => {
  const { runDir } = createIdentity(runtime, "revalidate");
  const result = await runtime.withRunLock({
    runDir,
    attemptId: "revalidate",
    operation: "revalidate",
    hostKind: "local_supervisor",
    hostHandle: `revalidate:${process.pid}`,
    worktreeDir: runDir,
  }, async (lockContext) => runtime.revalidateExternalFacts({
    runDir,
    lockContext,
    observer: {
      command: process.execPath,
      args: [
        { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js") },
        { kind: "literal", value: "--observe" },
      ],
    },
    request: { pr: 42 },
    authorize: async (facts, context) => {
      assert.equal(facts.source, "fresh-subprocess");
      assert.equal(Object.hasOwn(context, "lockHeld"), false);
      assert.equal(typeof context.lockContext, "object");
      return { authorized: false, reason: "head_changed", live: facts };
    },
  }));
  assert.equal(result.decision.authorized, false);
  assert.equal(result.decision.reason, "head_changed");
  assert.equal(result.decision.live.source, "fresh-subprocess");
  assert.equal(result.observationCapability.facts.source, "fresh-subprocess");
}));
