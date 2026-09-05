"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../relay-dispatch/scripts/facts");
const host = require("../../relay-dispatch/scripts/host");
const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const runStore = require("../../relay-dispatch/scripts/run-store");

const SHA1_RE = /^[0-9a-f]{40}$/;
const VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const REVIEW_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    summary: { type: "string", minLength: 1 },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "file", "line", "severity"],
        properties: {
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"], minimum: 1 },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        },
      },
    },
  },
});

function fail(message, code = "REVIEW_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function git(repo, args) {
  return gitRaw(repo, args).trim();
}

function gitRaw(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function canonicalRepository(input) {
  const checkout = fs.realpathSync(path.resolve(input));
  if (fs.realpathSync(git(checkout, ["rev-parse", "--show-toplevel"])) !== checkout) {
    fail("--repo must be a canonical Git checkout root");
  }
  const commonDir = fs.realpathSync(path.resolve(checkout, git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  const repoRoot = fs.realpathSync(path.dirname(commonDir));
  let remote;
  try { remote = git(checkout, ["remote", "get-url", "origin"]); }
  catch { remote = `local/${path.basename(repoRoot)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return { checkout, commonDir, repoRoot, remote: github ? `${github[1]}/${github[2]}` : remote };
}

function relayHome() {
  return path.resolve(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"));
}

function repoSlug(repoRoot) {
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
}

function resolveRun(cli) {
  const identity = canonicalRepository(cli.repo);
  const runDir = cli.values["run-dir"]
    ? fs.realpathSync(path.resolve(cli.values["run-dir"]))
    : fs.realpathSync(path.join(process.env.RELAY_RUNS_BASE || path.join(relayHome(), "runs"), repoSlug(identity.repoRoot), cli.values["run-id"]));
  const record = runStore.readRunRecord({ runDir });
  if (record.repo.root !== identity.repoRoot || record.repo.remote !== identity.remote) {
    fail("run.json repository identity does not match --repo", "RUN_REPOSITORY_MISMATCH");
  }
  if (cli.values["run-id"] && record.run_id !== cli.values["run-id"]) fail("run.json identity does not match --run-id", "RUN_ID_MISMATCH");
  return { identity, runDir, record };
}

function reviewActionBindings(inspection, latestReview) {
  const retrying = inspection.recommended_action.reason === "review_retryable_escalation";
  const retryOfEventId = retrying ? inspection.derived.retry_of_event_id : null;
  if (retrying && (typeof retryOfEventId !== "string" || latestReview?.event_id !== retryOfEventId)) {
    fail("retry review action is not bound to the latest durable escalation", "REVIEW_RETRY_BINDING_MISMATCH");
  }
  const resolving = inspection.recommended_action.reason === "review_resolution_re_review";
  const resolutionOfEventId = resolving ? inspection.derived.resolution_of_event_id : null;
  const resolution = inspection.facts.filter((fact) => fact.type === "review_escalation_resolved").at(-1);
  if (resolving && (typeof resolutionOfEventId !== "string" || resolution?.event_id !== resolutionOfEventId
    || resolution.payload.escalated_review_event_id !== latestReview?.event_id)) {
    fail("resolved review action is not bound to the latest adjudication", "REVIEW_RESOLUTION_BINDING_MISMATCH");
  }
  return { retryOfEventId, resolutionOfEventId };
}

function requireReviewAction(inspection, record) {
  if (inspection.blockers?.length) fail(`review is blocked: ${inspection.blockers[0].code}`, "REVIEW_BLOCKED");
  const actionKind = inspection.recommended_action?.kind;
  if (actionKind !== "review" || inspection.derived?.action !== "review") {
    fail(`derived lifecycle action is '${inspection.recommended_action?.kind || "unknown"}', not 'review'`, "REVIEW_ACTION_MISMATCH");
  }
  const local = inspection.observations?.git?.local_delivery === true;
  if (local) {
    if (inspection.facts.some((fact) => fact.type === "pull_request_recorded")) {
      fail("local review cannot have a durable PR fact", "REVIEW_PR_FORBIDDEN");
    }
    const head = inspection.observations?.git?.head_sha;
    const tree = inspection.observations?.git?.tree_sha;
    if (!SHA1_RE.test(String(head || "")) || head !== inspection.derived.head_sha) {
      fail("local review head must exactly equal the fresh derived Git HEAD", "REVIEW_HEAD_MISMATCH");
    }
    if (!SHA1_RE.test(String(tree || "")) || inspection.observations.git.reviewable_dirty !== false) {
      fail("local review requires a fresh clean Git tree", "REVIEW_TREE_MISMATCH");
    }
    const verification = inspection.facts.filter((fact) => fact.type === "verification_recorded").at(-1);
    if (!verification
      || verification.payload.status !== "passed"
      || verification.payload.exit_code !== 0
      || verification.payload.head_sha !== head
      || verification.payload.tree_sha !== tree
      || verification.payload.done_criteria_sha256 !== record.contract.done_criteria_sha256) {
      fail("local review requires the exact latest passing verification event", "REVIEW_VERIFICATION_MISSING");
    }
    const latestReview = inspection.facts.filter((fact) => fact.type === "review_recorded").at(-1) || null;
    const { retryOfEventId, resolutionOfEventId } = reviewActionBindings(inspection, latestReview);
    return { head, tree, prNumber: null, verification, retryOfEventId, resolutionOfEventId, local: true };
  }
  const head = inspection.observations?.github?.pr_head_sha;
  const base = inspection.observations?.github?.pr_base_sha;
  const prNumber = inspection.observations?.github?.pr_number;
  if (!SHA1_RE.test(String(head || "")) || head !== inspection.derived.head_sha) {
    fail("live PR head must exactly equal the derived current head", "REVIEW_HEAD_MISMATCH");
  }
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber !== inspection.derived.pr_number) {
    fail("live PR identity must exactly equal the durable derived PR", "REVIEW_PR_MISMATCH");
  }
  if (!SHA1_RE.test(String(base || ""))) {
    fail("live PR base must be an exact commit SHA", "REVIEW_BASE_MISSING");
  }
  const durablePr = inspection.facts.filter((fact) => fact.type === "pull_request_recorded").at(-1);
  if (!durablePr || durablePr.payload.pr_number !== prNumber || durablePr.payload.head_sha !== head) {
    fail("review requires a durable PR fact for the exact live head", "REVIEW_PR_FACT_MISMATCH");
  }
  const verification = inspection.facts.filter((fact) => fact.type === "verification_recorded").findLast((fact) => (
    fact.payload.status === "passed"
    && fact.payload.head_sha === head
    && fact.payload.done_criteria_sha256 === record.contract.done_criteria_sha256
  ));
  if (!verification) fail("review requires passed verification for the exact head and Done Criteria", "REVIEW_VERIFICATION_MISSING");
  const latestReview = inspection.facts.filter((fact) => fact.type === "review_recorded").at(-1) || null;
  const { retryOfEventId, resolutionOfEventId } = reviewActionBindings(inspection, latestReview);
  return { head, base, prNumber, verification, retryOfEventId, resolutionOfEventId, local: false };
}

function reviewPrompt({ record, binding, criteria, diff }) {
  return [
    "[RELAY INDEPENDENT PRIMARY REVIEW]",
    "Return only one JSON object matching this schema:",
    JSON.stringify(REVIEW_RESULT_SCHEMA),
    "No markdown fences or text outside the object.",
    "A pass verdict means every frozen Done Criterion is satisfied at the exact reviewed commit.",
    "Advisory issues may accompany pass; any substantive issue must return changes_requested. Invocation or evidence uncertainty must return escalated.",
    "Do not modify files, create commits, post comments, or infer state outside this bundle.",
    "",
    `Run: ${record.run_id}`,
    `Repository: ${record.repo.remote}`,
    `Branch: ${record.git.branch} -> ${record.git.base_branch}`,
    binding.local ? "PR: none (local Git review)" : `PR: #${binding.prNumber}`,
    `Reviewed SHA: ${binding.head}`,
    `Base SHA: ${binding.base || record.git.start_sha}`,
    `Done Criteria SHA-256: ${record.contract.done_criteria_sha256}`,
    `Verification fact: ${JSON.stringify(binding.verification)}`,
    "",
    "## Frozen Done Criteria",
    criteria,
    "",
    "## Exact review diff",
    diff || "(empty diff)",
    "",
  ].join("\n");
}

function immutableBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    runStore.fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let existing;
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) fail(`immutable review artifact must be a regular file: ${filePath}`, "REVIEW_ARTIFACT_UNTRUSTED");
      existing = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        fail(`immutable review artifact changed while read: ${filePath}`, "REVIEW_ARTIFACT_UNTRUSTED");
      }
    } finally { fs.closeSync(fd); }
    if (!existing.equals(bytes)) fail(`immutable review artifact conflict: ${filePath}`, "REVIEW_ARTIFACT_CONFLICT");
  }
  return filePath;
}

function secureDigest(filePath, label) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail(`${label} must be a regular non-symlink file`, "REVIEW_ARTIFACT_UNTRUSTED");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size) {
      fail(`${label} changed while being read`, "REVIEW_ARTIFACT_UNTRUSTED");
    }
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function readFrozenCriteria(record) {
  const filePath = record.contract.done_criteria_path;
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("frozen Done Criteria must be a regular non-symlink file", "DONE_CRITERIA_UNTRUSTED");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || bytes.length !== after.size
    ) {
      fail("frozen Done Criteria changed while being read", "DONE_CRITERIA_UNTRUSTED");
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== record.contract.done_criteria_sha256) {
      fail("frozen Done Criteria bytes do not match the immutable run contract", "DONE_CRITERIA_HASH_MISMATCH");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeVerdict(output) {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); }
    catch (error) { fail(`reviewer result is not JSON: ${error.message}`, "REVIEW_RESULT_INVALID"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("reviewer result must be an object", "REVIEW_RESULT_INVALID");
  if (Object.keys(value).sort().join(",") !== "issues,summary,verdict") fail("reviewer result has an unknown or missing field", "REVIEW_RESULT_INVALID");
  if (!VERDICTS.has(value.verdict)) fail("reviewer verdict must be pass, changes_requested, or escalated", "REVIEW_RESULT_INVALID");
  if (typeof value.summary !== "string" || !value.summary.trim()) fail("reviewer summary is required", "REVIEW_RESULT_INVALID");
  if (!Array.isArray(value.issues)) fail("reviewer issues must be an array", "REVIEW_RESULT_INVALID");
  const issues = value.issues.map((issue, index) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue) || Object.keys(issue).sort().join(",") !== "body,file,line,severity,title") {
      fail(`reviewer issues[${index}] has an invalid shape`, "REVIEW_RESULT_INVALID");
    }
    if (typeof issue.title !== "string" || !issue.title.trim() || typeof issue.body !== "string" || !issue.body.trim()) {
      fail(`reviewer issues[${index}] requires title and body`, "REVIEW_RESULT_INVALID");
    }
    if (issue.file !== null && typeof issue.file !== "string") fail(`reviewer issues[${index}].file is invalid`, "REVIEW_RESULT_INVALID");
    if (issue.line !== null && (!Number.isInteger(issue.line) || issue.line < 1)) fail(`reviewer issues[${index}].line is invalid`, "REVIEW_RESULT_INVALID");
    if (!new Set(["low", "medium", "high", "critical"]).has(issue.severity)) fail(`reviewer issues[${index}].severity is invalid`, "REVIEW_RESULT_INVALID");
    return { title: issue.title.trim(), body: issue.body.trim(), file: issue.file, line: issue.line, severity: issue.severity };
  });
  if (value.verdict === "changes_requested" && !issues.length) fail("changes_requested requires at least one issue", "REVIEW_RESULT_INVALID");
  return { verdict: value.verdict, summary: value.summary.trim(), issues };
}
function normalizeExecutedRuntime(files) {
  if (!Array.isArray(files) || !files.length) fail("reviewer executed runtime binding is unavailable", "REVIEW_RUNTIME_BINDING_MISSING");
  const executable = files[0], keys = ["path", "dev", "ino", "size", "sha256"];
  if (keys.some((key) => !Object.hasOwn(executable, key)) || typeof executable.path !== "string" || !/^[0-9a-f]{64}$/.test(executable.sha256)
    || [executable.dev, executable.ino, executable.size].some((value) => !Number.isInteger(value) || value < 0)) fail("reviewer executed runtime binding is invalid", "REVIEW_RUNTIME_BINDING_INVALID");
  return { digest: crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex"), executable: Object.fromEntries(keys.map((key) => [key, executable[key]])) };
}

function runRecordDigest(record) {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function hasReviewInputBindingError(error) {
  return error?.code === "REVIEW_INPUT_BINDING_CHANGED"
    || error?.review_input_error?.code === "REVIEW_INPUT_BINDING_CHANGED";
}

function productionServices() {
  function withRunLock(runDir, callback) {
    const canonical = fs.realpathSync(runDir);
    return host.withRunLock({ runDir: canonical, attemptId: `review-${crypto.randomUUID()}`, operation: "review",
      hostKind: "local_supervisor", hostHandle: `review:${process.pid}`, worktreeDir: canonical }, callback);
  }
  return {
    inspectRun: (input) => inspectProductionRun(input),
    invokeReviewer({ runDir, request, adapter, model, timeoutMs, networkAccess }) {
      return runStore.invokeIndependentReviewer({
        runDir,
        request,
        timeoutMs,
        buildInvocation: ({ cwd, promptPath, promptBytes, resultPath, schemaPath }) => adapter.buildInvocation({
          phase: "primary_review", cwd, promptPath, promptBytes, resultPath, schemaPath, model,
          timeoutMs, networkAccess,
        }),
        parseOutcome: (input) => adapter.parseOutcome(input),
        providerUnavailableSignals: adapter.providerUnavailableSignals,
      });
    },
    withRunLock,
    appendFact: facts.appendFact,
  };
}

module.exports = {
  REVIEW_RESULT_SCHEMA,
  canonicalRepository,
  fail,
  git,
  gitRaw,
  hasReviewInputBindingError,
  immutableBytes,
  normalizeExecutedRuntime,
  normalizeVerdict,
  productionServices,
  readFrozenCriteria,
  relayHome,
  repoSlug,
  requireReviewAction,
  resolveRun,
  reviewActionBindings,
  reviewPrompt,
  runRecordDigest,
  secureDigest,
};
