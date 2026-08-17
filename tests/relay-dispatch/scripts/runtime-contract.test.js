const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const { getAdapter } = require("../../../skills/relay-dispatch/scripts/adapters");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const inspect = require("../../../skills/relay-dispatch/scripts/inspect");
const recover = require("../../../skills/relay-dispatch/scripts/recover");
const store = require("../../../skills/relay-dispatch/scripts/run-store");
function lockOptions(runDir, operation) { const canonical = fs.realpathSync(runDir); return { runDir: canonical,
  attemptId: `${operation}-${crypto.randomUUID()}`, operation, hostKind: "local_supervisor",
  hostHandle: `${operation}:${process.pid}`, worktreeDir: canonical }; }
function withRunLock(options, callback) { return host.withRunLock(typeof options === "string" ? lockOptions(options, "test") : options, callback); }
const productionRuntime = {
  ...facts, ...store, withRunLock,
  foldRun: ({ runRecord, facts: runFacts, gitFacts, githubFacts, hostFacts }) => inspect.foldRunFacts({ runRecord, facts: runFacts, gitFacts, githubFacts, hostFacts }),
  appendFact({ eventsPath, fact }) { const runDir = fs.realpathSync(path.dirname(eventsPath));
    return withRunLock(lockOptions(runDir, "append-fact"), (lockContext) => facts.appendFact({ eventsPath, fact, lockContext })); },
  repairTornTail({ eventsPath, at }) { const runDir = fs.realpathSync(path.dirname(eventsPath));
    return withRunLock(lockOptions(runDir, "repair-tail"), (lockContext) => facts.repairTornTail({ eventsPath, at, lockContext })); },
};
const runtime = process.env.RELAY_RUNTIME_PATH
  ? require(path.resolve(process.env.RELAY_RUNTIME_PATH))
  : productionRuntime;

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relay-runtime-${label}-`));
}

function shaFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
    await assertions(runtime);
  };
}

test("RR-01 Relay worktree containment", gate(async (runtime) => {
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

test("RR-02 Relay frozen outcome contract", gate(async (runtime) => {
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

test("RR-02b independent artifact hashing rejects a FIFO without blocking", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "fifo-artifact");
  const diffPath = path.join(runDir, "review.patch");
  const promptPath = path.join(runDir, "prompt.md");
  execFileSync("mkfifo", [diffPath]);
  fs.writeFileSync(promptPath, "review exactly\n");
  const started = Date.now();
  assert.throws(() => runtime.invokeIndependentReviewer({
    runDir,
    request: {
      diff_path: diffPath,
      prompt_path: promptPath,
      done_criteria_path: record.contract.done_criteria_path,
      reviewed_sha: record.git.start_sha,
      current_sha: record.git.start_sha,
    },
    command: process.execPath,
  }), /regular non-symlink/);
  assert.ok(Date.now() - started < 1000, "FIFO rejection must not wait for a writer");
}));

test("RR-03 Relay immutable identity", gate(async (runtime) => {
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

test("RR-04 Relay single actor", gate(async (runtime) => {
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

test("RR-05 Relay append-only attempts", gate(async (runtime) => {
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

test("RR-06 Relay exact review binding", gate(async (runtime) => {
  const verdict = { reviewed_sha: "a".repeat(40), done_criteria_sha256: "b".repeat(64), verdict: "lgtm" };
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, true);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: "c".repeat(40), doneCriteriaSha256: verdict.done_criteria_sha256 }).valid, false);
  assert.equal(runtime.validateReviewBinding({ verdict, currentSha: verdict.reviewed_sha, doneCriteriaSha256: "d".repeat(64) }).valid, false);
}));

test("RR-07 Relay independent review", gate(async (runtime) => {
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
    diff_sha256: shaFile(diffPath),
    prompt_sha256: shaFile(promptPath),
  };
  const parseOutcome = ({ exitCode, stdoutPath }) => {
    const output = JSON.parse(fs.readFileSync(stdoutPath, "utf8"));
    return { status: exitCode === 0 ? "succeeded" : "failed", summary: output.verdict, output };
  };
  const buildInvocation = ({ cwd, promptPath: stagedPrompt, promptBytes }) => ({
    command: process.execPath,
    args: ["-e", `
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  verdict: "lgtm", prompt_text: text, cwd: process.cwd(), home: process.env.HOME,
  executor_session_token: process.env.EXECUTOR_SESSION_TOKEN || null,
  executor_worktree: process.env.EXECUTOR_WORKTREE || null,
})));
`],
    cwd,
    stdinPath: stagedPrompt,
    stdinSha256: crypto.createHash("sha256").update(promptBytes).digest("hex"),
  });
  const verdict = runtime.invokeIndependentReviewer({
    runDir,
    request,
    buildInvocation,
    parseOutcome,
  });
  assert.equal(verdict.output.verdict, "lgtm");
  const artifacts = fs.readdirSync(runDir).filter((entry) => entry.startsWith("review-request-"));
  assert.equal(artifacts.length, 0);
  assert.equal(verdict.output.prompt_text, "review this\n");
  assert.equal(verdict.output.executor_session_token, null);
  assert.equal(verdict.output.executor_worktree, null);
  assert.equal(verdict.output.cwd.startsWith(runDir), false);
  assert.equal(verdict.output.home, process.env.HOME);
  fs.writeFileSync(promptPath, "mutated executor-side prompt\n");
  request.prompt_sha256 = shaFile(promptPath);
  const ambientVerdict = runtime.invokeIndependentReviewer({
    runDir,
    request,
    buildInvocation,
    parseOutcome,
    env: { EXECUTOR_SESSION_TOKEN: "leak" },
  });
  assert.equal(ambientVerdict.output.executor_session_token, "leak");
  const transcriptPath = path.join(runDir, "executor-transcript.txt");
  fs.writeFileSync(transcriptPath, "private executor reasoning\n");
  assert.throws(() => runtime.invokeIndependentReviewer({
    runDir,
    request,
    buildInvocation: ({ cwd }) => ({ command: process.execPath, args: ["-e", ""], cwd, stdinPath: transcriptPath }),
    parseOutcome,
  }), /stdin must be inside/);
  assert.throws(() => runtime.invokeIndependentReviewer({
    runDir,
    request,
    buildInvocation: ({ cwd, diffPath: stagedDiff, promptPath: stagedPrompt, doneCriteriaPath: stagedCriteria }) => ({
      command: process.execPath,
      args: ["-e", `
const fs = require("fs");
const result = {};
for (const [label, target] of [["diff", process.argv[1]], ["prompt", process.argv[2]], ["criteria", process.argv[3]]]) {
  try { fs.appendFileSync(target, "mutated\\n"); result[label] = "allowed"; }
  catch (error) { result[label] = "denied:" + (error.code || "unknown"); }
}
process.stdout.write(JSON.stringify({ verdict: "lgtm", ...result }));
`, stagedDiff, stagedPrompt, stagedCriteria],
      cwd,
    }),
    parseOutcome,
  }), /changed after immutable staging/);
}));

test("RR-07b staged runtime executes a direct native adapter without Relay sandbox admission", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "direct-adapter");
  const diffPath = path.join(runDir, "review.patch");
  const promptPath = path.join(runDir, "review.prompt.md");
  const binDir = path.join(path.dirname(runDir), "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(diffPath, "diff\n");
  fs.writeFileSync(promptPath, "review exactly\n");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
printf '%s\\n' '{"verdict":"pass","summary":"direct","issues":[]}' > "$out"
`);
  fs.chmodSync(fakeCodex, 0o755);
  const adapter = getAdapter("codex");
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const outcome = runtime.invokeIndependentReviewer({
        runDir,
        request: {
          diff_path: diffPath,
          prompt_path: promptPath,
          done_criteria_path: record.contract.done_criteria_path,
          reviewed_sha: record.git.start_sha,
          current_sha: record.git.start_sha,
          diff_sha256: shaFile(diffPath),
          prompt_sha256: shaFile(promptPath),
          schema: { type: "object" },
        },
        buildInvocation: ({ cwd, promptPath: stagedPrompt, promptBytes, resultPath, schemaPath }) => adapter.buildInvocation({
          phase: "primary_review", cwd, promptPath: stagedPrompt, promptBytes, resultPath, schemaPath,
          networkAccess: "enabled",
        }),
        parseOutcome: (input) => adapter.parseOutcome(input),
      });
    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(outcome.output, { verdict: "pass", summary: "direct", issues: [] });
  } finally {
    process.env.PATH = previousPath;
  }
}));

test("RR-07c staged prompt binding rejects inode, symlink, and FIFO swaps while restored content executes trusted bytes", gate(async (runtime) => {
  const { runDir, record } = createIdentity(runtime, "prompt-binding");
  const diffPath = path.join(runDir, "review.patch"), promptPath = path.join(runDir, "review.prompt.md");
  fs.writeFileSync(diffPath, "diff\n"); fs.writeFileSync(promptPath, "trusted prompt\n");
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: record.contract.done_criteria_path,
    reviewed_sha: record.git.start_sha, current_sha: record.git.start_sha,
    diff_sha256: shaFile(diffPath), prompt_sha256: shaFile(promptPath) };
  const parseOutcome = ({ exitCode, stdoutPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed",
    output: JSON.parse(fs.readFileSync(stdoutPath, "utf8")), summary: "prompt binding" });
  const command = (cwd, value) => ({ command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({prompt:process.argv[1]}))", value], cwd });

  assert.throws(() => runtime.invokeIndependentReviewer({ runDir, request, parseOutcome,
    buildInvocation({ cwd, promptPath: staged, promptBytes }) {
      fs.renameSync(staged, `${staged}.old`); fs.writeFileSync(staged, promptBytes);
      return command(cwd, promptBytes.toString("utf8"));
    } }), /changed after immutable staging/);
  assert.throws(() => runtime.invokeIndependentReviewer({ runDir, request, parseOutcome,
    buildInvocation({ cwd, promptPath: staged, promptBytes }) {
      fs.unlinkSync(staged); fs.symlinkSync(promptPath, staged); return command(cwd, promptBytes.toString("utf8"));
    } }), /symbolic link|exact regular|ELOOP/i);
  assert.throws(() => runtime.invokeIndependentReviewer({ runDir, request, parseOutcome,
    buildInvocation({ cwd, promptPath: staged, promptBytes }) {
      fs.unlinkSync(staged); execFileSync("mkfifo", [staged]); return command(cwd, promptBytes.toString("utf8"));
    } }), /exact regular/i);

  const restored = runtime.invokeIndependentReviewer({ runDir, request, parseOutcome,
    buildInvocation({ cwd, promptPath: staged, promptBytes }) {
      fs.writeFileSync(staged, "attacker bytes\n"); fs.writeFileSync(staged, promptBytes);
      return command(cwd, promptBytes.toString("utf8"));
    } });
  assert.equal(restored.output.prompt, "trusted prompt\n");
  assert.equal(restored.review_binding.executed_prompt_sha256, request.prompt_sha256);
}));

test("RR-07 trusted-local review requires no platform-specific filesystem admission", gate(async (runtime) => {
  assert.equal(typeof runtime.invokeIndependentReviewer, "function");
}));

test("RR-08 Relay explicit merge", gate(async (runtime) => {
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
          { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/json-observer.js") },
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
      operatorAction: { actor: "owner", method: "squash", githubLogin: "relay-bot" },
      currentHead: "c".repeat(40),
      currentDoneCriteriaSha256: verdict.done_criteria_sha256,
      prNumber: 42,
      verdict,
    }));
    assert.throws(() => runtime.planOperatorMerge({
      runDir,
      lockContext,
      freshObservation: fresh.observationCapability,
      operatorAction: { actor: "owner", method: "squash", githubLogin: "relay-bot", operationId: "../../escape" },
      currentHead: head,
      currentDoneCriteriaSha256: verdict.done_criteria_sha256,
      prNumber: 42,
      verdict,
    }), /safe path-independent identifier/);
    assert.equal(fs.existsSync(path.join(path.dirname(runDir), "escape.json")), false);
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
    assert.equal(plan.githubLogin, null);
    assert.equal(fs.existsSync(path.join(runDir, `merge-authorization-${plan.operationId}.json`)), true);
  });
}));

test("RR-09 Relay merge provenance", gate(async (runtime) => {
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
        { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/json-observer.js") },
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
      operatorAction: { actor: "owner", method: "squash", githubLogin: "relay-bot" },
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

test("RR-11 Relay terminal irreversibility", gate(async (runtime) => {
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

test("RR-12 Relay external revalidation", gate(async (runtime) => {
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
        { kind: "staged_file", value: path.resolve(__dirname, "../fixtures/json-observer.js") },
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
