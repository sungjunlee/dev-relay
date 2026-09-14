#!/usr/bin/env node
"use strict";

/** Plain Git publication of an already reviewed revision. Not recover, merge, or a change request. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { execGit } = require("../../relay-dispatch/scripts/exec");
const { readFacts } = require("../../relay-dispatch/scripts/facts");
const { readRunRecord } = require("../../relay-dispatch/scripts/run-store");

const ZERO_OID = "0".repeat(40);
const SHA1_RE = /^[0-9a-f]{40}$/i;
const DEST_REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PASSING_VERDICTS = new Set(["pass", "lgtm"]);
const SUCCESS_OUTCOMES = new Set(["published", "already_published"]);
const FLAGS = [
  "--run-dir", "--repo", "--remote", "--ref", "--expected-old",
  "--json", "--help", "-h",
];
const CLI = {
  reservedFlags: FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--run-dir", "--repo", "--remote", "--ref", "--expected-old"],
};

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function parseCli(argv) {
  const known = new Set(FLAGS);
  const bool = new Set(CLI.booleanFlags);
  const verbatim = new Set(CLI.verbatimValueFlags);
  const consumed = new Set();
  const name = (token) => String(token).split("=", 1)[0];
  const accepts = (flag, value) => value !== undefined && (
    verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value)))
  );
  argv.forEach((token, index) => {
    const flag = name(token);
    if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) {
      consumed.add(index + 1);
    }
  });
  const unknown = argv.filter((token, index) => (
    !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))
  ));
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  return {
    hasFlag: (flags) => (Array.isArray(flags) ? flags : [flags]).some((flag) => (
      argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))
    )),
    getArg: (flag, fallback) => {
      for (let index = 0; index < argv.length; index += 1) {
        if (consumed.has(index)) continue;
        const token = String(argv[index]);
        if (token === flag || token.startsWith(`${flag}=`)) {
          const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1);
          if (!accepts(flag, value)) return fallback;
          if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`);
          return value;
        }
      }
      return fallback;
    },
  };
}

function usage() {
  return [
    "Usage:",
    "  publish-reviewed-revision.js --run-dir <path> --remote <url> --ref <refs/heads/...> --expected-old <oid> [--repo <path>] [--json]",
    "",
    "Publishes one already reviewed revision to a plain Git remote with a compare-and-swap ref update.",
    "Does not open a change request, authorize landing, or append run facts.",
  ].join("\n");
}

function normalizeOid(value) {
  if (value == null || value === "") return ZERO_OID;
  if (typeof value !== "string" || !SHA1_RE.test(value)) {
    fail("PUBLICATION_OID_INVALID", `OID must be 40 hex characters: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function assertDestinationRef(value) {
  if (typeof value !== "string" || !DEST_REF_RE.test(value) || value.includes("..") || value.includes("//")) {
    fail("PUBLICATION_REF_INVALID", `destination ref must be a refs/heads/ name: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertRemoteUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("-")) {
    fail("PUBLICATION_REMOTE_INVALID", "remote URL identity is required");
  }
  return value.trim();
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function lastMatching(facts, predicate) {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    if (predicate(facts[index])) return facts[index];
  }
  return null;
}

function loadReviewedResult(runDir) {
  const canonical = fs.realpathSync(runDir);
  const record = readRunRecord({ runDir: canonical });
  const { facts } = readFacts({ eventsPath: path.join(canonical, "events.jsonl") });
  const closed = lastMatching(facts, (fact) => (
    fact.type === "run_closed" && fact.payload.reason === "reviewed_result_ready"
  ));
  if (!closed) {
    fail("REVIEWED_RESULT_REQUIRED", "publication requires a terminal reviewed result");
  }
  const closedIndex = facts.indexOf(closed);
  const preceding = facts.slice(0, closedIndex);
  const reviewedSha = normalizeOid(closed.payload.last_sha);
  const review = lastMatching(preceding, (fact) => (
    fact.type === "review_recorded"
    && PASSING_VERDICTS.has(fact.payload.verdict)
    && normalizeOid(fact.payload.reviewed_sha) === reviewedSha
    && fact.payload.done_criteria_sha256 === record.contract.done_criteria_sha256
  ));
  if (!review) {
    fail("REVIEWED_RESULT_REQUIRED", "publication requires a passing review bound to the closed revision");
  }
  const verification = lastMatching(preceding, (fact) => (
    fact.type === "verification_recorded"
    && fact.payload.status === "passed"
    && normalizeOid(fact.payload.head_sha) === reviewedSha
    && fact.payload.done_criteria_sha256 === record.contract.done_criteria_sha256
  ));
  if (!verification) {
    fail("REVIEWED_RESULT_REQUIRED", "publication requires passed verification bound to the closed revision");
  }
  return Object.freeze({
    kind: "reviewed_result",
    run_id: record.run_id,
    run_dir: canonical,
    reviewed_sha: reviewedSha,
    tree_sha: normalizeOid(verification.payload.tree_sha),
    done_criteria_sha256: record.contract.done_criteria_sha256,
    close_event_id: closed.event_id,
    review_event_id: review.event_id,
    verification_event_id: verification.event_id,
    source_repo: record.repo.root,
  });
}

function observeRemoteOid(sourceRepo, remoteUrl, destinationRef) {
  let output;
  try {
    output = execGit(sourceRepo, ["ls-remote", remoteUrl, destinationRef]);
  } catch (error) {
    fail("PUBLICATION_TRANSPORT_AMBIGUOUS", `remote observation failed: ${error.stderr || error.message}`, {
      cause: error,
    });
  }
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [oid, ref] = line.split("\t");
    if (ref === destinationRef && SHA1_RE.test(oid || "")) return normalizeOid(oid);
  }
  return ZERO_OID;
}

function classifyObservation(observedOid, expectedOldOid, publishedOid) {
  const observed = normalizeOid(observedOid);
  if (observed === publishedOid) return "already_published";
  if (observed === expectedOldOid) return "awaiting_cas";
  return "conflict";
}

function assertCasPushArgv(args) {
  for (const arg of args) {
    if (arg === "--force" || arg === "-f" || arg === "--force-with-lease") {
      fail("PUBLICATION_FORCE_REFUSED", "publication refuses force-push");
    }
  }
  const lease = args.find((arg) => String(arg).startsWith("--force-with-lease="));
  if (!lease || !lease.includes(":")) {
    fail("PUBLICATION_FORCE_REFUSED", "publication requires an expected-old-object lease");
  }
}

function casPush(sourceRepo, remoteUrl, destinationRef, expectedOldOid, publishedOid) {
  const args = [
    "push",
    `--force-with-lease=${destinationRef}:${expectedOldOid}`,
    remoteUrl,
    `${publishedOid}:${destinationRef}`,
  ];
  assertCasPushArgv(args);
  execGit(sourceRepo, args);
}

function gitErrorText(error) {
  return `${error.stderr || ""}\n${error.message || ""}`;
}

function isLeaseRejection(error) {
  return /stale info|non-fast-forward|failed to push some refs/i.test(gitErrorText(error));
}

function receiptIdentity(receipt) {
  return {
    schema_version: receipt.schema_version,
    kind: receipt.kind,
    run_id: receipt.run_id,
    reviewed_sha: receipt.reviewed_sha,
    remote_url: receipt.remote_url,
    destination_ref: receipt.destination_ref,
    expected_old_oid: receipt.expected_old_oid,
    published_oid: receipt.published_oid,
  };
}

function writeReceipt(filePath, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(directory);
    return receipt;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const sameIdentity = JSON.stringify(receiptIdentity(existing)) === JSON.stringify(receiptIdentity(receipt));
    if (sameIdentity && SUCCESS_OUTCOMES.has(existing.outcome) && SUCCESS_OUTCOMES.has(receipt.outcome)) {
      return existing;
    }
    if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing;
    fail("PUBLICATION_RECEIPT_CONFLICT", "publication receipt already exists with different bytes");
  }
}

function requireLocalCommit(sourceRepo, oid) {
  try {
    execGit(sourceRepo, ["cat-file", "-e", `${oid}^{commit}`]);
  } catch (error) {
    fail("PUBLICATION_OBJECT_MISSING", `reviewed commit is not in the source repository: ${oid}`, { cause: error });
  }
}

function receiptPathFor(runDir, remoteUrl, destinationRef, publishedOid) {
  const digest = crypto.createHash("sha256")
    .update([remoteUrl, destinationRef, publishedOid].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return path.join(runDir, `publication-receipt-${digest}.json`);
}

function buildReceipt({ reviewedResult, remoteUrl, destinationRef, expectedOldOid, publishedOid, observedOid, outcome }) {
  return {
    schema_version: 1,
    kind: "plain-git-publication",
    run_id: reviewedResult.run_id,
    reviewed_sha: reviewedResult.reviewed_sha,
    remote_url: remoteUrl,
    destination_ref: destinationRef,
    expected_old_oid: expectedOldOid,
    published_oid: publishedOid,
    observation: {
      method: "ls-remote",
      remote_oid: observedOid,
      at: new Date().toISOString(),
    },
    outcome,
  };
}

function settle({ reviewedResult, remoteUrl, destinationRef, expectedOldOid, publishedOid, observedOid, outcome }) {
  if (observedOid !== publishedOid) {
    fail("PUBLICATION_OBSERVATION_MISMATCH", "post-operation remote observation did not confirm the published OID");
  }
  const receipt = buildReceipt({
    reviewedResult, remoteUrl, destinationRef, expectedOldOid, publishedOid, observedOid, outcome,
  });
  const filePath = receiptPathFor(reviewedResult.run_dir, remoteUrl, destinationRef, publishedOid);
  const stored = writeReceipt(filePath, receipt);
  return { ...stored, receipt_path: filePath };
}

function conflict(observedOid, publishedOid) {
  fail("PUBLICATION_CONFLICT", "destination moved concurrently; publication fails closed without force-push", {
    observed_oid: observedOid,
    published_oid: publishedOid,
  });
}

function pushWithObserve(sourceRepo, remoteUrl, destinationRef, expectedOldOid, publishedOid) {
  try {
    casPush(sourceRepo, remoteUrl, destinationRef, expectedOldOid, publishedOid);
  } catch (error) {
    const observed = observeRemoteOid(sourceRepo, remoteUrl, destinationRef);
    const classified = classifyObservation(observed, expectedOldOid, publishedOid);
    if (classified === "already_published") return { observed, outcome: "already_published" };
    if (classified === "conflict" || isLeaseRejection(error)) {
      conflict(observed, publishedOid);
    }
    fail("PUBLICATION_TRANSPORT_AMBIGUOUS", `publication transport failed before a confirmed observation: ${gitErrorText(error).trim()}`, {
      cause: error,
    });
  }
  const observed = observeRemoteOid(sourceRepo, remoteUrl, destinationRef);
  if (observed === publishedOid) return { observed, outcome: "published" };
  if (classifyObservation(observed, expectedOldOid, publishedOid) === "conflict") {
    conflict(observed, publishedOid);
  }
  fail("PUBLICATION_OBSERVATION_MISMATCH", "post-operation remote observation did not confirm the published OID", {
    observed_oid: observed,
    published_oid: publishedOid,
  });
}

function publishReviewedRevision({
  reviewedResult,
  remoteUrl,
  destinationRef,
  expectedOldOid,
  sourceRepo,
}) {
  if (!reviewedResult || reviewedResult.kind !== "reviewed_result") {
    fail("REVIEWED_RESULT_REQUIRED", "a reviewed result is the immutable input to publication");
  }
  const remote = assertRemoteUrl(remoteUrl);
  const dest = assertDestinationRef(destinationRef);
  const expected = normalizeOid(expectedOldOid);
  const published = normalizeOid(reviewedResult.reviewed_sha);
  const repo = sourceRepo || reviewedResult.source_repo;
  if (typeof repo !== "string" || !repo.trim()) {
    fail("PUBLICATION_REPO_INVALID", "source repository is required");
  }
  requireLocalCommit(repo, published);

  const before = observeRemoteOid(repo, remote, dest);
  const classified = classifyObservation(before, expected, published);
  if (classified === "already_published") {
    return settle({
      reviewedResult, remoteUrl: remote, destinationRef: dest, expectedOldOid: expected,
      publishedOid: published, observedOid: before, outcome: "already_published",
    });
  }
  if (classified === "conflict") conflict(before, published);

  let pushed;
  try {
    pushed = pushWithObserve(repo, remote, dest, expected, published);
  } catch (error) {
    if (error.code !== "PUBLICATION_TRANSPORT_AMBIGUOUS") throw error;
    pushed = pushWithObserve(repo, remote, dest, expected, published);
  }
  return settle({
    reviewedResult, remoteUrl: remote, destinationRef: dest, expectedOldOid: expected,
    publishedOid: published, observedOid: pushed.observed, outcome: pushed.outcome,
  });
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseCli(argv);
    if (args.hasFlag(["--help", "-h"])) {
      console.log(usage());
      return 0;
    }
    const runDir = args.getArg("--run-dir");
    if (!runDir) throw new Error("--run-dir is required");
    const expectedOld = args.getArg("--expected-old");
    if (expectedOld === undefined) throw new Error("--expected-old is required");
    const result = publishReviewedRevision({
      reviewedResult: loadReviewedResult(path.resolve(runDir)),
      remoteUrl: args.getArg("--remote"),
      destinationRef: args.getArg("--ref"),
      expectedOldOid: expectedOld,
      sourceRepo: args.getArg("--repo") ? path.resolve(args.getArg("--repo")) : undefined,
    });
    if (args.hasFlag("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.outcome} ${result.published_oid} ${result.destination_ref}`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (!String(error.message || "").startsWith("unknown flags:")) console.error(usage());
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ZERO_OID,
  classifyObservation,
  loadReviewedResult,
  main,
  publishReviewedRevision,
};
