"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runStore = require("../../relay-dispatch/scripts/run-store");

const SHA1_RE = /^[0-9a-f]{40}$/;
const PASS_VERDICTS = new Set(["lgtm", "pass"]);

function fail(message, code = "MERGE_GATE_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function git(repo, args) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonicalRepository(input) {
  const checkout = fs.realpathSync(path.resolve(input));
  const topLevel = fs.realpathSync(git(checkout, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== checkout) fail("--repo must be a canonical Git checkout root", "MERGE_USAGE");
  const commonDir = fs.realpathSync(path.resolve(
    checkout,
    git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ));
  const repoRoot = fs.realpathSync(path.dirname(commonDir));
  let remote;
  try { remote = git(checkout, ["remote", "get-url", "origin"]); }
  catch { remote = `local/${path.basename(repoRoot)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return {
    checkout,
    commonDir,
    repoRoot,
    remote: github ? `${github[1]}/${github[2]}` : remote,
  };
}

function relayHome() {
  return path.resolve(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"));
}

function repoSlug(repoRoot) {
  const base = path.basename(repoRoot).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "repo";
  return `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
}

function resolveRun({ repo = ".", runDir = null, runId = null }) {
  if (Boolean(runDir) === Boolean(runId)) {
    fail("supply exactly one of --run-dir or --run-id", "MERGE_USAGE");
  }
  const identity = canonicalRepository(repo);
  const resolvedRunDir = runDir
    ? fs.realpathSync(path.resolve(runDir))
    : fs.realpathSync(path.join(
        process.env.RELAY_RUNS_BASE || path.join(relayHome(), "runs"),
        repoSlug(identity.repoRoot),
        runId,
      ));
  const record = runStore.readRunRecord({ runDir: resolvedRunDir });
  if (record.repo.root !== identity.repoRoot || record.repo.remote !== identity.remote) {
    fail("run.json repository identity does not match --repo", "RUN_REPOSITORY_MISMATCH");
  }
  if (runId && record.run_id !== runId) {
    fail("run.json identity does not match --run-id", "RUN_ID_MISMATCH");
  }
  return { identity, runDir: resolvedRunDir, record };
}

function latestFact(facts, type) {
  return facts.filter((fact) => fact.type === type).at(-1) || null;
}

function requireMergeAction(inspection, record) {
  if (!inspection || inspection.operation !== "inspect") {
    fail("merge requires a canonical Relay inspection", "MERGE_INSPECTION_INVALID");
  }
  if (inspection.blockers?.length) {
    fail(`merge is blocked: ${inspection.blockers[0].code}`, "MERGE_BLOCKED");
  }
  if (inspection.derived?.action !== "merge" || inspection.recommended_action?.kind !== "merge") {
    fail(
      `derived lifecycle action is '${inspection.recommended_action?.kind || inspection.derived?.action || "unknown"}', not 'merge'`,
      "MERGE_ACTION_MISMATCH",
    );
  }

  const github = inspection.observations?.github || {};
  const gitObservation = inspection.observations?.git || {};
  const head = inspection.derived.head_sha;
  const prNumber = inspection.derived.pr_number;
  if (
    github.available !== true
    || github.lookup_complete !== true
    || github.pr_state !== "OPEN"
  ) fail("live GitHub observation must prove one open PR", "MERGE_GITHUB_STATE_MISMATCH");
  if (
    !Number.isInteger(prNumber) || prNumber < 1
    || github.pr_number !== prNumber
    || github.repo !== record.repo.remote
    || github.head_ref !== record.git.branch
    || github.base_ref !== record.git.base_branch
  ) fail("live PR identity does not match the immutable run", "MERGE_PR_MISMATCH");
  if (
    !SHA1_RE.test(String(head || ""))
    || github.pr_head_sha !== head
    || gitObservation.head_sha !== head
    || gitObservation.remote_head_sha !== head
    || inspection.derived.reviewed_sha !== head
  ) fail("live PR, remote branch, worktree, and reviewed SHA must match exactly", "MERGE_HEAD_MISMATCH");
  if (gitObservation.reviewable_dirty === true) {
    fail("reviewed worktree has uncommitted reviewable changes", "MERGE_DIRTY_WORKTREE");
  }

  const durablePr = latestFact(inspection.facts, "pull_request_recorded");
  if (
    !durablePr
    || durablePr.payload.pr_number !== prNumber
    || durablePr.payload.repo !== record.repo.remote
    || durablePr.payload.head_ref !== record.git.branch
    || durablePr.payload.base_ref !== record.git.base_branch
    || durablePr.payload.head_sha !== head
  ) fail("durable PR fact does not match the exact live PR", "MERGE_PR_FACT_MISMATCH");

  const review = latestFact(inspection.facts, "review_recorded");
  if (
    !review
    || !PASS_VERDICTS.has(review.payload.verdict)
    || review.payload.reviewed_sha !== head
    || review.payload.done_criteria_sha256 !== record.contract.done_criteria_sha256
    || review.payload.reviewer !== record.roles.reviewer
  ) fail("passing review is not bound to the exact head and frozen Done Criteria", "MERGE_REVIEW_MISMATCH");
  if (!SHA1_RE.test(String(review.payload.base_sha || ""))) {
    fail("passing review is missing its exact reviewed base SHA; run a fresh review", "MERGE_REVIEW_BASE_MISSING");
  }
  if (!SHA1_RE.test(String(github.pr_base_sha || ""))) {
    fail("live PR observation is missing its exact base SHA", "MERGE_LIVE_BASE_MISSING");
  }

  const verification = latestFact(inspection.facts, "verification_recorded");
  if (
    !verification
    || verification.payload.status !== "passed"
    || verification.payload.exit_code !== 0
    || verification.payload.head_sha !== head
    || verification.payload.tree_sha !== gitObservation.tree_sha
    || verification.payload.done_criteria_sha256 !== record.contract.done_criteria_sha256
  ) fail("passing verification is not bound to the exact head, tree, and Done Criteria", "MERGE_VERIFICATION_MISMATCH");

  return { head, prNumber, review, verification, reviewedBase: review.payload.base_sha, liveBase: github.pr_base_sha };
}

function terminalMergeFact(runDir, factsModule) {
  const journal = factsModule.readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  if (journal.tailIncomplete) fail("facts journal has an incomplete tail", "MERGE_FACT_TAIL_INCOMPLETE");
  const merges = journal.facts.filter((fact) => fact.type === "merge_recorded");
  const closes = journal.facts.filter((fact) => fact.type === "run_closed");
  if (merges.length > 1 || closes.length > 1 || (merges.length && closes.length)) {
    fail("run contains conflicting terminal facts", "MERGE_FACT_CONFLICT");
  }
  return { fact: merges[0] || null, facts: journal.facts };
}

module.exports = {
  canonicalRepository,
  fail,
  requireMergeAction,
  resolveRun,
  terminalMergeFact,
};
