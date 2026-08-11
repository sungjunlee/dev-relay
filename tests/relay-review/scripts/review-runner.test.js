"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const relayStatus = require("../../../skills/relay/scripts/relay-status");
const runner = require("../../../skills/relay-review/scripts/review-runner");
const runtime = { withRunLock(runDir, callback) { const canonical = fs.realpathSync(runDir);
  return host.withRunLock({ runDir: canonical, attemptId: `test-${crypto.randomUUID()}`, operation: "review",
    hostKind: "local_supervisor", hostHandle: `test:${process.pid}`, worktreeDir: canonical }, callback); } };
const EXECUTED_RUNTIME = Object.freeze([{ path: process.execPath, dev: 1, ino: 2, size: 3, sha256: "e".repeat(64) }]);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}


function reviewBinding(input) {
  return {
    diff_sha256: input.request.diff_sha256,
    prompt_sha256: input.request.prompt_sha256,
    staged_diff_sha256: input.request.diff_sha256,
    staged_prompt_sha256: input.request.prompt_sha256,
    staged_done_criteria_sha256: crypto.createHash("sha256")
      .update(fs.readFileSync(input.request.done_criteria_path)).digest("hex"),
    request_sha256: "d".repeat(64),
  };
}

function reviewerSuccess(input, output) {
  return { status: "succeeded", output, review_binding: reviewBinding(input), executed_runtime: EXECUTED_RUNTIME };
}

async function fixture(label, { local = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-review-${label}-`)));
  const repo = path.join(root, "repo");
  const runId = `review-${label}`;
  const runDir = path.join(root, runId);
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "review@example.test"]);
  git(repo, ["config", "user.name", "Review Test"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "before\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  const startSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-b", `issue-${label}`]);
  fs.writeFileSync(path.join(repo, "file.txt"), "after\n");
  git(repo, ["commit", "-am", "change"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  let worktree = repo;
  let worktreeBase = null;
  if (local) {
    worktreeBase = path.join(root, "worktrees");
    fs.mkdirSync(worktreeBase);
    git(repo, ["checkout", "main"]);
    worktree = path.join(worktreeBase, `issue-${label}`);
    execFileSync("git", ["-C", repo, "worktree", "add", worktree, `issue-${label}`], { stdio: "ignore" });
  }
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "- file.txt says after\n");
  const criteriaHash = crypto.createHash("sha256").update(fs.readFileSync(criteriaPath)).digest("hex");
  const remote = `local/${path.basename(repo)}`;
  const record = {
    version: 3,
    run_id: runId,
    repo: { root: fs.realpathSync(repo), remote },
    git: { branch: `issue-${label}`, base_branch: "main", worktree: fs.realpathSync(worktree), start_sha: startSha },
    contract: { done_criteria_path: criteriaPath, done_criteria_sha256: criteriaHash },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };
  runStore.createRunRecord({ runDir, record });
  const eventsPath = path.join(runDir, "events.jsonl");
  await runtime.withRunLock(runDir, (lockContext) => {
    if (!local) {
      facts.appendFact({ eventsPath, lockContext, fact: {
        event_id: `pr-${label}`, run_id: runId, type: "pull_request_recorded", at: "2026-08-01T00:01:00.000Z", actor: "codex",
        payload: { pr_number: 42, repo: remote, head_ref: record.git.branch, base_ref: "main", head_sha: head, created_by_relay: true },
      } });
    }
    facts.appendFact({ eventsPath, lockContext, fact: {
      event_id: `verify-${label}`, run_id: runId, type: "verification_recorded", at: "2026-08-01T00:02:00.000Z", actor: "codex",
      payload: {
        head_sha: head, tree_sha: tree, done_criteria_sha256: criteriaHash, command: "node --test",
        verification_request_sha256: "a".repeat(64), declared_command_count: 1, completed_command_count: 1,
        result_path: path.join(runDir, "verification.txt"), result_sha256: "b".repeat(64), exit_code: 0,
        status: "passed", operator: "codex",
      },
    } });
  });
  const inspectRun = async () => {
    const current = facts.readFacts({ eventsPath }).facts;
    const review = current.filter((fact) => fact.type === "review_recorded").at(-1);
    const retryable = review?.payload?.verdict === "escalated"
      && review.payload.escalation_kind === "runtime_failure"
      && review.payload.retry_of_event_id === undefined;
    const exhausted = review?.payload?.verdict === "escalated"
      && review.payload.escalation_kind === "runtime_failure"
      && review.payload.retry_of_event_id !== undefined;
    const action = !review ? "review" : review.payload.verdict === "lgtm" ? (local ? "recover" : "merge")
      : review.payload.verdict === "changes_requested" ? "redispatch"
        : retryable ? "review" : "none";
    return {
      blockers: [],
      snapshot: { run_sha256: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex") },
      facts: current,
      observations: local
        ? { git: { local_delivery: true, head_sha: head, tree_sha: tree, reviewable_dirty: false }, github: {} }
        : { github: { pr_number: 42, pr_head_sha: head, pr_state: "OPEN" } },
      derived: { action, head_sha: head, pr_number: local ? null : 42, retry_of_event_id: retryable ? review.event_id : null },
      recommended_action: { kind: action, reason: retryable ? "review_retryable_escalation" : exhausted ? "review_escalated_retry_exhausted" : review?.payload?.verdict === "escalated" ? "review_escalated" : review ? review.payload.verdict : "review_missing", key: "c".repeat(64), steps: [], required_inputs: [] },
    };
  };
  const cli = runner.parseCli(["--repo", worktree, "--run-dir", runDir, "--json"]);
  return { root, repo: worktree, repoRoot: repo, worktreeBase, runDir, record, startSha, head, tree, criteriaHash, eventsPath, inspectRun, cli };
}

test("Relay runner records one exact-SHA pass and the derived action advances to merge", async () => {
  const value = await fixture("pass");
  let calls = 0;
  let captured;
  const result = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    async invokeReviewer(input) {
      calls += 1;
      captured = input;
      return reviewerSuccess(input, { verdict: "pass", summary: "all criteria met", issues: [] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.verdict, "lgtm");
  assert.equal(result.reviewed_sha, value.head);
  assert.equal(result.done_criteria_sha256, value.criteriaHash);
  assert.equal(result.recommended_action.kind, "merge");
  assert.equal(captured.request.reviewed_sha, value.head);
  assert.equal(captured.request.current_sha, value.head);
  const rawDiff = execFileSync("git", ["-C", value.repo, "diff", "--binary", "--no-ext-diff",
    `${value.startSha}..${value.head}`, "--"], { encoding: "utf8" });
  const exactDiff = Buffer.from(`${rawDiff}${rawDiff.endsWith("\n") || !rawDiff ? "" : "\n"}`, "utf8");
  assert.equal(captured.request.diff_sha256, crypto.createHash("sha256").update(exactDiff).digest("hex"));
  assert.deepEqual(fs.readFileSync(captured.request.diff_path), exactDiff);
  assert.deepEqual(Object.keys(captured.credentialRequest.env), [], "ambient environment must not cross the reviewer boundary");
  const prompt = fs.readFileSync(captured.request.prompt_path, "utf8");
  const verificationPrefix = "Verification fact: ";
  const verificationLine = prompt.split("\n").find((line) => line.startsWith(verificationPrefix));
  assert.ok(verificationLine, "captured review prompt must include the verification input");
  const capturedVerification = JSON.parse(verificationLine.slice(verificationPrefix.length));
  assert.equal(capturedVerification.payload.head_sha, value.head);
  assert.equal(capturedVerification.payload.tree_sha, value.tree);
  assert.equal(capturedVerification.payload.done_criteria_sha256, value.criteriaHash);
  assert.match(prompt, /Frozen Done Criteria/);
  assert.match(prompt, /file\.txt says after/);
  assert.match(prompt, /Exact review diff/);
  assert.doesNotMatch(prompt, /dispatch prompt|executor transcript|session id/i);
  const reviews = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].payload.round, 1);
  assert.equal(reviews[0].payload.override, null);
  assert.match(reviews[0].payload.executed_runtime.digest, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(reviews[0].payload.review_artifact), true);
  const artifact = JSON.parse(fs.readFileSync(reviews[0].payload.review_artifact, "utf8"));
  assert.equal(artifact.schema_version, 2); assert.deepEqual(artifact.executed_runtime, reviews[0].payload.executed_runtime);
  assert.deepEqual(Object.keys(artifact), [
    "schema_version", "run_id", "round", "reviewer", "reviewed_sha",
    "done_criteria_sha256", "diff_sha256", "prompt_sha256",
    "staging_request_sha256", "executed_runtime", "verdict",
  ], "GitHub schema-v2 artifact bytes retain their historical field order and shape");
  assert.deepEqual(
    fs.readFileSync(reviews[0].payload.review_artifact),
    Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`),
  );
  await assert.rejects(runner.runReview(value.cli, { inspectRun: value.inspectRun, invokeReviewer: async () => { throw new Error("must not run"); } }), /not 'review'/);
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 1);
});

test("#1208 production-shaped no-origin review records the exact verification projection", async () => {
  const value = await fixture("local-pass", { local: true });
  let activeReviewLock = null;
  const result = await runner.runReview(value.cli, {
    inspectRun: (input) => recovery.inspectProductionRun({ ...input, activeRunLock: activeReviewLock }),
    withRunLock: (runDir, callback) => runtime.withRunLock(runDir, async (lockContext) => {
      activeReviewLock = lockContext;
      try { return await callback(lockContext); }
      finally { activeReviewLock = null; }
    }),
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "pass", summary: "local exact subject", issues: [] }),
  });
  assert.equal(result.pr_number, null);
  assert.equal(result.recommended_action.kind, "recover");
  const review = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").at(-1);
  const artifact = JSON.parse(fs.readFileSync(review.payload.review_artifact, "utf8"));
  assert.equal(artifact.verification_event_id, "verify-local-pass");
  assert.equal(artifact.run_sha256, crypto.createHash("sha256").update(JSON.stringify(value.record)).digest("hex"));
  assert.equal(Object.hasOwn(artifact, "base_sha"), false);
  assert.equal(Object.hasOwn(artifact, "tree_sha"), false);

  const inspected = await recovery.inspectProductionRun({ runDir: value.runDir });
  assert.equal(inspected.recommended_action.reason, "reviewed_result_ready");
  const ghMarker = path.join(value.root, "gh-called");
  const failingGh = path.join(value.root, "fail-gh.js");
  fs.writeFileSync(failingGh, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(ghMarker)}, 'called'); process.exit(91);\n`);
  fs.chmodSync(failingGh, 0o755);
  const recoverArgs = [
    path.join(__dirname, "../../../skills/relay/scripts/relay-recover.js"),
    "recover", "--run-dir", value.runDir, "--actor", "codex",
    "--reason", "close exact reviewed local result",
    "--expected-action-key", inspected.recommended_action.key, "--json",
  ];
  const recoverOptions = { encoding: "utf8", env: {
    ...process.env, RELAY_WORKTREE_BASE: value.worktreeBase, RELAY_GH_BIN: failingGh,
  } };
  const cliResult = spawnSync(process.execPath, recoverArgs, recoverOptions);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  const recovered = JSON.parse(cliResult.stdout);
  assert.equal(recovered.status, "converged");
  assert.equal(recovered.after.derived.terminal, true);
  assert.equal(recovered.after.derived.reason, "reviewed_result_ready");
  const closes = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "run_closed");
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].payload, {
    reason: "reviewed_result_ready", operator: "codex", last_sha: value.head, pr_number: null,
  });
  assert.equal(fs.existsSync(ghMarker), false, "local reviewed-result close must not invoke GitHub");
  const receiptPath = fs.readdirSync(value.runDir).map((name) => path.join(value.runDir, name))
    .find((filePath) => path.basename(filePath).startsWith("recovery-receipt-"));
  const receiptBytes = fs.readFileSync(receiptPath);
  const retry = spawnSync(process.execPath, recoverArgs, recoverOptions);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, "noop");
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "run_closed").length, 1);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytes);
  assert.equal(fs.existsSync(ghMarker), false);

  git(value.repo, ["checkout", "-b", "after-reviewed-close"]);
  const drifted = await recovery.inspectProductionRun({ runDir: value.runDir });
  assert.equal(drifted.derived.reason, "reviewed_result_ready");
  assert.equal(drifted.derived.terminal, true);
  assert.ok(drifted.derived.diagnostics.some((entry) => entry.code === "terminal_live_branch_diverged"));
  const row = relayStatus.statusRow(value.record, value.runDir, drifted);
  assert.equal(row.terminal, true);
  assert.equal(row.reason, "reviewed_result_ready");
  assert.equal(row.local_delivery, true);
});

test("#1208 production observation still rejects a nonterminal worktree branch mismatch", async () => {
  const value = await fixture("local-branch-mismatch", { local: true });
  git(value.repo, ["checkout", "-b", "wrong-before-close"]);
  await assert.rejects(
    recovery.inspectProductionRun({ runDir: value.runDir }),
    /does not match run identity/,
  );
});

test("#1208 canonical fold alone controls reviewed-close branch exceptions before transports", async () => {
  for (const mode of ["invalid", "retroactive", "duplicate", "run-id", "actor-mismatch"]) {
    const value = await fixture(`local-forged-${mode}`, { local: true });
    const close = {
      event_id: `close-${mode}`, run_id: value.record.run_id, type: "run_closed",
      at: "2026-08-01T00:04:00.000Z", actor: mode === "actor-mismatch" ? "other-actor" : "codex",
      payload: { reason: "reviewed_result_ready", operator: "codex", last_sha: value.head, pr_number: null },
    };
    const executable = EXECUTED_RUNTIME[0];
    const review = {
      event_id: `review-${mode}`, run_id: value.record.run_id, type: "review_recorded",
      at: "2026-08-01T00:03:00.000Z", actor: "codex",
      payload: {
        round: 1, verdict: mode === "invalid" ? "changes_requested" : "lgtm",
        reviewed_sha: value.head, done_criteria_sha256: value.criteriaHash,
        reviewer: "codex", review_artifact: path.join(value.runDir, "forged-review.json"),
        executed_runtime: {
          digest: crypto.createHash("sha256").update(JSON.stringify(EXECUTED_RUNTIME)).digest("hex"),
          executable: { ...executable },
        },
        override: null,
      },
    };
    await runtime.withRunLock(value.runDir, (lockContext) => {
      const ordered = mode === "retroactive" ? [close, review] : [review, close];
      for (const fact of ordered) facts.appendFact({ eventsPath: value.eventsPath, lockContext, fact });
    });
    if (mode === "duplicate") {
      const firstFact = JSON.parse(fs.readFileSync(value.eventsPath, "utf8").trim().split("\n")[0]);
      fs.appendFileSync(value.eventsPath, `${JSON.stringify({
        ...firstFact, at: "2026-08-01T00:09:00.000Z",
      })}\n`);
    }
    if (mode === "run-id") {
      fs.appendFileSync(value.eventsPath, `${JSON.stringify({
        ...close, event_id: "foreign-run-fact", run_id: "different-run",
      })}\n`);
    }
    git(value.repo, ["checkout", "-b", `wrong-${mode}`]);
    const transportMarker = path.join(value.root, "transport-called");
    const ghMarker = path.join(value.root, "gh-called");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitTrap = path.join(value.root, "git-trap.js");
    const ghTrap = path.join(value.root, "gh-trap.js");
    fs.writeFileSync(gitTrap, `#!/usr/bin/env node
const fs=require('fs'),{spawnSync}=require('child_process'),a=process.argv.slice(2);
if(a.some((v)=>['ls-remote','push','fetch'].includes(v))){fs.writeFileSync(${JSON.stringify(transportMarker)},'called');process.exit(97)}
const r=spawnSync(${JSON.stringify(realGit)},a,{encoding:null});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exit(r.status??1);
`);
    fs.writeFileSync(ghTrap, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(ghMarker)},'called');process.exit(98);\n`);
    fs.chmodSync(gitTrap, 0o755); fs.chmodSync(ghTrap, 0o755);
    const previousGit = process.env.RELAY_GIT_BIN, previousGh = process.env.RELAY_GH_BIN;
    process.env.RELAY_GIT_BIN = gitTrap; process.env.RELAY_GH_BIN = ghTrap;
    try {
      if (mode === "actor-mismatch") {
        const inspected = await recovery.inspectProductionRun({ runDir: value.runDir });
        assert.equal(inspected.derived.reason, "reviewed_result_ready");
        assert.equal(inspected.derived.terminal, true);
      } else {
        await assert.rejects(
          recovery.inspectProductionRun({ runDir: value.runDir }),
          mode === "duplicate" ? /duplicate event_id/
            : mode === "run-id" ? /does not match immutable run_id/
              : /does not match run identity/,
          mode,
        );
      }
    } finally {
      if (previousGit === undefined) delete process.env.RELAY_GIT_BIN; else process.env.RELAY_GIT_BIN = previousGit;
      if (previousGh === undefined) delete process.env.RELAY_GH_BIN; else process.env.RELAY_GH_BIN = previousGh;
    }
    assert.equal(fs.existsSync(transportMarker), false, mode);
    assert.equal(fs.existsSync(ghMarker), false, mode);
  }
});

test("#1208 canonical local close refuses a tampered content-addressed review artifact without a terminal fact", async () => {
  const value = await fixture("local-tamper", { local: true });
  const result = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "pass", summary: "bound before tamper", issues: [] }),
  });
  const inspection = await recovery.inspectProductionRun({ runDir: value.runDir });
  fs.appendFileSync(result.review_artifact, " \n");
  await assert.rejects(recovery.recoverProductionRun({
    runDir: value.runDir,
    actor: "codex",
    reason: "must reject tampered artifact",
    expectedActionKey: inspection.recommended_action.key,
    activeCheckout: value.repoRoot,
    relayWorktreeBase: value.worktreeBase,
  }), /content digest/);
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "run_closed").length, 0);
});

test("#1208 canonical local close rejects missing, escaped, and symlinked review artifacts", async () => {
  for (const mode of [
    "missing", "outside", "ancestor-symlink", "review-symlink", "diff-symlink", "prompt-symlink",
  ]) {
    const value = await fixture(`local-${mode}`, { local: true });
    const result = await runner.runReview(value.cli, {
      inspectRun: value.inspectRun,
      invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "pass", summary: "artifact boundary", issues: [] }),
    });
    if (mode === "missing") {
      fs.unlinkSync(result.review_artifact);
    } else if (mode === "outside") {
      const outside = path.join(value.root, path.basename(result.review_artifact));
      fs.copyFileSync(result.review_artifact, outside);
      const journal = fs.readFileSync(value.eventsPath, "utf8");
      fs.writeFileSync(value.eventsPath, journal.replace(result.review_artifact, outside));
    } else if (mode === "ancestor-symlink") {
      const inputRoot = path.join(value.runDir, "review-inputs");
      const moved = path.join(value.root, "moved-review-inputs");
      fs.renameSync(inputRoot, moved);
      fs.symlinkSync(moved, inputRoot, "dir");
    } else if (mode === "review-symlink") {
      const outside = path.join(value.root, "same-byte-review.json");
      fs.copyFileSync(result.review_artifact, outside);
      fs.unlinkSync(result.review_artifact);
      fs.symlinkSync(outside, result.review_artifact);
    } else {
      const inputRoot = path.join(value.runDir, "review-inputs");
      const prefix = mode === "diff-symlink" ? "diff-" : "prompt-";
      const inputPath = path.join(inputRoot, fs.readdirSync(inputRoot).find((name) => name.startsWith(prefix)));
      const outside = path.join(value.root, `same-byte-${path.basename(inputPath)}`);
      fs.copyFileSync(inputPath, outside);
      fs.unlinkSync(inputPath);
      fs.symlinkSync(outside, inputPath);
    }
    const inspection = await recovery.inspectProductionRun({ runDir: value.runDir });
    await assert.rejects(recovery.recoverProductionRun({
      runDir: value.runDir,
      actor: "codex",
      reason: `must reject ${mode} artifact`,
      expectedActionKey: inspection.recommended_action.key,
      activeCheckout: value.repoRoot,
      relayWorktreeBase: value.worktreeBase,
    }), mode === "missing" ? /missing/
      : mode === "outside" ? /outside the canonical run artifact surface/
        : mode === "ancestor-symlink" ? /canonical non-symlink directory/
          : /canonical regular non-symlink file/);
    assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "run_closed").length, 0);
  }
});

test("#1208 review action binding accepts only fresh clean local Git and the latest exact verification", () => {
  const head = "a".repeat(40);
  const tree = "b".repeat(40);
  const criteriaHash = "c".repeat(64);
  const record = { roles: { reviewer: "claude" }, contract: { done_criteria_sha256: criteriaHash } };
  const verification = {
    event_id: "verification-local",
    type: "verification_recorded",
    payload: {
      status: "passed", exit_code: 0, head_sha: head, tree_sha: tree,
      done_criteria_sha256: criteriaHash,
    },
  };
  const inspection = {
    blockers: [],
    facts: [verification],
    observations: { git: { local_delivery: true, head_sha: head, tree_sha: tree, reviewable_dirty: false } },
    derived: { action: "review", head_sha: head },
    recommended_action: { kind: "review", reason: "review_missing" },
  };
  const binding = runner.requireReviewAction(inspection, record);
  assert.equal(binding.local, true);
  assert.equal(binding.head, head);
  assert.equal(binding.tree, tree);
  assert.equal(binding.prNumber, null);
  assert.equal(binding.verification.event_id, "verification-local");

  const stale = structuredClone(inspection);
  stale.facts.push({ ...verification, event_id: "verification-failed", payload: { ...verification.payload, status: "failed", exit_code: 1 } });
  assert.throws(() => runner.requireReviewAction(stale, record), /latest passing verification/);

  const withPr = structuredClone(inspection);
  withPr.facts.push({ type: "pull_request_recorded", payload: {} });
  assert.throws(() => runner.requireReviewAction(withPr, record), /durable PR fact/);
});

test("changes_requested and invocation error are durable blocking review facts", async () => {
  const changed = await fixture("changes");
  const changedResult = await runner.runReview(changed.cli, {
    inspectRun: changed.inspectRun,
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "changes_requested", summary: "bug", issues: [{ title: "Bug", body: "Fix it", file: "file.txt", line: 1, severity: "high" }] }),
  });
  assert.equal(changedResult.verdict, "changes_requested");
  assert.equal(changedResult.recommended_action.kind, "redispatch");

  const errored = await fixture("error");
  const errorResult = await runner.runReview(errored.cli, {
    inspectRun: errored.inspectRun,
    invokeReviewer: async (input) => {
      const error = new Error("adapter crashed");
      error.review_binding = reviewBinding(input);
      error.executed_runtime = EXECUTED_RUNTIME;
      throw error;
    },
  });
  assert.equal(errorResult.verdict, "escalated");
  assert.equal(errorResult.recommended_action.kind, "review");
  const artifact = JSON.parse(fs.readFileSync(errorResult.review_artifact, "utf8"));
  assert.match(artifact.verdict.summary, /adapter crashed/);
  const errorFacts = facts.readFacts({ eventsPath: errored.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.equal(errorFacts[0].payload.escalation_kind, "runtime_failure");
});

test("a runtime escalation permits one explicitly bound retry, then fails closed", async () => {
  const value = await fixture("retry");
  let calls = 0;
  const first = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    async invokeReviewer(input) {
      calls += 1;
      const error = new Error("transient transport failure");
      error.review_binding = reviewBinding(input);
      error.executed_runtime = EXECUTED_RUNTIME;
      throw error;
    },
  });
  assert.equal(first.recommended_action.kind, "review");
  const firstFact = facts.readFacts({ eventsPath: value.eventsPath }).facts.at(-1);

  const second = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    async invokeReviewer(input) {
      calls += 1;
      assert.equal(input.request.retry_of_event_id, firstFact.event_id);
      return reviewerSuccess(input, { verdict: "pass", summary: "retry passed", issues: [] });
    },
  });
  assert.equal(second.verdict, "lgtm");
  assert.equal(second.recommended_action.kind, "merge");
  const reviewFacts = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.equal(reviewFacts.length, 2);
  assert.equal(reviewFacts[1].payload.retry_of_event_id, firstFact.event_id);

  await assert.rejects(runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async () => { throw new Error("must not retry a passed retry"); },
  }), /not 'review'/);

  const exhausted = await fixture("retry-exhausted");
  let exhaustedCalls = 0;
  await runner.runReview(exhausted.cli, {
    inspectRun: exhausted.inspectRun,
    async invokeReviewer(input) {
      exhaustedCalls += 1;
      const error = new Error("first transient failure");
      error.review_binding = reviewBinding(input);
      error.executed_runtime = EXECUTED_RUNTIME;
      throw error;
    },
  });
  const retryFailure = await runner.runReview(exhausted.cli, {
    inspectRun: exhausted.inspectRun,
    async invokeReviewer(input) {
      exhaustedCalls += 1;
      assert.equal(input.request.retry_of_event_id, facts.readFacts({ eventsPath: exhausted.eventsPath }).facts.at(-1).event_id);
      const error = new Error("second transient failure");
      error.review_binding = reviewBinding(input);
      error.executed_runtime = EXECUTED_RUNTIME;
      throw error;
    },
  });
  assert.equal(retryFailure.recommended_action.kind, "none");
  assert.equal(retryFailure.recommended_action.reason, "review_escalated_retry_exhausted");
  await assert.rejects(runner.runReview(exhausted.cli, {
    inspectRun: exhausted.inspectRun,
    invokeReviewer: async () => { throw new Error("unbounded retry"); },
  }), /derived lifecycle action is 'none'/);
  assert.equal(calls, 2);
  assert.equal(exhaustedCalls, 2);
});

test("concurrent failing retries append exactly one second-round fact", async () => {
  const value = await fixture("retry-race");
  await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async (input) => {
      const error = new Error("temporary provider failure");
      error.review_binding = reviewBinding(input);
      error.executed_runtime = EXECUTED_RUNTIME;
      throw error;
    },
  });
  let arrivals = 0;
  let release;
  const bothInvoked = new Promise((resolve) => { release = resolve; });
  const invokeReviewer = async (input) => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothInvoked;
    const error = new Error("provider remains unavailable");
    error.review_binding = reviewBinding(input);
    error.executed_runtime = EXECUTED_RUNTIME;
    throw error;
  };
  let lockTail = Promise.resolve();
  const withRunLock = (runDir, callback) => {
    const turn = lockTail.then(() => runtime.withRunLock(runDir, callback));
    lockTail = turn.catch(() => {});
    return turn;
  };
  const settled = await Promise.allSettled([
    runner.runReview(value.cli, { inspectRun: value.inspectRun, invokeReviewer, withRunLock }),
    runner.runReview(value.cli, { inspectRun: value.inspectRun, invokeReviewer, withRunLock }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.find((entry) => entry.status === "rejected").reason.code, "REVIEW_BINDING_CHANGED");
  const reviewFacts = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.deepEqual(reviewFacts.map((fact) => fact.payload.round), [1, 2]);
});

test("model-returned escalation is classified as reviewer uncertainty and is not retryable", async () => {
  const value = await fixture("model-escalation");
  const result = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "escalated", summary: "evidence is ambiguous", issues: [] }),
  });
  assert.equal(result.recommended_action.kind, "none");
  assert.equal(result.recommended_action.reason, "review_escalated");
  const review = facts.readFacts({ eventsPath: value.eventsPath }).facts.at(-1);
  assert.equal(review.payload.escalation_kind, "reviewer");
  await assert.rejects(runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async () => { throw new Error("must not retry model escalation"); },
  }), /'none', not 'review'/);
});

test("malformed reviewer output is durably non-retryable reviewer escalation", async () => {
  const value = await fixture("malformed-review-output");
  let calls = 0;
  const result = await runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async (input) => {
      calls += 1;
      return reviewerSuccess(input, { verdict: "pass", summary: "ok", issues: [], unexpected: true });
    },
  });
  assert.equal(result.verdict, "escalated");
  assert.equal(result.recommended_action.kind, "none");
  assert.equal(result.recommended_action.reason, "review_escalated");
  const reviews = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].payload.escalation_kind, "reviewer");
  const artifact = JSON.parse(fs.readFileSync(reviews[0].payload.review_artifact, "utf8"));
  assert.equal(artifact.verdict.verdict, "escalated");
  assert.match(artifact.verdict.summary, /invalid/i);
  await assert.rejects(runner.runReview(value.cli, {
    inspectRun: value.inspectRun,
    invokeReviewer: async () => { calls += 1; throw new Error("must not retry malformed output"); },
  }), /'none', not 'review'/);
  assert.equal(calls, 1);
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 1);
});

test("nonzero invocation failures stay retryable while output protocol mismatches do not", async () => {
  for (const [reason, expectedKind, expectedAction] of [
    ["cli_nonzero_exit", "runtime_failure", "review"],
    ["output_protocol_mismatch", "reviewer", "none"],
  ]) {
    const value = await fixture(`failure-classification-${reason}`);
    const result = await runner.runReview(value.cli, {
      inspectRun: value.inspectRun,
      async invokeReviewer(input) {
        const error = new Error(`review failed: ${reason}`);
        error.failure_reason = reason;
        error.failure_signals = ["output_protocol"];
        error.review_binding = reviewBinding(input);
        error.executed_runtime = EXECUTED_RUNTIME;
        throw error;
      },
    });
    assert.equal(result.recommended_action.kind, expectedAction);
    const review = facts.readFacts({ eventsPath: value.eventsPath }).facts.at(-1);
    assert.equal(review.payload.escalation_kind, expectedKind);
  }
});

test("review persistence rejects missing or malformed executed runtime evidence", async () => {
  for (const mode of ["missing", "malformed"]) {
    const value = await fixture(`runtime-${mode}`);
    await assert.rejects(runner.runReview(value.cli, { inspectRun: value.inspectRun, invokeReviewer: async (input) => {
      const outcome = reviewerSuccess(input, { verdict: "pass", summary: "ok", issues: [] });
      if (mode === "missing") delete outcome.executed_runtime; else outcome.executed_runtime = [{ ...EXECUTED_RUNTIME[0], sha256: "bad" }]; return outcome;
    } }), /runtime binding/);
    assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);
  }
});

test("initial run snapshot must be valid and match resolved run.json before invocation", async () => {
  for (const mode of ["missing", "malformed", "mismatch"]) {
    const value = await fixture(`initial-snapshot-${mode}`);
    let reviewerCalls = 0;
    await assert.rejects(runner.runReview(value.cli, {
      async inspectRun(input) {
        const inspection = await value.inspectRun(input);
        if (mode === "missing") delete inspection.snapshot.run_sha256;
        else inspection.snapshot.run_sha256 = mode === "malformed" ? "bad" : "f".repeat(64);
        return inspection;
      },
      invokeReviewer: async () => { reviewerCalls += 1; throw new Error("must not run"); },
    }), (error) => error.code === "RUN_RECORD_BINDING_CHANGED");
    assert.equal(reviewerCalls, 0);
    assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);
  }
});

test("fresh run snapshot drift rejects the append", async () => {
  const value = await fixture("fresh-snapshot-drift");
  let inspections = 0;
  await assert.rejects(runner.runReview(value.cli, {
    async inspectRun(input) {
      const inspection = await value.inspectRun(input);
      inspections += 1;
      if (inspections === 2) inspection.snapshot.run_sha256 = "f".repeat(64);
      return inspection;
    },
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "pass", summary: "ok", issues: [] }),
  }), (error) => error.code === "RUN_RECORD_CHANGED");
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);
});

test("immutable reviewer binding and closed CLI reject legacy policy surfaces", async () => {
  const value = await fixture("binding");
  const credentialCli = runner.parseCli(["--repo", value.repo, "--run-dir", value.runDir,
    "--credential-env", "OPENAI_API_KEY", "--credential-file", `auth=${path.join(value.root, "auth.json")}`]);
  assert.deepEqual(credentialCli.values["credential-env"], ["OPENAI_API_KEY"]);
  assert.deepEqual(credentialCli.values["credential-file"], [`auth=${path.join(value.root, "auth.json")}`]);
  const override = runner.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--reviewer", "claude"]);
  await assert.rejects(runner.runReview(override, { inspectRun: value.inspectRun }), /immutable binding/);
  assert.throws(() => runner.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--review-budget", "3"]), /Unknown option/);
  assert.throws(() => runner.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--review-file", "verdict.json"]), /Unknown option/);
  assert.throws(() => runner.normalizeVerdict({ verdict: "pass", summary: "ok", issues: [], score: 10 }), /unknown or missing/);
  assert.throws(() => runner.normalizeVerdict({ verdict: "changes_requested", summary: "bug", issues: [] }), /requires at least one issue/);
  assert.throws(() => runner.normalizeVerdict({ verdict: "pass", summary: "ok", issues: [{ title: "bug", body: "bad", file: null, line: null, severity: "high" }] }), /cannot contain issues/);
});

test("review help distinguishes model/tool policy from enabled provider transport", () => {
  const cli = require.resolve("../../../skills/relay-review/scripts/review-runner");
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model\/tool network policy/);
  assert.match(result.stdout, /provider transport remains enabled/);
});

test("Done Criteria bytes are hash-checked before review and again under the append lock", async () => {
  const beforeReview = await fixture("criteria-before");
  let inspected = false;
  await assert.rejects(runner.runReview(beforeReview.cli, {
    async inspectRun(input) {
      const inspection = await beforeReview.inspectRun(input);
      if (!inspected) {
        inspected = true;
        fs.writeFileSync(beforeReview.record.contract.done_criteria_path, "tampered before review\n");
      }
      return inspection;
    },
    invokeReviewer: async () => { throw new Error("must not run"); },
  }), /do not match the immutable run contract/);
  fs.writeFileSync(beforeReview.record.contract.done_criteria_path, "- file.txt says after\n");
  assert.equal(facts.readFacts({ eventsPath: beforeReview.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);

  const beforeAppend = await fixture("criteria-append");
  await assert.rejects(runner.runReview(beforeAppend.cli, {
    inspectRun: beforeAppend.inspectRun,
    async invokeReviewer(input) {
      fs.writeFileSync(beforeAppend.record.contract.done_criteria_path, "tampered before append\n");
      return reviewerSuccess(input, { verdict: "pass", summary: "ok", issues: [] });
    },
  }), /frozen Done Criteria bytes do not match run\.json/);
  fs.writeFileSync(beforeAppend.record.contract.done_criteria_path, "- file.txt says after\n");
  assert.equal(facts.readFacts({ eventsPath: beforeAppend.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);
});

test("a prompt or diff swap after staging cannot be bound to the reviewer verdict", async () => {
  for (const field of ["prompt_path", "diff_path"]) {
    const value = await fixture(`swap-${field}`);
    await assert.rejects(runner.runReview(value.cli, {
      inspectRun: value.inspectRun,
      async invokeReviewer(input) {
        const outcome = reviewerSuccess(input, { verdict: "pass", summary: "ok", issues: [] });
        fs.writeFileSync(input.request[field], `swapped ${field}\n`);
        return outcome;
      },
    }), /exact staged prompt and diff/);
    assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 0);
  }
});
