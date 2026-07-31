const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const enabled = process.env.RELAY_VNEXT_CONTRACTS === "1";
const todo = enabled ? false : "enable with RELAY_VNEXT_CONTRACTS=1";
const runtimePath = process.env.RELAY_VNEXT_RUNTIME_PATH
  ? path.resolve(process.env.RELAY_VNEXT_RUNTIME_PATH)
  : path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/runtime-vnext.js");

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-vnext-${label}-`));
}

function gate(assertions) {
  return async () => {
    if (!enabled) return;
    assert.equal(fs.existsSync(runtimePath), true, "vNext runtime entrypoint must exist");
    const runtime = require(runtimePath);
    await assertions(runtime);
  };
}

test("RR-01 vNext worktree containment", { todo }, gate(async (runtime) => {
  const root = tempRoot("containment");
  const repoRoot = path.join(root, "repo");
  const activeCheckout = path.join(repoRoot, "active");
  const relayBase = path.join(root, "relay-worktrees");
  const trusted = path.join(relayBase, "run-1", "repo");
  const outside = path.join(root, "outside");
  fs.mkdirSync(activeCheckout, { recursive: true });
  fs.mkdirSync(trusted, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  assert.equal(runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: trusted }), true);
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: activeCheckout }));
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: path.join(relayBase, "..", "outside") }));
  const symlink = path.join(relayBase, "escaped-link");
  fs.symlinkSync(outside, symlink);
  assert.throws(() => runtime.assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase: relayBase, worktree: symlink }));
}));

test("RR-02 vNext frozen outcome contract", { todo }, gate(async (runtime) => {
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

test("RR-03 vNext immutable identity", { todo }, gate(async (runtime) => {
  const runDir = tempRoot("identity");
  const record = { run_id: "run-1", repo: { root: "/repo" }, git: { branch: "work", base_branch: "main", worktree: "/wt" }, roles: { executor: "codex", reviewer: "claude" } };
  const created = await runtime.createRunRecord({ runDir, record });
  assert.deepEqual(created, record);
  await assert.rejects(runtime.createRunRecord({ runDir, record: { ...record, run_id: "run-2" } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf-8")), record);
}));

test("RR-04 vNext single actor", { todo }, gate(async (runtime) => {
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

test("RR-05 vNext append-only attempts", { todo }, gate(async (runtime) => {
  const root = tempRoot("events");
  const eventsPath = path.join(root, "events.jsonl");
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

test("RR-06 vNext exact review binding", { todo }, gate(async (runtime) => {
  const verdict = { reviewed_sha: "a".repeat(40), done_criteria_sha256: "b".repeat(64), verdict: "lgtm" };
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, true);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: "c".repeat(40), doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, false);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: "d".repeat(64) }).valid, false);
}));

test("RR-07 vNext independent review", { todo }, gate(async (runtime) => {
  const request = { diff_path: "/run/diff.patch", done_criteria_path: "/run/done.md", reviewed_sha: "a".repeat(40) };
  let reviewerInput;
  const verdict = await runtime.invokeIndependentReviewer({
    request,
    executorSession: { transcript: "private executor reasoning", token: "secret" },
    invoke: async (input) => { reviewerInput = input; return { verdict: "lgtm" }; },
  });
  assert.deepEqual(verdict, { verdict: "lgtm" });
  assert.deepEqual(reviewerInput, request);
  assert.equal(JSON.stringify(reviewerInput).includes("private executor reasoning"), false);
  assert.equal(JSON.stringify(reviewerInput).includes("secret"), false);
}));

test("RR-08 vNext explicit merge", { todo }, gate(async (runtime) => {
  const head = "a".repeat(40);
  const verdict = { verdict: "lgtm", reviewed_sha: head, done_criteria_sha256: "b".repeat(64) };
  assert.throws(() => runtime.planOperatorMerge({ currentHead: head, verdict }));
  assert.throws(() => runtime.planOperatorMerge({ operatorAction: { actor: "owner" }, currentHead: "c".repeat(40), verdict }));
  const plan = runtime.planOperatorMerge({ operatorAction: { actor: "owner", method: "squash" }, currentHead: head, verdict });
  assert.equal(plan.authorized, true);
  assert.equal(plan.headSha, head);
}));

test("RR-09 vNext merge provenance", { todo }, gate(async (runtime) => {
  const eventsPath = path.join(tempRoot("merge"), "events.jsonl");
  const at = "2026-07-31T00:00:00Z";
  const provenance = { pr_number: 42, reviewed_source_sha: "a".repeat(40), pr_head_sha: "a".repeat(40), result_target_sha: "b".repeat(40), method: "squash", operator: "owner", override_reason: null };
  const fact = await runtime.recordMerge({ eventsPath, at, provenance });
  assert.equal(fact.at, at);
  assert.deepEqual(fact.payload, provenance);
  const persisted = JSON.parse(fs.readFileSync(eventsPath, "utf-8").trim());
  assert.equal(persisted.at, at);
  assert.deepEqual(persisted.payload, provenance);
}));

test("RR-10 vNext crash-safe idempotency", { todo }, gate(async (runtime) => {
  const runDir = tempRoot("recover");
  const effects = [];
  const operation = { runDir, recoveryKey: "publish-head-a", observe: async () => ({ head: "a", needsPublication: true }), apply: async () => { effects.push("publish"); return { pr: 42 }; } };
  const first = await runtime.recoverRun(operation);
  const second = await runtime.recoverRun(operation);
  assert.deepEqual(second, first);
  assert.deepEqual(effects, ["publish"]);
}));

test("RR-11 vNext terminal irreversibility", { todo }, gate(async (runtime) => {
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

test("RR-12 vNext external revalidation", { todo }, gate(async (runtime) => {
  const runDir = tempRoot("revalidate");
  const order = [];
  const cached = { prHeadSha: "a".repeat(40) };
  const live = { prHeadSha: "b".repeat(40) };
  const result = await runtime.revalidateExternalFacts({
    runDir,
    cached,
    observe: async (context) => { order.push("observe"); assert.equal(context.lockHeld, true); return live; },
    authorize: async (facts, context) => { order.push("authorize"); assert.equal(context.lockHeld, true); assert.deepEqual(facts, live); return { authorized: false, reason: "head_changed" }; },
  });
  assert.deepEqual(order, ["observe", "authorize"]);
  assert.deepEqual(result, { authorized: false, reason: "head_changed" });
}));
