"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const {
  ZERO_OID,
  loadReviewedResult,
  publishReviewedRevision,
} = require("../../../skills/relay/scripts/publish-reviewed-revision");

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "skills/relay/scripts/publish-reviewed-revision.js");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fact(runId, type, payload, eventId = type) {
  return {
    event_id: eventId,
    run_id: runId,
    type,
    at: "2026-09-14T00:00:00.000Z",
    actor: "owner",
    payload,
  };
}

function writeFacts(runDir, facts) {
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${facts.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function fixture({ closed = true, passingReview = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-plain-git-pub-")));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const runId = "issue-1211-plain-git-pub";
  const runDir = path.join(root, runId);
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  git(repo, ["config", "user.name", "Publication Test"]);
  git(repo, ["config", "user.email", "pub@example.test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  const startSha = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, "README.md"), "reviewed\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "reviewed"]);
  const reviewedSha = git(repo, ["rev-parse", "HEAD"]);
  const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);
  git(repo, ["branch", "reviewed", reviewedSha]);
  git(repo, ["checkout", "-B", "mover", startSha]);
  fs.writeFileSync(path.join(repo, "README.md"), "concurrent\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "concurrent"]);
  const concurrentSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-B", "work", reviewedSha]);
  const criteria = "done\n";
  fs.writeFileSync(path.join(runDir, "done-criteria.md"), criteria);
  const criteriaHash = sha256(criteria);
  createRunRecord({
    runDir,
    record: {
      version: 3,
      run_id: runId,
      repo: { root: repo, remote: "local/repo" },
      git: { branch: "work", base_branch: "main", worktree: repo, start_sha: startSha },
      contract: {
        done_criteria_path: path.join(runDir, "done-criteria.md"),
        done_criteria_sha256: criteriaHash,
      },
      roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
      parent: null,
      ownership_digest: null,
      created_at: "2026-09-14T00:00:00.000Z",
    },
  });
  const facts = [
    fact(runId, "verification_recorded", {
      head_sha: reviewedSha,
      tree_sha: treeSha,
      done_criteria_sha256: criteriaHash,
      command: "node --test",
      verification_request_sha256: criteriaHash,
      declared_command_count: 1,
      completed_command_count: 1,
      result_path: path.join(runDir, "verification.log"),
      result_sha256: sha256("ok\n"),
      exit_code: 0,
      status: "passed",
      operator: "owner",
    }, "verification-1"),
  ];
  if (passingReview) {
    facts.push(fact(runId, "review_recorded", {
      round: 1,
      verdict: "lgtm",
      reviewed_sha: reviewedSha,
      base_sha: startSha,
      done_criteria_sha256: criteriaHash,
      reviewer: "claude",
      review_artifact: path.join(runDir, "review.json"),
      override: null,
    }, "review-1"));
  }
  if (closed) {
    facts.push(fact(runId, "run_closed", {
      reason: "reviewed_result_ready",
      operator: "owner",
      last_sha: reviewedSha,
      pr_number: null,
    }, "close-1"));
  }
  writeFacts(runDir, facts);
  fs.writeFileSync(path.join(runDir, "verification.log"), "ok\n");
  const eventsBefore = fs.readFileSync(path.join(runDir, "events.jsonl"));
  const gitLog = path.join(root, "git.log");
  const gitBin = path.join(root, "git-wrapper.js");
  const pushCount = path.join(root, "push-count");
  fs.writeFileSync(pushCount, "0");
  fs.writeFileSync(gitBin, `#!/usr/bin/env node
const fs=require("fs"),{spawnSync}=require("child_process");
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args)+"\\n");
const push = args.includes("push");
const countFile=${JSON.stringify(pushCount)};
if (push) {
  const n=Number(fs.readFileSync(countFile,"utf8")||"0");
  fs.writeFileSync(countFile, String(n+1));
  if (process.env.RELAY_PUSH_FAULT==="reject-first" && n===0) {
    process.stderr.write("fatal: unable to access remote: Connection timed out\\n");
    process.exit(128);
  }
}
const result=spawnSync("git", args, {encoding:"utf8"});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (push && process.env.RELAY_PUSH_FAULT==="hangup-after-apply" && Number(fs.readFileSync(countFile,"utf8"))===1) {
  process.stderr.write("fatal: the remote end hung up unexpectedly\\n");
  process.exit(128);
}
process.exit(result.status===null?1:result.status);
`);
  fs.chmodSync(gitBin, 0o755);
  const ghMarker = path.join(root, "gh-called");
  const gh = path.join(root, "gh-trap.js");
  fs.writeFileSync(gh, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(ghMarker)}, "called");\nprocess.exit(91);\n`);
  fs.chmodSync(gh, 0o755);
  return {
    root, repo, remote, runDir, runId, startSha, reviewedSha, concurrentSha,
    eventsBefore, gitBin, gitLog, gh, ghMarker,
  };
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function publish(value, overrides = {}) {
  const previousGit = process.env.RELAY_GIT_BIN;
  const previousGh = process.env.RELAY_GH_BIN;
  process.env.RELAY_GIT_BIN = value.gitBin;
  process.env.RELAY_GH_BIN = value.gh;
  try {
    return publishReviewedRevision({
      reviewedResult: loadReviewedResult(value.runDir),
      remoteUrl: value.remote,
      destinationRef: "refs/heads/published",
      expectedOldOid: ZERO_OID,
      sourceRepo: value.repo,
      ...overrides,
    });
  } finally {
    restoreEnv("RELAY_GIT_BIN", previousGit);
    restoreEnv("RELAY_GH_BIN", previousGh);
  }
}

function remoteOid(value, ref = "refs/heads/published") {
  try {
    return git(value.remote, ["rev-parse", ref]);
  } catch {
    return ZERO_OID;
  }
}

function gitArgv(value) {
  if (!fs.existsSync(value.gitLog)) return [];
  return fs.readFileSync(value.gitLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("#1211 production seam does not synthesize change-request or landing facts", () => {
  assert.doesNotMatch(SOURCE, /appendFact/);
  assert.doesNotMatch(SOURCE, /execGh/);
  assert.doesNotMatch(SOURCE, /merge_recorded/);
  assert.doesNotMatch(SOURCE, /pull_request_recorded/);
});

test("#1211 a reviewed result is the immutable input; unpublished work is refused", (t) => {
  const value = fixture({ closed: false });
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  assert.throws(() => loadReviewedResult(value.runDir), /terminal reviewed result/);
  const closed = fixture({ passingReview: false });
  t.after(() => fs.rmSync(closed.root, { recursive: true, force: true }));
  assert.throws(() => loadReviewedResult(closed.runDir), /passing review/);
});

test("#1211 CAS publish records remote identity, ref, expected old, published OID, and observation", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const result = publish(value);
  assert.equal(result.outcome, "published");
  assert.equal(result.kind, "plain-git-publication");
  assert.equal(result.run_id, value.runId);
  assert.equal(result.reviewed_sha, value.reviewedSha);
  assert.equal(result.remote_url, value.remote);
  assert.equal(result.destination_ref, "refs/heads/published");
  assert.equal(result.expected_old_oid, ZERO_OID);
  assert.equal(result.published_oid, value.reviewedSha);
  assert.equal(result.observation.method, "ls-remote");
  assert.equal(result.observation.remote_oid, value.reviewedSha);
  assert.equal(remoteOid(value), value.reviewedSha);
  const stored = JSON.parse(fs.readFileSync(result.receipt_path, "utf8"));
  assert.equal(stored.published_oid, value.reviewedSha);
  assert.equal(stored.observation.remote_oid, value.reviewedSha);
  assert.deepEqual(fs.readFileSync(path.join(value.runDir, "events.jsonl")), value.eventsBefore);
  assert.equal(fs.existsSync(value.ghMarker), false);
  for (const argv of gitArgv(value)) {
    assert.equal(argv.includes("--force"), false);
    assert.equal(argv.includes("-f"), false);
  }
  const retry = publish(value);
  assert.equal(retry.outcome, "published");
  assert.equal(retry.receipt_path, result.receipt_path);
  assert.equal(retry.published_oid, value.reviewedSha);
  assert.equal(remoteOid(value), value.reviewedSha);
  assert.deepEqual(fs.readFileSync(path.join(value.runDir, "events.jsonl")), value.eventsBefore);
  assert.equal(gitArgv(value).filter((argv) => argv.includes("push")).length, 1);
});

test("#1211 concurrent destination movement fails closed without force-push", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  git(value.repo, ["push", value.remote, `${value.startSha}:refs/heads/published`]);
  git(value.repo, ["push", value.remote, `${value.concurrentSha}:refs/heads/published`]);
  assert.equal(remoteOid(value), value.concurrentSha);
  assert.throws(
    () => publish(value, { expectedOldOid: value.startSha }),
    (error) => {
      assert.equal(error.code, "PUBLICATION_CONFLICT");
      assert.match(error.message, /fails closed without force-push/);
      return true;
    },
  );
  assert.equal(remoteOid(value), value.concurrentSha);
  assert.equal(fs.existsSync(value.ghMarker), false);
  assert.deepEqual(fs.readFileSync(path.join(value.runDir, "events.jsonl")), value.eventsBefore);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("publication-receipt-")), false);
  for (const argv of gitArgv(value)) {
    assert.equal(argv.includes("--force"), false);
    assert.equal(argv.includes("-f"), false);
    const lease = argv.find((arg) => String(arg).startsWith("--force-with-lease="));
    if (argv.includes("push") && lease) assert.match(lease, /:[0-9a-f]{40}$/i);
  }
});

test("#1211 retry after ambiguous transport failure converges to published", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const previousFault = process.env.RELAY_PUSH_FAULT;
  process.env.RELAY_PUSH_FAULT = "reject-first";
  try {
    const result = publish(value);
    assert.equal(result.outcome, "published");
    assert.equal(result.observation.remote_oid, value.reviewedSha);
    assert.equal(remoteOid(value), value.reviewedSha);
  } finally {
    restoreEnv("RELAY_PUSH_FAULT", previousFault);
  }
});

test("#1211 retry after ambiguous success converges to already-published without a second update", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const previousFault = process.env.RELAY_PUSH_FAULT;
  process.env.RELAY_PUSH_FAULT = "hangup-after-apply";
  try {
    const result = publish(value);
    assert.equal(result.outcome, "already_published");
    assert.equal(result.published_oid, value.reviewedSha);
    assert.equal(result.observation.remote_oid, value.reviewedSha);
    assert.equal(remoteOid(value), value.reviewedSha);
    assert.equal(gitArgv(value).filter((argv) => argv.includes("push")).length, 1);
  } finally {
    restoreEnv("RELAY_PUSH_FAULT", previousFault);
  }
});

test("#1211 CLI publishes from a closed run and rejects unknown flags", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const unknown = spawnSync(process.execPath, [SCRIPT, "--run-dir", value.runDir, "--no-merge"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flags/);
  assert.match(unknown.stderr, /--no-merge/);
  const result = spawnSync(process.execPath, [
    SCRIPT, "--run-dir", value.runDir, "--remote", value.remote,
    "--ref", "refs/heads/published", "--expected-old", ZERO_OID, "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, RELAY_GIT_BIN: value.gitBin, RELAY_GH_BIN: value.gh },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outcome, "published");
  assert.equal(payload.published_oid, value.reviewedSha);
  assert.equal(remoteOid(value), value.reviewedSha);
  assert.equal(fs.existsSync(value.ghMarker), false);
  assert.deepEqual(fs.readFileSync(path.join(value.runDir, "events.jsonl")), value.eventsBefore);
});

test("#1211 publication binds only review facts preceding the terminal close", (t) => {
  const value = fixture({ closed: true, passingReview: false });
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const events = fs.readFileSync(path.join(value.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const record = JSON.parse(fs.readFileSync(path.join(value.runDir, "run.json"), "utf8"));
  events.push(fact(value.runId, "review_recorded", {
    round: 1,
    verdict: "lgtm",
    reviewed_sha: value.reviewedSha,
    base_sha: value.startSha,
    done_criteria_sha256: record.contract.done_criteria_sha256,
    reviewer: "claude",
    review_artifact: path.join(value.runDir, "review.json"),
    override: null,
  }, "review-after-close"));
  writeFacts(value.runDir, events);
  assert.throws(() => loadReviewedResult(value.runDir), { code: "REVIEWED_RESULT_REQUIRED" });
});
