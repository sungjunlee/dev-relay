"use strict";

/** Terminal merge, base-integrity, and observer helpers for finalize-run. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const facts = require("../../relay-dispatch/scripts/facts");
const host = require("../../relay-dispatch/scripts/host");
const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const { cleanupWorktree } = require("../../relay-dispatch/scripts/cleanup-worktree");
const { fail } = require("./review-gate");

const SHA1_RE = /^[0-9a-f]{40}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

function command(repo, executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function gitRaw(repo, args) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulFields(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("Git path evidence must be bytes", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) fail("Git path evidence has an incomplete record", "MERGE_BASE_EVIDENCE_INCOMPLETE");
    const value = bytes.subarray(offset, end);
    const decoded = value.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(value)) {
      fail("Git path evidence contains a non-UTF-8 path", "MERGE_BASE_EVIDENCE_INCOMPLETE");
    }
    if (!decoded) fail("Git path evidence contains an empty field", "MERGE_BASE_EVIDENCE_INCOMPLETE");
    fields.push(decoded);
    offset = end + 1;
  }
  return fields;
}

function reviewedDiffPaths(bytes) {
  const fields = nulFields(bytes);
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const scored = /^([RC])([0-9]{1,3})$/.exec(status);
    if (!/^[ADMTUXB]$/.test(status) && (!scored || Number(scored[2]) > 100)) {
      fail("Git path evidence contains an invalid status", "MERGE_BASE_EVIDENCE_INCOMPLETE");
    }
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (index + count > fields.length) {
      fail("Git path evidence has an incomplete status record", "MERGE_BASE_EVIDENCE_INCOMPLETE");
    }
    paths.push(...fields.slice(index, index + count));
    index += count;
  }
  return paths;
}

function gh(repo, args) {
  return command(repo, process.env.RELAY_GH_BIN || "gh", args);
}

function githubApiPages(repo, endpoint) {
  const value = JSON.parse(gh(repo, ["api", "--paginate", "--slurp", endpoint]));
  if (!Array.isArray(value) || !value.length) fail("GitHub returned an incomplete paginated response", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  return value;
}

function assertBaseIntegrity(record, binding, liveBase) {
  const reviewedBase = binding.reviewedBase;
  if (!SHA1_RE.test(String(reviewedBase || "")) || !SHA1_RE.test(String(liveBase || ""))) {
    fail("reviewed and live base SHAs are required", "MERGE_BASE_EVIDENCE_MISSING");
  }
  if (reviewedBase === liveBase) return { status: "identical", overlapping_paths: [] };
  const comparePages = githubApiPages(
    record.repo.root,
    `repos/${record.repo.remote}/compare/${reviewedBase}...${liveBase}?per_page=100`,
  );
  const comparison = comparePages[0];
  if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) {
    fail("GitHub base-advance comparison is malformed", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  }
  if (comparison.status !== "ahead") {
    fail("live PR base is not a descendant of the reviewed base", "MERGE_BASE_NOT_DESCENDANT");
  }
  if (
    comparison.base_commit?.sha !== reviewedBase
    || comparison.merge_base_commit?.sha !== reviewedBase
    || comparison.head_commit?.sha !== liveBase
    || comparePages.some((page) => !page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.commits))
  ) fail("GitHub comparison is not bound to the exact reviewed and live bases", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  const commits = comparePages.flatMap((page) => Array.isArray(page.commits) ? page.commits : []);
  const commitShas = commits.map((commit) => commit?.sha);
  if (
    !Number.isInteger(comparison.total_commits)
    || comparison.total_commits < 1
    || commits.length !== comparison.total_commits
    || commitShas.some((sha) => !SHA1_RE.test(String(sha || "")))
    || new Set(commitShas).size !== commitShas.length
    || commitShas.at(-1) !== liveBase
  ) {
    fail("GitHub base-advance commit pagination is incomplete", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  }
  const advancedFiles = Array.isArray(comparison.files) ? comparison.files : null;
  if (!advancedFiles || advancedFiles.length >= 300) {
    fail("GitHub base-advance file evidence is incomplete", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  }
  for (const file of advancedFiles) {
    if (
      !file
      || typeof file !== "object"
      || Array.isArray(file)
      || typeof file.filename !== "string"
      || file.filename.length === 0
      || (file.previous_filename !== undefined
        && (typeof file.previous_filename !== "string" || file.previous_filename.length === 0))
    ) fail("GitHub base-advance path evidence is malformed", "MERGE_BASE_EVIDENCE_INCOMPLETE");
  }
  const reviewedPaths = reviewedDiffPaths(gitRaw(record.git.worktree, [
    "diff", "--name-status", "-z", "--find-renames", "--no-ext-diff",
    `${record.git.start_sha}..${binding.head}`, "--",
  ]));
  const prPaths = new Set(reviewedPaths);
  const advancedPaths = advancedFiles.flatMap((file) => [file.filename, file.previous_filename]).filter(Boolean);
  const overlap = [...new Set(advancedPaths.filter((name) => prPaths.has(name)))].sort();
  if (overlap.length) {
    const error = new Error(`base advanced across reviewed PR paths: ${overlap.join(", ")}; update the branch onto the current base, then run canonical verification and review`);
    error.code = "MERGE_BASE_PATH_OVERLAP";
    error.collision_paths = overlap;
    throw error;
  }
  return { status: "advanced_without_overlap", overlapping_paths: [] };
}

function readRegularJson(filePath, label) {
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail(`${label} must be a regular non-symlink file`, "MERGE_ARTIFACT_INVALID");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      fail(`${label} changed identity while being read`, "MERGE_ARTIFACT_INVALID");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function githubToken(repo) {
  const direct = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (direct) return direct;
  try {
    const token = gh(repo, ["auth", "token"]);
    if (token) return token;
  } catch {}
  fail("GitHub revalidation requires GH_TOKEN/GITHUB_TOKEN or `gh auth login`", "GITHUB_AUTH_REQUIRED");
}

function mergeObserver(record) {
  const code = [
    "const fs=require('fs'),{execFileSync}=require('child_process');",
    "const i=process.argv.indexOf('--request-file');if(i<0)throw new Error('missing request');",
    "const input=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8')),q=input.request;",
    `const repo=${JSON.stringify(record.repo.remote)};`,
    "const b=process.argv.indexOf('--gh-bin'),bin=b>=0?process.argv[b+1]:'gh';",
    "const a=['pr','view',String(q.pr_number),'--repo',repo,'--json','number,state,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,headRepositoryOwner,mergeCommit,autoMergeRequest,mergeStateStatus'];",
    "const raw=execFileSync(process.argv.includes('--gh-node-script')?process.execPath:bin,process.argv.includes('--gh-node-script')?[bin,...a]:a,{encoding:'utf8',stdio:['ignore','pipe','pipe']});",
    "const p=JSON.parse(raw),hr=p.headRepository&&p.headRepository.nameWithOwner||(p.headRepositoryOwner&&p.headRepositoryOwner.login&&p.headRepository&&p.headRepository.name?`${p.headRepositoryOwner.login}/${p.headRepository.name}`:null);",
    `if((q.repo&&q.repo!==repo)||hr!==repo||p.headRefName!==${JSON.stringify(record.git.branch)})throw new Error('exact PR repo/head identity mismatch');`,
    "process.stdout.write(JSON.stringify({nonce:input.nonce,repo,head_repo:hr,pr_number:p.number,pr_state:p.state,pr_head_sha:p.headRefOid,pr_base_sha:p.baseRefOid,head_ref:p.headRefName,base_ref:p.baseRefName,merge_sha:p.mergeCommit&&p.mergeCommit.oid||null,auto_merge_request:p.autoMergeRequest||null,merge_state_status:p.mergeStateStatus||null}));",
  ].join("");
  const args = [
    { kind: "literal", value: "-e" },
    { kind: "literal", value: code },
    { kind: "literal", value: "--" },
  ];
  if (process.env.RELAY_GH_BIN) {
    args.push(
      { kind: "literal", value: "--gh-bin" },
      { kind: "staged_file", value: path.resolve(process.env.RELAY_GH_BIN) },
    );
    if (path.extname(process.env.RELAY_GH_BIN) === ".js") {
      args.push({ kind: "literal", value: "--gh-node-script" });
    }
  }
  return {
    command: process.execPath,
    args,
    env: { GH_TOKEN: githubToken(record.repo.root) },
    networkAccess: "enabled",
  };
}

function mergeFlag(method) {
  return `--${method}`;
}

function mergePullRequest(record, binding, method) {
  gh(record.repo.root, [
    "pr", "merge", String(binding.prNumber),
    "--repo", record.repo.remote,
    mergeFlag(method),
    "--match-head-commit", binding.head,
  ]);
}

function productionServices() {
  const { observeLivePr } = require("./finalize-run");
  function withRunLock(runDir, callback) {
    const canonical = fs.realpathSync(runDir);
    return host.withRunLock({ runDir: canonical, attemptId: `merge-${crypto.randomUUID()}`, operation: "merge",
      hostKind: "local_supervisor", hostHandle: `merge:${process.pid}`, worktreeDir: canonical }, callback);
  }
  return {
    cleanupWorktree,
    assertBaseIntegrity,
    inspectRun: inspectProductionRun,
    mergeObserver,
    mergePullRequest,
    observeLivePr,
    planOperatorMerge: facts.planOperatorMerge,
    recordMerge: facts.recordMerge,
    resumeOperatorMerge: facts.resumeOperatorMerge,
    revalidateExternalFacts: facts.revalidateExternalFacts,
    withRunLock,
    beforeMerge: () => {},
    afterMergeRequest: () => {},
    afterRequestIntent: () => {},
    afterMerge: () => {},
  };
}

async function finishTerminal({ resolved, mergeFact, cleanup, services, observer }) {
  const { assertExactPr } = require("./finalize-run");
  const { record, runDir } = resolved;
  const payload = mergeFact.payload;
  if (!SAFE_TOKEN_RE.test(String(payload.operation_id || ""))) {
    fail("terminal merge fact contains an unsafe operation id", "MERGE_TERMINAL_INVALID");
  }
  return services.withRunLock(runDir, async (lockContext) => {
    const binding = { prNumber: payload.pr_number, head: payload.pr_head_sha };
    const revalidated = await services.revalidateExternalFacts({
      runDir,
      lockContext,
      observer,
      request: {
        repo: record.repo.remote,
        operation_id: payload.operation_id,
        pr_number: binding.prNumber,
        expected_pr_head_sha: binding.head,
        expected_head_ref: record.git.branch,
        expected_base_ref: record.git.base_branch,
        expected_result_target_sha: payload.result_target_sha,
        required_state: "MERGED",
      },
      authorize: (observed) => {
        assertExactPr(observed, record, binding, new Set(["MERGED"]));
        if (observed.merge_sha !== payload.result_target_sha) {
          fail("terminal merge target changed", "MERGE_TARGET_MISMATCH");
        }
        return { authorized: true };
      },
    });
    const authorization = services.resumeOperatorMerge({
      runDir,
      lockContext,
      operationId: payload.operation_id,
      freshObservation: revalidated.observationCapability,
    });
    if (
      payload.authorization_id !== authorization.authorizationId
      || payload.method !== authorization.method
      || payload.operator !== authorization.actor
      || payload.pr_number !== authorization.prNumber
      || payload.pr_head_sha !== authorization.headSha
      || payload.reviewed_source_sha !== authorization.headSha
      || payload.done_criteria_sha256 !== authorization.doneCriteriaSha256
      || payload.override_reason !== authorization.overrideReason
    ) fail("terminal fact does not match its verified durable authorization", "MERGE_TERMINAL_AUTH_MISMATCH");
    const repaired = await services.recordMerge({
      eventsPath: path.join(runDir, "events.jsonl"),
      provenance: {
        pr_number: authorization.prNumber,
        reviewed_source_sha: authorization.headSha,
        pr_head_sha: authorization.headSha,
        result_target_sha: payload.result_target_sha,
        method: authorization.method,
        operator: authorization.actor,
        override_reason: authorization.overrideReason,
      },
      authorization,
      lockContext,
      observer,
    });
    const cleanupResult = cleanup
      ? await services.cleanupWorktree(record, repaired)
      : { status: "retained_by_request" };
    return {
      run_id: record.run_id,
      status: "merged",
      merge_performed: false,
      merge_recorded: true,
      pr_number: payload.pr_number,
      pr_head_sha: payload.pr_head_sha,
      result_target_sha: payload.result_target_sha,
      method: authorization.method,
      operator: authorization.actor,
      operation_id: authorization.operationId,
      cleanup: cleanupResult,
    };
  });
}

module.exports = {
  assertBaseIntegrity,
  finishTerminal,
  mergeObserver,
  productionServices,
  readRegularJson,
};
