"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const { inspectRun, recoverRun } = recovery;

const START = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const TARGET = "d".repeat(40);
const HASH = "e".repeat(64);

function runRecord(runId = "issue-1135-test") {
  return {
    version: 3,
    run_id: runId,
    repo: { root: "/repo", remote: "owner/repo" },
    git: { branch: "issue-1135", base_branch: "main", worktree: "/repo/wt", start_sha: START },
    contract: { done_criteria_path: "/run/done.md", done_criteria_sha256: HASH },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function harness({ facts = [], observations = {}, record = runRecord() } = {}) {
  const state = {
    facts: structuredClone(facts),
    observations: structuredClone(observations),
    effects: [],
    receipts: new Map(),
    intent: null,
    writes: 0,
  };
  const readSnapshot = async () => ({
    runDir: "/run",
    runRecord: record,
    facts: structuredClone(state.facts),
    snapshot: {
      run_sha256: digest(record),
      facts_sha256: digest(state.facts),
      fact_count: state.facts.length,
      last_event_id: state.facts.at(-1)?.event_id || null,
      tail_status: "complete",
    },
  });
  const observer = async () => structuredClone(state.observations);
  const appendFact = async (fact) => {
    const existing = state.facts.find((entry) => entry.event_id === fact.event_id);
    if (!existing) state.facts.push(structuredClone(fact));
  };
  return {
    state,
    readSnapshot,
    observer,
    appendFact,
    withLock: async (callback) => callback(),
    readIntent: async () => (
      state.intent && !state.receipts.has(state.intent.action_key)
        ? structuredClone(state.intent)
        : null
    ),
    writeIntent: async ({ intent }) => {
      if (state.intent && !state.receipts.has(state.intent.action_key)
        && JSON.stringify(state.intent) !== JSON.stringify(intent)) {
        throw new Error("intent conflict");
      }
      state.intent = structuredClone(intent);
    },
    readReceipt: async ({ actionKey }) => state.receipts.get(actionKey) || null,
    writeReceipt: async ({ actionKey, receipt }) => {
      state.writes += 1;
      state.receipts.set(actionKey, structuredClone(receipt));
    },
  };
}

function attemptFinished(verificationStatus = "not_declared") {
  return {
    event_id: "attempt-finished",
    run_id: "issue-1135-test",
    attempt_id: "attempt-1",
    type: "attempt_finished",
    at: "2026-08-01T00:01:00Z",
    actor: "codex",
    payload: {
      status: "completed",
      start_sha: START,
      final_sha: HEAD,
      tree_sha: TREE,
      result_path: "/run/result.txt",
      exit_code: 0,
      verification_status: verificationStatus,
    },
  };
}

function closedFact() {
  return {
    event_id: "closed",
    run_id: "issue-1135-test",
    type: "run_closed",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: { reason: "done", operator: "owner", last_sha: HEAD, pr_number: null },
  };
}

function pullRequestFact(headSha = START) {
  return {
    event_id: `pr-${headSha.slice(0, 4)}`,
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42,
      repo: "owner/repo",
      head_ref: "issue-1135",
      base_ref: "main",
      head_sha: headSha,
      created_by_relay: true,
    },
  };
}

function verificationFact() {
  return {
    event_id: "verification-review",
    run_id: "issue-1135-test",
    type: "verification_recorded",
    at: "2026-08-01T00:03:00Z",
    actor: "owner",
    payload: {
      head_sha: HEAD, tree_sha: TREE, done_criteria_sha256: HASH,
      command: "node --test", verification_request_sha256: "f".repeat(64),
      declared_command_count: 1, completed_command_count: 1,
      result_path: "/run/verification.log", result_sha256: "f".repeat(64),
      exit_code: 0, status: "passed", operator: "owner",
    },
  };
}

function reviewFact({ eventId, verdict = "escalated", escalationKind, retryOfEventId, resolutionOfEventId, baseSha } = {}) {
  return {
    event_id: eventId,
    run_id: "issue-1135-test",
    type: "review_recorded",
    at: "2026-08-01T00:04:00Z",
    actor: "claude",
    payload: {
      round: retryOfEventId ? 2 : 1,
      verdict,
      reviewed_sha: HEAD,
      ...(baseSha ? { base_sha: baseSha } : {}),
      done_criteria_sha256: HASH,
      reviewer: "claude",
      review_artifact: "/run/review.json",
      ...(escalationKind ? { escalation_kind: escalationKind } : {}),
      ...(retryOfEventId ? { retry_of_event_id: retryOfEventId } : {}),
      ...(resolutionOfEventId ? { resolution_of_event_id: resolutionOfEventId } : {}),
      override: null,
    },
  };
}

function resolutionFact({ eventId, reviewEventId, disposition = "re_review", actor = "owner" }) {
  return {
    event_id: eventId,
    run_id: "issue-1135-test",
    type: "review_escalation_resolved",
    at: "2026-08-01T00:05:00Z",
    actor,
    payload: {
      actor, reason: "operator adjudication", disposition,
      escalated_review_event_id: reviewEventId,
    },
  };
}

function publicationObservations(overrides = {}) {
  return {
    git: {
      head_sha: HEAD,
      tree_sha: TREE,
      branch_commit_exists: true,
      reviewable_work: true,
      reviewable_dirty: false,
      remote_head_sha: null,
      remote_relation: "behind_local",
    },
    github: {
      available: true,
      pr_lookup_complete: true,
      matching_pr_count: 0,
      repo: "owner/repo",
      pr_number: null,
      pr_state: null,
      head_ref: "issue-1135",
      base_ref: "main",
      pr_head_sha: null,
      merge_sha: null,
    },
    host: { live: false },
    verification: { pending: false },
    ...overrides,
  };
}

function localObservations(overrides = {}) {
  return {
    git: {
      local_delivery: true,
      head_sha: HEAD,
      tree_sha: TREE,
      branch_commit_exists: true,
      reviewable_work: true,
      reviewable_dirty: false,
      remote_name: null,
      remote_url: null,
      remote_head_sha: null,
      remote_relation: null,
    },
    github: {},
    host: { live: false },
    verification: { pending: false },
    ...overrides,
  };
}

test("#1207 production observation proves no remote locally and never probes transport", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, ".1207-no-remote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const runDir = path.join(root, "run");
  const gitTrap = path.join(root, "git-trap.js");
  const ghTrap = path.join(root, "gh-trap.js");
  const gitTrapLog = path.join(root, "git-trap.log");
  const ghTrapLog = path.join(root, "gh-trap.log");
  const priorGit = process.env.RELAY_GIT_BIN;
  const priorGh = process.env.RELAY_GH_BIN;
  const priorTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir);
  const gitSetup = (args) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  gitSetup(["init", "-b", "main"]);
  gitSetup(["config", "user.email", "relay@example.test"]);
  gitSetup(["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "local\n");
  gitSetup(["add", "README.md"]);
  gitSetup(["commit", "-m", "initial"]);
  fs.writeFileSync(gitTrap, [
    "#!/usr/bin/env node",
    "const fs=require('fs'),{spawnSync}=require('child_process');",
    `const log=${JSON.stringify(gitTrapLog)}, args=process.argv.slice(2);`,
    "fs.appendFileSync(log, JSON.stringify(args)+'\\n');",
    "if(process.env.RELAY_FAIL_REMOTE_CONFIG==='1'&&args.at(-1)==='remote') process.exit(93);",
    "if(args.includes('fetch')||args.includes('ls-remote')||args.includes('push')) process.exit(91);",
    "const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});",
    "process.exit(result.status===null?92:result.status);",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(ghTrap, [
    "#!/usr/bin/env node",
    `require('fs').appendFileSync(${JSON.stringify(ghTrapLog)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
    "process.exit(92);",
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.RELAY_GIT_BIN = gitTrap;
  process.env.RELAY_GH_BIN = ghTrap;
  try {
    const transportCalls = () => fs.readFileSync(gitTrapLog, "utf8").trim().split("\n")
      .filter(Boolean).map(JSON.parse)
      .filter((args) => args.some((arg) => ["fetch", "ls-remote", "push"].includes(arg)));
    const record = {
      run_id: "issue-1207-no-remote",
      repo: { root: repo, remote: "local/repo" },
      git: {
        branch: "main", base_branch: "main", worktree: repo,
        start_sha: gitSetup(["rev-parse", "HEAD"]),
      },
    };
    const observed = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(observed.git.remote_name, null);
    assert.equal(observed.git.remote_url, null);
    assert.equal(observed.git.remote_head_sha, null);
    assert.equal(observed.git.remote_relation, null);
    assert.equal(observed.git.local_delivery, true);
    assert.deepEqual(observed.github, {});
    assert.deepEqual(observed.blockers, []);
    assert.deepEqual(transportCalls(), []);
    assert.equal(fs.existsSync(ghTrapLog), false);
    gitSetup(["remote", "add", "origin", "https://gitlab.example.test/owner/repo.git"]);
    const unsupported = await recovery.observeProduction({
      runDir, runRecord: { ...record, repo: { root: repo, remote: "https://gitlab.example.test/owner/repo.git" } }, facts: [],
    });
    assert.equal(unsupported.blockers[0].code, "delivery_unsupported");
    assert.equal(unsupported.blockers[0].retryable, false);
    assert.deepEqual(unsupported.github, {});
    assert.deepEqual(transportCalls(), []);
    assert.equal(fs.existsSync(ghTrapLog), false);

    gitSetup(["remote", "remove", "origin"]);
    const wrongFallback = await recovery.observeProduction({
      runDir, runRecord: { ...record, repo: { root: repo, remote: "local/other" } }, facts: [],
    });
    assert.equal(wrongFallback.blockers[0].code, "delivery_unsupported");

    gitSetup(["remote", "add", "backup", "https://github.com/local/repo.git"]);
    const originless = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(originless.blockers[0].code, "delivery_unsupported");
    gitSetup(["remote", "remove", "backup"]);

    gitSetup(["remote", "add", "origin", repo]);
    const localPath = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(localPath.blockers[0].code, "delivery_unsupported");
    gitSetup(["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    const mismatch = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(mismatch.blockers[0].code, "delivery_unsupported");

    process.env.RELAY_FAIL_REMOTE_CONFIG = "1";
    const configFailure = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    delete process.env.RELAY_FAIL_REMOTE_CONFIG;
    assert.equal(configFailure.blockers[0].code, "delivery_unsupported");
    assert.equal(configFailure.blockers[0].retryable, false);
    assert.deepEqual(transportCalls(), []);
    assert.equal(fs.existsSync(ghTrapLog), false);

    gitSetup(["remote", "set-url", "origin", "https://github.com/local/repo.git"]);
    gitSetup(["remote", "add", "backup", repo]);
    gitSetup(["remote", "set-url", "--push", "origin", "https://gitlab.example.test/local/repo.git"]);
    const pushMismatch = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(pushMismatch.blockers[0].code, "delivery_unsupported");
    assert.deepEqual(transportCalls(), []);
    assert.equal(fs.existsSync(ghTrapLog), false);
    gitSetup(["config", "--unset-all", "remote.origin.pushurl"]);
    gitSetup(["remote", "set-url", "backup", "https://gitlab.example.test/local/repo.git"]);
    gitSetup(["remote", "set-url", "--push", "backup", "https://github.com/local/repo.git"]);
    gitSetup(["config", "branch.main.remote", "backup"]);
    const trackedFetchMismatch = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(trackedFetchMismatch.blockers[0].code, "delivery_unsupported");
    assert.deepEqual(transportCalls(), []);
    assert.equal(fs.existsSync(ghTrapLog), false);
    gitSetup(["config", "--unset", "branch.main.remote"]);
    const githubRoute = await recovery.observeProduction({ runDir, runRecord: record, facts: [] });
    assert.equal(Object.hasOwn(githubRoute.git, "local_delivery"), false);
    assert.equal(githubRoute.git.remote_name, "origin");
    assert.equal(githubRoute.github.available, false);
    assert.match(fs.readFileSync(gitTrapLog, "utf8"), /ls-remote/);
    assert.equal(fs.existsSync(ghTrapLog), true);
  } finally {
    delete process.env.RELAY_FAIL_REMOTE_CONFIG;
    if (priorGit === undefined) delete process.env.RELAY_GIT_BIN; else process.env.RELAY_GIT_BIN = priorGit;
    if (priorGh === undefined) delete process.env.RELAY_GH_BIN; else process.env.RELAY_GH_BIN = priorGh;
    if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
  }
});

test("#1207 local recovery converges commit then verification across an effect crash", async () => {
  const record = { ...runRecord(), repo: { root: "/repo", remote: "local/repo" } };
  const h = harness({
    record,
    facts: [attemptFinished()],
    observations: localObservations({
      git: { ...localObservations().git, reviewable_dirty: true },
    }),
  });
  const dirty = await inspectRun(h);
  assert.equal(dirty.recommended_action.reason, "publication_incomplete");
  assert.deepEqual(dirty.recommended_action.steps, ["commit_work"]);

  let commitCalls = 0;
  const commitEffects = {
    converge: async (step) => {
      assert.equal(step, "commit_work");
      commitCalls += 1;
      h.state.observations.git.reviewable_dirty = false;
      if (commitCalls === 1) throw new Error("simulated crash after local commit");
      return { converged: true, applied: false };
    },
  };
  await assert.rejects(recoverRun({
    ...h, actor: "owner", reason: "commit local work",
    expectedActionKey: dirty.recommended_action.key, effects: commitEffects,
  }), /simulated crash/);
  const committed = await recoverRun({
    ...h, actor: "owner", reason: "commit local work",
    expectedActionKey: dirty.recommended_action.key, effects: commitEffects,
  });
  assert.equal(committed.status, "converged");
  assert.equal(committed.after.derived.reason, "verification_missing");
  assert.deepEqual(committed.after.recommended_action.steps, ["record_verification"]);

  // The in-memory harness has one intent slot; production keeps each completed
  // operation in its own content-addressed intent/receipt pair.
  h.state.intent = null;
  const verified = await recoverRun({
    ...h, actor: "owner", reason: "verify local work",
    expectedActionKey: committed.after.recommended_action.key,
    effects: {
      converge: async (step, context) => {
        assert.equal(step, "record_verification");
        return {
          converged: true,
          applied: true,
          fact: {
            type: "verification_recorded", at: context.intent.created_at, actor: "owner",
            payload: verificationFact().payload,
          },
        };
      },
    },
  });
  assert.equal(verified.status, "converged");
  assert.equal(verified.after.derived.reason, "review_missing");
  assert.equal(verified.after.recommended_action.kind, "review");
  assert.deepEqual(h.state.effects, []);
  assert.equal(h.state.facts.filter((fact) => fact.type === "verification_recorded").length, 1);
});

test("#1208 local reviewed-result close survives the terminal-fact/receipt crash cut", async () => {
  const h = harness({
    record: { ...runRecord(), repo: { root: "/repo", remote: "local/repo" } },
    facts: [attemptFinished(), verificationFact(), reviewFact({ eventId: "review-local-pass", verdict: "pass" })],
    observations: localObservations(),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.equal(inspected.recommended_action.reason, "reviewed_result_ready");
  assert.deepEqual(inspected.recommended_action.steps, ["close_reviewed_result"]);

  let crashAfterAppend = true;
  const appendFact = async (fact) => {
    await h.appendFact(fact);
    if (crashAfterAppend && fact.type === "run_closed") {
      crashAfterAppend = false;
      throw new Error("simulated crash after reviewed-result terminal fact");
    }
  };
  const effects = {
    converge: async (step, context) => {
      assert.equal(step, "close_reviewed_result");
      return {
        converged: true,
        applied: true,
        fact: {
          type: "run_closed",
          at: context.intent.created_at,
          actor: context.actor,
          payload: { reason: "reviewed_result_ready", operator: context.actor, last_sha: HEAD, pr_number: null },
        },
      };
    },
  };
  await assert.rejects(recoverRun({
    ...h,
    actor: "owner",
    reason: "close exact local reviewed result",
    expectedActionKey: inspected.recommended_action.key,
    appendFact,
    effects,
  }), /simulated crash/);
  assert.equal(h.state.facts.filter((fact) => fact.type === "run_closed").length, 1);
  assert.equal(h.state.receipts.size, 0);

  const converged = await recoverRun({
    ...h,
    actor: "owner",
    reason: "close exact local reviewed result",
    expectedActionKey: inspected.recommended_action.key,
    appendFact,
    effects,
  });
  assert.equal(converged.status, "converged");
  assert.equal(converged.after.derived.reason, "reviewed_result_ready");
  assert.equal(converged.after.derived.reviewed_sha, HEAD);
  assert.deepEqual(converged.receipt.fact_event_ids, [h.state.facts.at(-1).event_id]);

  const retry = await recoverRun({
    ...h,
    actor: "owner",
    reason: "close exact local reviewed result",
    expectedActionKey: inspected.recommended_action.key,
    appendFact,
    effects,
  });
  assert.equal(retry.status, "noop");
  assert.equal(h.state.facts.filter((fact) => fact.type === "run_closed").length, 1);
});

test("inspect is byte-read-only and emits one stable recommended action", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const before = structuredClone(h.state);
  const first = await inspectRun(h);
  const second = await inspectRun(h);
  assert.deepEqual(h.state, before);
  assert.equal(first.recommended_action.kind, "recover");
  assert.deepEqual(first.recommended_action.steps, ["push_branch", "record_or_create_pr"]);
  assert.equal(first.recommended_action.key, second.recommended_action.key);
  assert.deepEqual(first.facts, [attemptFinished()]);
});

test("inspect exposes one retry for a runtime escalation and exhausts that subject", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN", pr_head_sha: HEAD, pr_base_sha: START,
    },
  });
  const firstFact = reviewFact({ eventId: "review-runtime-1", escalationKind: "runtime_failure" });
  const first = await inspectRun(harness({ facts: [pullRequestFact(HEAD), verificationFact(), firstFact], observations }));
  assert.equal(first.derived.action, "review");
  assert.equal(first.derived.retry_of_event_id, firstFact.event_id);
  assert.equal(first.recommended_action.kind, "review");

  const retryFailure = reviewFact({
    eventId: "review-runtime-2",
    escalationKind: "runtime_failure",
    retryOfEventId: firstFact.event_id,
  });
  const exhausted = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), firstFact, retryFailure],
    observations,
  }));
  assert.equal(exhausted.derived.action, "none");
  assert.equal(exhausted.derived.reason, "review_escalated_retry_exhausted");
  assert.equal(exhausted.recommended_action.kind, "none");
});

test("reviewer escalation exposes adjudication exits and re-review stays bound until a passing review", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: { ...publicationObservations().github, matching_pr_count: 1, pr_number: 42,
      pr_state: "OPEN", pr_head_sha: HEAD, pr_base_sha: START },
  });
  const escalation = reviewFact({ eventId: "reviewer-escalation-1", escalationKind: "reviewer" });
  const deadEnd = await inspectRun(harness({ facts: [pullRequestFact(HEAD), verificationFact(), escalation], observations }));
  assert.equal(deadEnd.derived.reason, "review_escalated");
  assert.deepEqual(deadEnd.derived.diagnostics.at(-1).available_exits, ["re_review", "redispatch", "close"]);

  const resolution = resolutionFact({ eventId: "resolution-rereview-1", reviewEventId: escalation.event_id });
  const adjudicated = await inspectRun(harness({ facts: [pullRequestFact(HEAD), verificationFact(), escalation, resolution], observations }));
  assert.equal(adjudicated.derived.action, "review");
  assert.equal(adjudicated.derived.resolution_of_event_id, resolution.event_id);
  assert.notEqual(adjudicated.derived.action, "merge");

  const pass = reviewFact({ eventId: "resolved-pass-1", verdict: "pass", baseSha: START,
    resolutionOfEventId: resolution.event_id });
  const ready = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), escalation, resolution, pass], observations,
  }));
  assert.equal(ready.derived.reason, "ready_to_merge");
});

test("reviewer escalation redispatch resolution derives the changes-requested lifecycle exit", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: { ...publicationObservations().github, matching_pr_count: 1, pr_number: 42,
      pr_state: "OPEN", pr_head_sha: HEAD, pr_base_sha: START },
  });
  const escalation = reviewFact({ eventId: "reviewer-escalation-redispatch", escalationKind: "reviewer" });
  const resolution = resolutionFact({ eventId: "resolution-redispatch", reviewEventId: escalation.event_id, disposition: "redispatch" });
  const result = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), escalation, resolution], observations,
  }));
  assert.equal(result.derived.action, "redispatch");
  assert.equal(result.derived.reason, "review_resolution_redispatch");
  assert.equal(result.derived.resolution_of_event_id, resolution.event_id);
  assert.equal(dispatch.assertResumeInspection(result), result);
});

test("review resolution lineage violations fail closed with a typed diagnostic", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: { ...publicationObservations().github, matching_pr_count: 1, pr_number: 42,
      pr_state: "OPEN", pr_head_sha: HEAD, pr_base_sha: START },
  });
  const escalation = reviewFact({ eventId: "reviewer-escalation-invalid", escalationKind: "reviewer" });
  const valid = resolutionFact({ eventId: "resolution-valid", reviewEventId: escalation.event_id });
  const duplicate = resolutionFact({ eventId: "resolution-duplicate", reviewEventId: escalation.event_id });
  const duplicateResult = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), escalation, valid, duplicate], observations,
  }));
  assert.equal(duplicateResult.derived.reason, "review_resolution_binding_invalid");

  const unboundPass = reviewFact({ eventId: "resolution-unbound-pass", verdict: "pass", baseSha: START });
  const unboundResult = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), escalation, valid, unboundPass], observations,
  }));
  assert.equal(unboundResult.derived.reason, "review_resolution_binding_invalid");

  const passing = reviewFact({ eventId: "already-passing", verdict: "pass", baseSha: START });
  const illegal = resolutionFact({ eventId: "resolution-after-pass", reviewEventId: passing.event_id });
  const illegalResult = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), passing, illegal], observations,
  }));
  assert.equal(illegalResult.derived.reason, "review_resolution_binding_invalid");
  assert.equal(illegalResult.derived.diagnostics.at(-1).code, "review_resolution_binding_invalid");
});

test("inspect accepts the immediate single passing retry", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN", pr_head_sha: HEAD,
    },
  });
  const firstFact = reviewFact({ eventId: "review-runtime-pass-1", escalationKind: "runtime_failure" });
  const retryPass = reviewFact({
    eventId: "review-runtime-pass-2",
    verdict: "pass",
    baseSha: START,
    retryOfEventId: firstFact.event_id,
  });
  const result = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), firstFact, retryPass],
    observations,
  }));
  assert.equal(result.derived.action, "merge");
  assert.equal(result.derived.reason, "ready_to_merge");
});

test("production inspect blocks dirty reviewed bytes and re-enables readiness when restored clean", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false, reviewable_dirty: true },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN",
      pr_head_sha: HEAD, pr_base_sha: START,
    },
  });
  const h = harness({
    facts: [pullRequestFact(HEAD), verificationFact(), reviewFact({ eventId: "dirty-reviewed-pass", verdict: "pass", baseSha: START })],
    observations,
  });
  const dirty = await inspectRun(h);
  assert.equal(dirty.derived.action, "none");
  assert.equal(dirty.derived.reason, "reviewed_worktree_dirty");
  assert.equal(dirty.blockers[0].code, "reviewed_worktree_dirty");
  assert.equal(dirty.recommended_action.kind, "operator_attention");
  assert.equal(dirty.recommended_action.reason, "reviewed_worktree_dirty");

  h.state.observations.git.reviewable_dirty = false;
  const clean = await inspectRun(h);
  assert.equal(clean.derived.action, "merge");
  assert.equal(clean.derived.reason, "ready_to_merge");
  assert.equal(clean.recommended_action.kind, "merge");
});

test("a historical passing GitHub review without base evidence derives one fresh review", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN",
      pr_head_sha: HEAD, pr_base_sha: START,
    },
  });
  const result = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), reviewFact({ eventId: "historical-pass", verdict: "pass" })],
    observations,
  }));
  assert.equal(result.derived.action, "review");
  assert.equal(result.derived.reason, "review_base_evidence_missing");
});

test("inspect rejects a passing retry without a matching initial runtime failure", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN", pr_head_sha: HEAD,
    },
  });
  const arbitraryRetry = reviewFact({
    eventId: "review-arbitrary-retry",
    verdict: "pass",
    retryOfEventId: "missing-runtime-failure",
  });
  const result = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), arbitraryRetry],
    observations,
  }));
  assert.equal(result.derived.action, "none");
  assert.equal(result.derived.reason, "review_retry_binding_invalid");
});

test("inspect rejects a third pass reusing the first retry event", async () => {
  const observations = publicationObservations({
    git: { ...publicationObservations().git, reviewable_work: false },
    github: {
      ...publicationObservations().github,
      matching_pr_count: 1, pr_number: 42, pr_state: "OPEN", pr_head_sha: HEAD,
    },
  });
  const firstFact = reviewFact({ eventId: "review-runtime-third-1", escalationKind: "runtime_failure" });
  const retryFailure = reviewFact({
    eventId: "review-runtime-third-2",
    escalationKind: "runtime_failure",
    retryOfEventId: firstFact.event_id,
  });
  const thirdPass = reviewFact({
    eventId: "review-runtime-third-3",
    verdict: "pass",
    retryOfEventId: firstFact.event_id,
  });
  const result = await inspectRun(harness({
    facts: [pullRequestFact(HEAD), verificationFact(), firstFact, retryFailure, thirdPass],
    observations,
  }));
  assert.equal(result.derived.action, "none");
  assert.equal(result.derived.reason, "review_retry_binding_invalid");
});

test("recover refuses a stale inspect key before effects or durable writes", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const effects = { converge: async (step) => { h.state.effects.push(step); return { converged: true }; } };
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "recover publication",
    expectedActionKey: "0".repeat(64),
    effects,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "stale_action");
  assert.deepEqual(h.state.effects, []);
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("pending intent exposes an exact resume command and exact identity resumes it", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const intentKey = "1".repeat(64);
  h.state.intent = {
    schema_version: 1,
    action_key: intentKey,
    operation_id: `recover-${intentKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:03:00Z",
    steps: ["record_or_create_pr"],
    actor: "owner",
    reason: "resume operator's publication",
    reason_code: "publication_incomplete",
    observed_event_id: "attempt-finished",
    before_sha: HEAD,
  };
  const stale = await recoverRun({
    ...h,
    runDir: "/run",
    actor: "owner",
    reason: "fresh publication",
    expectedActionKey: "2".repeat(64),
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(stale.status, "refused");
  assert.equal(stale.blockers[0].code, "active_intent_pending");
  assert.deepEqual(stale.blockers[0].details, {
    action_key: intentKey,
    actor: "owner",
    reason: "resume operator's publication",
    reason_code: "publication_incomplete",
    created_at: "2026-08-01T00:03:00Z",
    resume_invocation: "node skills/relay/scripts/relay-recover.js recover --run-dir '/run' --expected-action-key 1111111111111111111111111111111111111111111111111111111111111111 --actor 'owner' --reason 'resume operator'\\''s publication' --json",
  });
  assert.deepEqual(h.state.effects, []);
  const resumed = await recoverRun({
    ...h,
    runDir: "/run",
    actor: "owner",
    reason: "resume operator's publication",
    expectedActionKey: intentKey,
    effects: { converge: async () => ({ converged: true, applied: false }) },
  });
  assert.equal(resumed.status, "converged");
  assert.equal(resumed.action_key, intentKey);
  assert.equal(h.state.receipts.size, 1);
});

test("pending intent with mismatched actor or reason preserves identity refusal", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const intentKey = "3".repeat(64);
  h.state.intent = {
    schema_version: 1,
    action_key: intentKey,
    operation_id: `recover-${intentKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:03:00Z",
    steps: ["record_or_create_pr"],
    actor: "owner",
    reason: "publish safely",
    reason_code: "publication_incomplete",
    observed_event_id: "attempt-finished",
    before_sha: HEAD,
  };
  const result = await recoverRun({
    ...h,
    runDir: "/run",
    actor: "different-operator",
    reason: "publish safely",
    expectedActionKey: intentKey,
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "active_intent_identity_mismatch");
  assert.deepEqual(h.state.effects, []);
});

test("head-drifted MERGED PR pending intent requires exact identity discharge before external-merge recovery", async () => {
  const intentKey = "4".repeat(64);
  const intent = {
    schema_version: 1,
    action_key: intentKey,
    operation_id: `recover-${intentKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:03:00Z",
    steps: ["push_branch", "record_or_create_pr", "record_verification"],
    actor: "owner",
    reason: "publish and verify reviewed work",
    reason_code: "publication_incomplete",
    observed_event_id: "attempt-finished",
    before_sha: HEAD,
  };
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(START)],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  h.state.intent = structuredClone(intent);
  const factCount = h.state.facts.length;

  for (const identity of [
    { actor: "different-operator", reason: intent.reason },
    { actor: intent.actor, reason: "different reason" },
  ]) {
    const mismatch = await recoverRun({
      ...h,
      ...identity,
      expectedActionKey: intentKey,
      effects: { converge: async () => { throw new Error("obsolete effect called"); } },
    });
    assert.equal(mismatch.status, "refused");
    assert.equal(mismatch.blockers[0].code, "active_intent_identity_mismatch");
    assert.equal(h.state.facts.length, factCount);
    assert.equal(h.state.receipts.size, 0);
    assert.deepEqual(await h.readIntent({ facts: h.state.facts }), intent);
  }

  const discharged = await recoverRun({
    ...h,
    actor: intent.actor,
    reason: intent.reason,
    expectedActionKey: intentKey,
    effects: { converge: async () => { throw new Error("obsolete effect called"); } },
  });
  assert.equal(discharged.status, "converged");
  assert.deepEqual(h.state.effects, []);
  assert.deepEqual(h.state.intent, intent);
  assert.equal(await h.readIntent({ facts: h.state.facts }), null);
  const completion = h.state.facts.at(-1);
  assert.equal(completion.type, "recovery_applied");
  assert.equal(completion.actor, intent.actor);
  assert.equal(completion.payload.operator, intent.actor);
  assert.equal(completion.payload.reason, intent.reason);
  assert.equal(completion.payload.rule, "active_intent_observation_changed");
  assert.deepEqual(completion.payload.side_effects, ["discharge_obsolete_intent"]);
  assert.equal(h.state.facts.some((fact) => fact.type === "merge_recorded"), false);

  const fresh = await inspectRun(h);
  assert.equal(fresh.recommended_action.kind, "recover");
  assert.equal(fresh.recommended_action.reason, "merged_pr_unrecorded");
  assert.deepEqual(fresh.recommended_action.steps, ["record_external_merge"]);
  assert.notEqual(fresh.recommended_action.key, intentKey);
});

test("observation-changed discharge retry writes only the missing receipt", async () => {
  const intentKey = "5".repeat(64);
  const intent = {
    schema_version: 1,
    action_key: intentKey,
    operation_id: `recover-${intentKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:03:00Z",
    steps: ["push_branch", "record_or_create_pr", "record_verification"],
    actor: "owner",
    reason: "publish and verify reviewed work",
    reason_code: "publication_incomplete",
    observed_event_id: "attempt-finished",
    before_sha: HEAD,
  };
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  h.state.intent = structuredClone(intent);
  let appendCalls = 0;
  const appendFact = async (fact) => {
    appendCalls += 1;
    if (h.state.facts.some((entry) => entry.event_id === fact.event_id)) {
      throw new Error(`duplicate event_id: ${fact.event_id}`);
    }
    h.state.facts.push(structuredClone(fact));
  };
  let crashBeforeReceipt = true;
  const writeReceipt = async (input) => {
    if (crashBeforeReceipt) {
      crashBeforeReceipt = false;
      throw new Error("crash_before_discharge_receipt");
    }
    await h.writeReceipt(input);
  };
  const effects = { converge: async () => { throw new Error("obsolete effect called"); } };

  await assert.rejects(recoverRun({
    ...h, appendFact, writeReceipt,
    actor: intent.actor, reason: intent.reason, expectedActionKey: intentKey, effects,
  }), /crash_before_discharge_receipt/);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 1);
  const strandedFact = h.state.facts.find((fact) => fact.type === "recovery_applied");
  assert.equal(strandedFact.payload.rule, "active_intent_observation_changed");
  assert.deepEqual(strandedFact.payload.side_effects, ["discharge_obsolete_intent"]);
  assert.equal(appendCalls, 1);
  assert.equal(h.state.receipts.size, 0);
  assert.deepEqual(await h.readIntent({ facts: h.state.facts }), intent);

  const retried = await recoverRun({
    ...h, appendFact, writeReceipt,
    actor: intent.actor, reason: intent.reason, expectedActionKey: intentKey, effects,
  });
  assert.equal(retried.status, "converged");
  assert.deepEqual(h.state.effects, []);
  assert.equal(await h.readIntent({ facts: h.state.facts }), null);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "merge_recorded").length, 0);
  assert.equal(appendCalls, 1);
  assert.equal(h.state.writes, 1);
  assert.deepEqual(retried.receipt.fact_event_ids, [strandedFact.event_id]);
});

test("R1 completes a verification intent receipt after inspect advances to review", async () => {
  const intentKey = "6".repeat(64);
  const operationId = `recover-${intentKey.slice(0, 32)}`;
  const intent = {
    schema_version: 1,
    action_key: intentKey,
    operation_id: operationId,
    created_at: "2026-08-01T00:03:00Z",
    steps: ["record_verification"],
    actor: "owner",
    reason: "record passed verification",
    reason_code: "verification_missing",
    observed_event_id: "pr-bbbb",
    before_sha: HEAD,
  };
  const completedVerification = {
    ...verificationFact(),
    event_id: `recovery-${crypto.createHash("sha256")
      .update(`${operationId}:record_verification`).digest("hex").slice(0, 32)}`,
    at: intent.created_at,
  };
  const h = harness({
    facts: [pullRequestFact(HEAD), completedVerification],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "OPEN",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: null,
      },
    }),
  });
  h.state.intent = structuredClone(intent);
  const before = await inspectRun(h);
  assert.equal(before.recommended_action.kind, "review");
  let effectCalls = 0;

  const result = await recoverRun({
    ...h,
    actor: intent.actor,
    reason: intent.reason,
    expectedActionKey: intentKey,
    effects: { converge: async () => { effectCalls += 1; throw new Error("effect called"); } },
  });

  assert.equal(result.status, "converged");
  assert.equal(effectCalls, 0);
  assert.equal(h.state.facts.filter((fact) => fact.type === "verification_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 1);
  assert.equal(h.state.receipts.size, 1);
  assert.equal(await h.readIntent({ facts: h.state.facts }), null);
});

test("#1209 recovery reinspection requires the same action after live observations change", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const inspected = await inspectRun(h);
  h.state.observations.git.remote_head_sha = HEAD;
  h.state.observations.git.remote_relation = "equal";
  const effects = { converge: async (step) => { h.state.effects.push(step); return { converged: true }; } };
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "must reinspect the same action",
    expectedActionKey: inspected.recommended_action.key,
    effects,
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "stale_action");
  assert.equal(result.before.recommended_action.kind, "recover");
  assert.notEqual(result.action_key, inspected.recommended_action.key);
  assert.deepEqual(h.state.effects, []);
  assert.equal(h.state.writes, 0);
});

test("recover rejects a path-shaped expected action key before ownership or reads", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  let lockCalls = 0;
  await assert.rejects(recoverRun({
    ...h,
    withLock: async (callback) => { lockCalls += 1; return callback(); },
    actor: "owner",
    reason: "must not traverse",
    expectedActionKey: "../../outside",
    effects: { converge: async () => { throw new Error("effect called"); } },
  }), /lowercase SHA-256/);
  assert.equal(lockCalls, 0);
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("recover rejects a regular forged receipt without its durable completion fact", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  const inspected = await inspectRun(h);
  const key = inspected.recommended_action.key;
  h.state.receipts.set(key, {
    schema_version: 1,
    operation_id: `recover-${key.slice(0, 32)}`,
    action_key: key,
    fact_event_ids: ["forged-completion"],
  });
  let effectCalls = 0;
  await assert.rejects(recoverRun({
    ...h,
    actor: "owner",
    reason: "must verify receipt",
    expectedActionKey: key,
    effects: { converge: async () => { effectCalls += 1; return { converged: true }; } },
  }), /missing durable fact/);
  assert.equal(effectCalls, 0);
  assert.deepEqual(h.state.facts, [attemptFinished()]);
});

test("terminal recovery is a no-write noop", async () => {
  const h = harness({ facts: [closedFact()], observations: publicationObservations() });
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "must not reopen",
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(result.status, "noop");
  assert.equal(h.state.facts.length, 1);
  assert.equal(h.state.writes, 0);
});

test("terminal run refuses an unrelated active intent without publishing a receipt", async () => {
  const h = harness({ facts: [closedFact()], observations: publicationObservations() });
  const unrelatedKey = "1".repeat(64);
  h.state.intent = {
    schema_version: 1,
    action_key: unrelatedKey,
    operation_id: `recover-${unrelatedKey.slice(0, 32)}`,
    created_at: "2026-08-01T00:01:30Z",
    steps: ["record_external_merge"],
    actor: "owner",
    reason: "unrelated abandoned operation",
    reason_code: "merged_pr_unrecorded",
    observed_event_id: "older-pr",
    before_sha: HEAD,
  };
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "unrelated abandoned operation",
    effects: { converge: async () => { throw new Error("effect called"); } },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.blockers[0].code, "terminal_intent_mismatch");
  assert.equal(result.receipt, null);
  assert.equal(h.state.receipts.size, 0);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.facts.length, 1);
});

test("effect-before-fact retry discharges a prefix-dropped intent before recording the exact PR", async () => {
  const h = harness({ facts: [attemptFinished()], observations: publicationObservations() });
  let prCreates = 0;
  let failFirstPrFact = true;
  const effects = {
    converge: async (step, context) => {
      h.state.effects.push(step);
      if (step === "push_branch") {
        h.state.observations.git.remote_head_sha = HEAD;
        h.state.observations.git.remote_relation = "equal";
        return { converged: true, applied: h.state.effects.filter((entry) => entry === step).length === 1 };
      }
      assert.equal(step, "record_or_create_pr");
      if (!h.state.observations.github.pr_number) {
        prCreates += 1;
        Object.assign(h.state.observations.github, {
          matching_pr_count: 1,
          pr_number: 42,
          pr_state: "OPEN",
          pr_head_sha: HEAD,
        });
      }
      return {
        converged: true,
        applied: prCreates === 1,
        fact: {
          type: "pull_request_recorded",
          at: "2026-08-01T00:03:00Z",
          actor: "owner",
          payload: {
            pr_number: 42,
            repo: "owner/repo",
            head_ref: "issue-1135",
            base_ref: "main",
            head_sha: HEAD,
            created_by_relay: true,
          },
        },
      };
    },
  };
  const appendFact = async (fact) => {
    if (fact.type === "pull_request_recorded" && failFirstPrFact) {
      failFirstPrFact = false;
      throw new Error("crash_after_pr_effect");
    }
    await h.appendFact(fact);
  };
  await assert.rejects(recoverRun({
    ...h, appendFact, actor: "owner", reason: "publish", effects,
  }), /crash_after_pr_effect/);
  const retry = await recoverRun({
    ...h, appendFact, actor: "owner", reason: "publish", effects,
  });
  assert.equal(retry.status, "converged");
  assert.equal(retry.after.recommended_action.kind, "recover");
  assert.deepEqual(retry.after.recommended_action.steps, ["record_or_create_pr"]);
  assert.equal(h.state.facts.filter((fact) => fact.type === "pull_request_recorded").length, 0);
  const discharge = h.state.facts.find((fact) => fact.type === "recovery_applied");
  assert.equal(discharge.payload.rule, "active_intent_observation_changed");
  assert.deepEqual(discharge.payload.side_effects, ["discharge_obsolete_intent"]);

  const recovered = await recoverRun({
    ...h, appendFact, actor: "owner", reason: "record the exact PR",
    expectedActionKey: retry.after.recommended_action.key, effects,
  });
  assert.equal(recovered.status, "converged");
  assert.equal(prCreates, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "pull_request_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 2);

  const factBytes = JSON.stringify(h.state.facts);
  const effectCount = h.state.effects.length;
  const receiptWrites = h.state.writes;
  const again = await recoverRun({
    ...h, appendFact, actor: "owner", reason: "record the exact PR", effects,
    expectedActionKey: recovered.action_key,
  });
  assert.equal(again.status, "noop");
  assert.equal(JSON.stringify(h.state.facts), factBytes);
  assert.equal(h.state.effects.length, effectCount);
  assert.equal(h.state.writes, receiptWrites);
  assert.equal(prCreates, 1);
});

test("an externally merged PR derives only the terminal provenance step", async () => {
  const pr = {
    event_id: "pr",
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
      head_sha: HEAD, created_by_relay: true,
    },
  };
  const h = harness({
    facts: [attemptFinished(), pr],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, ["record_external_merge"]);
});

test("an unrelated historical MERGED PR cannot become terminal without a durable PR identity", async () => {
  const h = harness({
    facts: [attemptFinished()],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 7, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "publication_incomplete");
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "unrecorded_merged_pr");
  assert.deepEqual(inspected.recommended_action.steps, []);
});

test("a MERGED PR with a different durable PR number remains unrecorded", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 7, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "unrecorded_merged_pr");
  assert.deepEqual(inspected.recommended_action.steps, []);
});

test("a MERGED PR with durable identity ignores a different recorded head", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(START)],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "merged_pr_unrecorded");
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, ["record_external_merge"]);
  assert.equal(inspected.blockers.some((item) => item.code === "unrecorded_merged_pr"), false);
});

test("an open PR with local head drift pushes, refreshes its durable head, then verifies", async () => {
  const observations = publicationObservations({
    git: {
      ...publicationObservations().git,
      remote_head_sha: START,
      remote_relation: "behind_local",
    },
    github: {
      available: true,
      pr_lookup_complete: true,
      matching_pr_count: 1,
      repo: "owner/repo",
      pr_number: 42,
      pr_state: "OPEN",
      head_ref: "issue-1135",
      base_ref: "main",
      pr_head_sha: START,
      merge_sha: null,
    },
  });
  const h = harness({ facts: [attemptFinished(), pullRequestFact(START)], observations });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, [
    "push_branch",
    "record_or_create_pr",
    "record_verification",
  ]);

  h.state.observations.git.remote_head_sha = HEAD;
  h.state.observations.git.remote_relation = "equal";
  h.state.observations.github.pr_head_sha = HEAD;
  const afterPush = await inspectRun(h);
  assert.deepEqual(afterPush.recommended_action.steps, [
    "record_or_create_pr",
    "record_verification",
  ]);
});

test("head-drift recovery durably refreshes the same PR without a fold conflict", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(START)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: START,
        remote_relation: "behind_local",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "OPEN",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: START, merge_sha: null,
      },
    }),
  });
  const result = await recoverRun({
    ...h,
    actor: "owner",
    reason: "refresh exact PR head",
    effects: {
      converge: async (step, context) => {
        if (step === "push_branch") {
          h.state.observations.git.remote_head_sha = HEAD;
          h.state.observations.git.remote_relation = "equal";
          h.state.observations.github.pr_head_sha = HEAD;
          return { converged: true, applied: true };
        }
        if (step === "record_or_create_pr") {
          return {
            converged: true,
            applied: false,
            fact: {
              type: "pull_request_recorded", at: context.intent.created_at, actor: "owner",
              payload: {
                pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
                head_sha: HEAD, created_by_relay: true,
              },
            },
          };
        }
        assert.equal(step, "record_verification");
        return {
          converged: true,
          applied: true,
          fact: {
            type: "verification_recorded", at: context.intent.created_at, actor: "owner",
            payload: {
              head_sha: HEAD, tree_sha: TREE, done_criteria_sha256: HASH,
              command: "node --test", verification_request_sha256: "f".repeat(64),
              declared_command_count: 1, completed_command_count: 1,
              result_path: "/run/verification.log", result_sha256: "f".repeat(64),
              exit_code: 0, status: "passed", operator: "owner",
            },
          },
        };
      },
    },
  });
  assert.equal(result.status, "converged");
  assert.equal(result.after.derived.reason, "review_missing");
  assert.notEqual(result.after.derived.reason, "fact_conflict");
  const prFacts = h.state.facts.filter((fact) => fact.type === "pull_request_recorded");
  assert.equal(prFacts.length, 2);
  assert.equal(prFacts.at(-1).payload.pr_number, 42);
  assert.equal(prFacts.at(-1).payload.head_sha, HEAD);
});

test("PR selection reuses exact OPEN, reconciles exact MERGED, and ignores CLOSED", () => {
  const row = (number, state, headRefOid = HEAD) => ({
    number,
    state,
    headRefName: "issue-1135",
    baseRefName: "main",
    headRefOid,
    headRepository: { nameWithOwner: "owner/repo" },
  });
  const options = {
    remote: "owner/repo",
    branch: "issue-1135",
    baseBranch: "main",
    localHeadSha: HEAD,
  };
  const mixed = recovery.__testing.selectGithubPr([
    row(40, "CLOSED"),
    row(42, "OPEN"),
  ], options);
  assert.equal(mixed.pr.number, 42);
  assert.equal(mixed.matchingPrCount, 1);
  assert.equal(mixed.closedPrCount, 1);

  const recordedClosed = recovery.__testing.selectGithubPr([
    row(40, "CLOSED"),
    row(42, "OPEN"),
  ], { ...options, recordedPrNumber: 40 });
  assert.equal(recordedClosed.pr.number, 40);
  assert.equal(recordedClosed.pr.state, "CLOSED");

  const closedOnly = recovery.__testing.selectGithubPr([row(40, "CLOSED")], options);
  assert.equal(closedOnly.pr, null);
  assert.equal(closedOnly.matchingPrCount, 0);

  const mergedExact = recovery.__testing.selectGithubPr([
    row(41, "OPEN", START),
    row(42, "MERGED", HEAD),
  ], options);
  assert.equal(mergedExact.pr.number, 42);
  assert.equal(mergedExact.pr.state, "MERGED");

  const adopted = recovery.__testing.selectGithubPr([
    { ...row(88, "OPEN"), baseRefName: "main" },
  ], { ...options, baseBranch: "deleted-docs" });
  assert.equal(adopted.pr.number, 88);
  assert.equal(adopted.pr.baseRefName, "main");
  assert.equal(adopted.matchingPrCount, 1);
  assert.equal(adopted.identityMatchCount, 0);
});

test("a lone CLOSED PR is ignored so publication can create a new exact OPEN PR", async () => {
  const h = harness({
    facts: [attemptFinished()],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 0,
        identity_match_count: 1, open_pr_count: 0, merged_pr_count: 0, closed_pr_count: 1,
        repo: "owner/repo", pr_number: null, pr_state: null,
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: null, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.recommended_action.kind, "recover");
  assert.deepEqual(inspected.recommended_action.steps, ["record_or_create_pr"]);
});

test("the exact CLOSED durable PR is exposed as a stable operator blocker", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "CLOSED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.equal(inspected.derived.reason, "github_pr_closed_unmerged");
  assert.equal(inspected.recommended_action.kind, "operator_attention");
  assert.equal(inspected.blockers[0].code, "github_pr_closed_unmerged");
});

test("verification refuses dirty reviewable bytes", () => {
  assert.throws(() => recovery.__testing.assertCleanVerificationObservation({
    git: { reviewable_dirty: true },
  }), /reviewable worktree is dirty/);
});

test("dirty PR recovery commits and republishes before accepting verification", async () => {
  const h = harness({
    facts: [attemptFinished(), pullRequestFact(HEAD)],
    observations: publicationObservations({
      git: {
        ...publicationObservations().git,
        reviewable_dirty: true,
        remote_head_sha: HEAD,
        remote_relation: "equal",
      },
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "OPEN",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: null,
      },
    }),
  });
  const inspected = await inspectRun(h);
  assert.deepEqual(inspected.recommended_action.steps, [
    "commit_work", "push_branch", "record_or_create_pr", "record_verification",
  ]);
});

test("production recover refuses root and active-checkout identities before lock artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recovery-production-trust-"));
  const repoRoot = path.join(root, "repo");
  const relayWorktreeBase = path.join(root, "relay-worktrees");
  const activeCheckout = path.join(relayWorktreeBase, "active");
  for (const directory of [repoRoot, relayWorktreeBase, activeCheckout]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  function createRun(runId, worktree) {
    const requestedRunDir = path.join(root, runId);
    fs.mkdirSync(requestedRunDir);
    const runDir = fs.realpathSync(requestedRunDir);
    const criteriaPath = path.join(runDir, "done-criteria.md");
    fs.writeFileSync(criteriaPath, "done\n");
    const record = runRecord(runId);
    record.repo.root = repoRoot;
    record.git.worktree = worktree;
    record.contract.done_criteria_path = criteriaPath;
    record.contract.done_criteria_sha256 = crypto.createHash("sha256")
      .update(fs.readFileSync(criteriaPath)).digest("hex");
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    return runDir;
  }
  for (const [runId, worktree] of [
    ["root-worktree", repoRoot],
    ["active-worktree", activeCheckout],
  ]) {
    const runDir = createRun(runId, worktree);
    const entries = fs.readdirSync(runDir).sort();
    await assert.rejects(recovery.recoverProductionRun({
      runDir,
      actor: "owner",
      reason: "must refuse before mutation",
      activeCheckout,
      relayWorktreeBase,
    }), /trusted relay worktree boundary/);
    assert.deepEqual(fs.readdirSync(runDir).sort(), entries);
  }
});

test("terminal fact before receipt resumes without active facts or repeated effects", async () => {
  const pr = {
    event_id: "pr",
    run_id: "issue-1135-test",
    type: "pull_request_recorded",
    at: "2026-08-01T00:02:00Z",
    actor: "owner",
    payload: {
      pr_number: 42, repo: "owner/repo", head_ref: "issue-1135", base_ref: "main",
      head_sha: HEAD, created_by_relay: true,
    },
  };
  const h = harness({
    facts: [attemptFinished(), pr],
    observations: publicationObservations({
      github: {
        available: true, pr_lookup_complete: true, matching_pr_count: 1,
        repo: "owner/repo", pr_number: 42, pr_state: "MERGED",
        head_ref: "issue-1135", base_ref: "main", pr_head_sha: HEAD, merge_sha: TARGET,
      },
    }),
  });
  let receiptCrash = true;
  const originalWriteReceipt = h.writeReceipt;
  const writeReceipt = async (request) => {
    if (receiptCrash) {
      receiptCrash = false;
      throw new Error("crash_after_terminal_fact");
    }
    return originalWriteReceipt(request);
  };
  const effects = {
    converge: async (step, context) => {
      h.state.effects.push(step);
      assert.equal(step, "record_external_merge");
      return {
        converged: true,
        applied: true,
        fact: {
          type: "merge_recorded",
          at: context.intent.created_at,
          actor: context.actor,
          payload: {
            pr_number: 42,
            reviewed_source_sha: HEAD,
            pr_head_sha: HEAD,
            result_target_sha: TARGET,
            method: "external",
            operator: context.actor,
            override_reason: context.reason,
            operation_id: context.operationId,
            authorization_id: "authorization-1",
            observation_nonce: "observation-1",
            done_criteria_sha256: HASH,
          },
        },
      };
    },
  };
  let cleanupCalls = 0;
  const cleanupMerged = async (inspection) => {
    cleanupCalls += 1;
    assert.equal(inspection.derived.terminal, true);
    assert.equal(inspection.derived.reason, "merged");
    return { status: cleanupCalls === 1 ? "removed" : "already_absent" };
  };
  await assert.rejects(recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects, cleanupMerged,
  }), /crash_after_terminal_fact/);
  assert.equal(h.state.facts.filter((fact) => fact.type === "merge_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 0);
  assert.deepEqual(h.state.effects, ["record_external_merge"]);

  const retry = await recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects, cleanupMerged,
  });
  assert.equal(retry.status, "converged");
  assert.deepEqual(retry.cleanup, { status: "removed" });
  assert.deepEqual(h.state.effects, ["record_external_merge"]);
  assert.equal(h.state.facts.filter((fact) => fact.type === "merge_recorded").length, 1);
  assert.equal(h.state.facts.filter((fact) => fact.type === "recovery_applied").length, 0);

  const factBytes = JSON.stringify(h.state.facts);
  const receiptWrites = h.state.writes;
  const completed = await recoverRun({
    ...h, writeReceipt, actor: "owner", reason: "reconcile external merge", effects,
    expectedActionKey: retry.action_key, cleanupMerged,
  });
  assert.equal(completed.status, "noop");
  assert.deepEqual(completed.cleanup, { status: "already_absent" });
  assert.equal(JSON.stringify(h.state.facts), factBytes);
  assert.deepEqual(h.state.effects, ["record_external_merge"]);
  assert.equal(h.state.writes, receiptWrites);
});
