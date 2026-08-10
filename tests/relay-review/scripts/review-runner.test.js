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

async function fixture(label) {
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
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "- file.txt says after\n");
  const criteriaHash = crypto.createHash("sha256").update(fs.readFileSync(criteriaPath)).digest("hex");
  const remote = `local/${path.basename(repo)}`;
  const record = {
    version: 3,
    run_id: runId,
    repo: { root: fs.realpathSync(repo), remote },
    git: { branch: `issue-${label}`, base_branch: "main", worktree: fs.realpathSync(repo), start_sha: startSha },
    contract: { done_criteria_path: criteriaPath, done_criteria_sha256: criteriaHash },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };
  runStore.createRunRecord({ runDir, record });
  const eventsPath = path.join(runDir, "events.jsonl");
  await runtime.withRunLock(runDir, (lockContext) => {
    facts.appendFact({ eventsPath, lockContext, fact: {
      event_id: `pr-${label}`, run_id: runId, type: "pull_request_recorded", at: "2026-08-01T00:01:00.000Z", actor: "codex",
      payload: { pr_number: 42, repo: remote, head_ref: record.git.branch, base_ref: "main", head_sha: head, created_by_relay: true },
    } });
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
    const retryable = review?.payload.verdict === "escalated" && review.payload.escalation_kind === "runtime_failure";
    const action = !review || retryable ? "review" : review.payload.verdict === "lgtm" ? "merge" : review.payload.verdict === "changes_requested" ? "redispatch" : "none";
    const reason = !review ? "review_missing" : retryable ? "review_retryable_escalation" : review.payload.verdict === "escalated" ? "review_escalated" : review.payload.verdict;
    return {
      blockers: [],
      facts: current,
      observations: { github: { pr_number: 42, pr_head_sha: head, pr_state: "OPEN" } },
      derived: { action, head_sha: head, pr_number: 42 },
      recommended_action: {
        kind: action,
        reason,
        key: crypto.createHash("sha256").update(JSON.stringify({
          action, reason, head, pr_number: 42,
          ...(retryable ? { retry_of_event_id: review.event_id } : {}),
        })).digest("hex"),
        steps: [],
        required_inputs: [],
      },
    };
  };
  const cli = runner.parseCli(["--repo", repo, "--run-dir", runDir, "--json"]);
  return { root, repo, runDir, record, startSha, head, tree, criteriaHash, eventsPath, inspectRun, cli };
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
  await assert.rejects(runner.runReview(value.cli, { inspectRun: value.inspectRun, invokeReviewer: async () => { throw new Error("must not run"); } }), /not 'review'/);
  assert.equal(facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").length, 1);
});

test("changes_requested blocks while an invocation failure permits one explicit evidence-bound retry", async () => {
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
  assert.equal(errorResult.recommended_action.reason, "review_retryable_escalation");
  const artifact = JSON.parse(fs.readFileSync(errorResult.review_artifact, "utf8"));
  assert.match(artifact.verdict.summary, /adapter crashed/);
  const retryResult = await runner.runReview(errored.cli, {
    inspectRun: errored.inspectRun,
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "pass", summary: "retry passed", issues: [] }),
  });
  assert.equal(retryResult.round, 2);
  assert.equal(retryResult.verdict, "lgtm");
  assert.equal(retryResult.recommended_action.kind, "merge");
  const reviewFacts = facts.readFacts({ eventsPath: errored.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.deepEqual(reviewFacts.map((fact) => fact.payload.round), [1, 2]);
  assert.equal(reviewFacts[0].payload.review_artifact, errorResult.review_artifact);
});

test("model escalation is durably classified but never authorizes retry", async () => {
  const model = await fixture("model-escalation");
  const modelResult = await runner.runReview(model.cli, {
    inspectRun: model.inspectRun,
    invokeReviewer: async (input) => reviewerSuccess(input, { verdict: "escalated", summary: "model is uncertain", issues: [] }),
  });
  assert.equal(modelResult.recommended_action.kind, "none");
  assert.equal(modelResult.recommended_action.reason, "review_escalated");
  const modelFact = facts.readFacts({ eventsPath: model.eventsPath }).facts.filter((fact) => fact.type === "review_recorded").at(-1);
  assert.equal(modelFact.payload.escalation_kind, "reviewer");
  let modelRetryCalls = 0;
  await assert.rejects(runner.runReview(model.cli, {
    inspectRun: model.inspectRun,
    invokeReviewer: async () => { modelRetryCalls += 1; throw new Error("must not run"); },
  }), (error) => error.code === "REVIEW_ACTION_MISMATCH");
  assert.equal(modelRetryCalls, 0);
});

test("concurrent failing retries append at most one next-round escalation fact", async () => {
  const value = await fixture("retry-race");
  const firstFailure = await runner.runReview(value.cli, {
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
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  const accepted = settled.find((entry) => entry.status === "fulfilled").value;
  assert.equal(accepted.verdict, "escalated");
  assert.notEqual(accepted.recommended_action.key, firstFailure.recommended_action.key);
  assert.equal(settled.find((entry) => entry.status === "rejected").reason.code, "REVIEW_BINDING_CHANGED");
  const reviewFacts = facts.readFacts({ eventsPath: value.eventsPath }).facts.filter((fact) => fact.type === "review_recorded");
  assert.deepEqual(reviewFacts.map((fact) => fact.payload.round), [1, 2]);
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
