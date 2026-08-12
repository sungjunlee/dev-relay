#!/usr/bin/env node
"use strict";

/** Relay review: immutable inputs -> one independent verdict -> one durable fact. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs } = require("util");

const { getAdapter } = require("../../relay-dispatch/scripts/adapters");
const { credentialRequest, filesystemIsolationDiagnostic, validateCapabilities } = require("../../relay-dispatch/scripts/adapter-contract");
const facts = require("../../relay-dispatch/scripts/facts");
const host = require("../../relay-dispatch/scripts/host");
const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const runStore = require("../../relay-dispatch/scripts/run-store");

const SHA1_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const OPTIONS = Object.freeze({
  repo: { type: "string" },
  "run-dir": { type: "string" },
  "run-id": { type: "string" },
  reviewer: { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  "credential-env": { type: "string", multiple: true, default: [] },
  "credential-file": { type: "string", multiple: true, default: [] },
  "network-access": { type: "string", default: "enabled" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

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

function usage() {
  return [
    "Usage: review-runner.js --repo <path> (--run-id <id> | --run-dir <path>) [options]",
    "",
    "Options:",
    "  --reviewer <name>  Must equal the immutable run reviewer binding.",
    "  --model <name>     Optional opaque model selection for that adapter.",
    "  --timeout <sec>    Reviewer timeout in seconds.",
    "  --credential-env <name>       Explicit credential environment name (repeatable).",
    "  --credential-file <id=path>   Declared private credential-file mapping (repeatable).",
    "  --network-access <enabled|disabled>  Model/tool network policy; provider transport remains enabled (default: enabled).",
    "  --json             Emit one JSON object.",
  ].join("\n");
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

function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) { fail(error.message, "REVIEW_USAGE"); }
  if (parsed.values.help) return { help: true, values: parsed.values };
  if (parsed.positionals.length > 1) fail("at most one positional repo path is allowed", "REVIEW_USAGE");
  if (parsed.values.repo && parsed.positionals.length) fail("use either positional repo or --repo, not both", "REVIEW_USAGE");
  const repo = parsed.values.repo || parsed.positionals[0] || ".";
  if (Boolean(parsed.values["run-dir"]) === Boolean(parsed.values["run-id"])) {
    fail("supply exactly one of --run-dir or --run-id", "REVIEW_USAGE");
  }
  if (parsed.values["run-id"] && !RUN_ID_RE.test(parsed.values["run-id"])) fail("--run-id is invalid", "REVIEW_USAGE");
  if (!new Set(["enabled", "disabled"]).has(parsed.values["network-access"])) fail("--network-access must be enabled or disabled", "REVIEW_USAGE");
  const timeoutSeconds = parsed.values.timeout === undefined ? null : Number(parsed.values.timeout);
  if (timeoutSeconds !== null && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) fail("--timeout must be a positive integer", "REVIEW_USAGE");
  return { help: false, values: parsed.values, repo, timeoutSeconds };
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
    const retrying = inspection.recommended_action.reason === "review_retryable_escalation";
    const retryOfEventId = retrying ? inspection.derived.retry_of_event_id : null;
    if (retrying && (
      typeof retryOfEventId !== "string"
      || !latestReview
      || latestReview.event_id !== retryOfEventId
    )) {
      fail("retry review action is not bound to the latest durable escalation", "REVIEW_RETRY_BINDING_MISMATCH");
    }
    return { head, tree, prNumber: null, verification, retryOfEventId, local: true };
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
  const retrying = inspection.recommended_action.reason === "review_retryable_escalation";
  const retryOfEventId = retrying ? inspection.derived.retry_of_event_id : null;
  if (retrying && (
    typeof retryOfEventId !== "string"
    || !latestReview
    || latestReview.event_id !== retryOfEventId
  )) {
    fail("retry review action is not bound to the latest durable escalation", "REVIEW_RETRY_BINDING_MISMATCH");
  }
  return { head, base, prNumber, verification, retryOfEventId, local: false };
}

function reviewPrompt({ record, binding, criteria, diff }) {
  return [
    "[RELAY INDEPENDENT PRIMARY REVIEW]",
    "Return only one JSON object matching this schema:",
    JSON.stringify(REVIEW_RESULT_SCHEMA),
    "No markdown fences or text outside the object.",
    "A pass verdict means every frozen Done Criterion is satisfied at the exact reviewed commit.",
    "Any substantive issue must return changes_requested. Invocation or evidence uncertainty must return escalated.",
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
  if (value.verdict === "pass" && issues.length) fail("pass verdict cannot contain issues", "REVIEW_RESULT_INVALID");
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
    invokeReviewer({ runDir, request, adapter, model, timeoutMs, networkAccess, credentialRequest: requestedCredentials }) {
      return runStore.invokeIndependentReviewer({
        runDir,
        request,
        timeoutMs,
        credentialRequest: requestedCredentials,
        buildInvocation: ({ cwd, promptPath, promptBytes, resultPath, schemaPath }) => adapter.buildInvocation({
          phase: "primary_review", cwd, promptPath, promptBytes, resultPath, schemaPath, model,
          timeoutMs, sandbox: "read-only", networkAccess,
        }),
        parseOutcome: (input) => adapter.parseOutcome(input),
      });
    },
    withRunLock,
    appendFact: facts.appendFact,
  };
}

async function runReview(cli, overrides = {}) {
  const services = { ...productionServices(), ...overrides };
  const { runDir, record } = resolveRun(cli);
  const resolvedRunDigest = runRecordDigest(record);
  const reviewer = cli.values.reviewer || record.roles.reviewer;
  if (reviewer !== record.roles.reviewer) {
    fail(`reviewer override is not part of the Relay contract; immutable binding is '${record.roles.reviewer}'`, "REVIEWER_BINDING_MISMATCH");
  }
  const adapter = getAdapter(reviewer);
  const capabilityRequest = { readOnly: true, networkAccess: cli.values["network-access"] };
  validateCapabilities(adapter, "primary_review", capabilityRequest);
  const filesystemIsolation = filesystemIsolationDiagnostic(adapter, "primary_review", capabilityRequest);
  let requestedCredentials;
  try { requestedCredentials = credentialRequest(adapter.metadata.credentials, { envNames: cli.values["credential-env"], fileSpecs: cli.values["credential-file"] }); }
  catch (error) { fail(error.message, "INVALID_CREDENTIAL"); }
  const credentialEnv = Object.fromEntries(requestedCredentials.envNames.map((name) => [name, process.env[name]]));
  const initial = await services.inspectRun({ runDir });
  if (!/^[0-9a-f]{64}$/.test(String(initial.snapshot?.run_sha256 || ""))) {
    fail("initial inspection is missing a valid run digest", "RUN_RECORD_BINDING_CHANGED");
  }
  if (initial.snapshot.run_sha256 !== resolvedRunDigest) {
    fail("resolved run record does not match the canonical inspection", "RUN_RECORD_BINDING_CHANGED");
  }
  const binding = requireReviewAction(initial, record);
  const criteriaBytes = readFrozenCriteria(record);
  const criteria = criteriaBytes.toString("utf8");
  const diff = gitRaw(record.git.worktree, ["diff", "--binary", "--no-ext-diff", `${record.git.start_sha}..${binding.head}`, "--"]);
  const inputDir = path.join(runDir, "review-inputs");
  const diffBytes = Buffer.from(`${diff}${diff.endsWith("\n") || !diff ? "" : "\n"}`, "utf8");
  const diffDigest = crypto.createHash("sha256").update(diffBytes).digest("hex");
  const diffPath = immutableBytes(path.join(inputDir, `diff-${binding.head}-${diffDigest}.patch`), diffBytes);
  const promptBytes = Buffer.from(reviewPrompt({ record, binding, criteria, diff }), "utf8");
  const promptDigest = crypto.createHash("sha256").update(promptBytes).digest("hex");
  const promptPath = immutableBytes(path.join(inputDir, `prompt-${binding.head}-${promptDigest}.md`), promptBytes);
  const timeoutMs = (cli.timeoutSeconds || Math.ceil(adapter.defaults.timeoutMs / 1000)) * 1000;
  let verdict, stagedBinding, executedRuntime, escalationKind = null;
  let outcome;
  try {
    outcome = await services.invokeReviewer({
      runDir,
      adapter,
      model: cli.values.model || null,
      timeoutMs,
      networkAccess: cli.values["network-access"],
      credentialRequest: { ...requestedCredentials, env: credentialEnv },
      request: {
        diff_path: diffPath,
        prompt_path: promptPath,
        done_criteria_path: record.contract.done_criteria_path,
        reviewed_sha: binding.head,
        base_sha: binding.base || record.git.start_sha,
        current_sha: binding.head,
        diff_sha256: diffDigest,
        prompt_sha256: promptDigest,
        ...(binding.retryOfEventId ? { retry_of_event_id: binding.retryOfEventId } : {}),
        schema: REVIEW_RESULT_SCHEMA,
      },
    });
  } catch (error) {
    if (error.review_evidence_preserved) throw error;
    if (hasReviewInputBindingError(error)) throw error;
    stagedBinding = error.review_binding || null;
    executedRuntime = normalizeExecutedRuntime(error.executed_runtime);
    const reviewerResultFailure = error.code === "REVIEW_RESULT_INVALID"
      || error.failure_reason === "output_protocol_mismatch";
    verdict = {
      verdict: "escalated",
      summary: `${reviewerResultFailure ? "Reviewer result invalid" : "Reviewer invocation failed"}: ${error.message}`,
      issues: [],
    };
    escalationKind = reviewerResultFailure ? "reviewer" : "runtime_failure";
  }
  if (!verdict) {
    stagedBinding = outcome.review_binding;
    executedRuntime = normalizeExecutedRuntime(outcome.executed_runtime);
    try {
      verdict = normalizeVerdict(outcome.output);
      if (verdict.verdict === "escalated") escalationKind = "reviewer";
    } catch (error) {
      // The provider invocation completed, but its result was not a valid reviewer
      // result. Preserve the staged runtime/bindings and record this as reviewer
      // uncertainty; it must not qualify for the environmental retry.
      verdict = {
        verdict: "escalated",
        summary: `Reviewer result invalid: ${error.message}`,
        issues: [],
      };
      escalationKind = "reviewer";
    }
  }
  const written = await services.withRunLock(runDir, async (lockContext) => {
    const freshRecord = runStore.readRunRecord({ runDir });
    const freshRunDigest = runRecordDigest(freshRecord);
    if (freshRunDigest !== resolvedRunDigest || freshRunDigest !== initial.snapshot.run_sha256) {
      fail("immutable run record changed during independent review", "RUN_RECORD_CHANGED");
    }
    if (freshRecord.contract.done_criteria_sha256 !== record.contract.done_criteria_sha256) {
      fail("immutable Done Criteria contract changed during independent review", "DONE_CRITERIA_CONTRACT_CHANGED");
    }
    readFrozenCriteria(freshRecord);
    const currentDiffDigest = secureDigest(diffPath, "immutable review diff");
    const currentPromptDigest = secureDigest(promptPath, "immutable review prompt");
    if (
      currentDiffDigest !== diffDigest
      || currentPromptDigest !== promptDigest
      || !stagedBinding
      || stagedBinding.diff_sha256 !== diffDigest
      || stagedBinding.prompt_sha256 !== promptDigest
      || stagedBinding.staged_diff_sha256 !== diffDigest
      || stagedBinding.staged_prompt_sha256 !== promptDigest
      || stagedBinding.staged_done_criteria_sha256 !== record.contract.done_criteria_sha256
    ) {
      fail("reviewer result is not bound to the exact staged prompt and diff", "REVIEW_INPUT_BINDING_CHANGED");
    }
    const fresh = await services.inspectRun({ runDir });
    if (!/^[0-9a-f]{64}$/.test(String(fresh.snapshot?.run_sha256 || ""))) {
      fail("fresh inspection is missing a valid run digest", "RUN_RECORD_CHANGED");
    }
    if (fresh.snapshot.run_sha256 !== resolvedRunDigest
      || fresh.snapshot.run_sha256 !== initial.snapshot.run_sha256) {
      fail("run record changed between canonical inspections", "RUN_RECORD_CHANGED");
    }
    if ((fresh.derived?.retry_of_event_id || null) !== binding.retryOfEventId) {
      fail("review retry subject changed during independent review", "REVIEW_BINDING_CHANGED");
    }
    const freshBinding = requireReviewAction(fresh, freshRecord);
    if (
      freshBinding.retryOfEventId !== binding.retryOfEventId
      || freshBinding.head !== binding.head
      || freshBinding.base !== binding.base
      || freshBinding.local !== binding.local
      || freshBinding.tree !== binding.tree
      || freshBinding.prNumber !== binding.prNumber
      || JSON.stringify(freshBinding.verification) !== JSON.stringify(binding.verification)
    ) {
      fail("review binding changed during independent review", "REVIEW_BINDING_CHANGED");
    }
    const round = Math.max(0, ...fresh.facts.filter((fact) => fact.type === "review_recorded").map((fact) => fact.payload.round)) + 1;
    const artifact = {
      schema_version: 2,
      run_id: record.run_id,
      round,
      reviewer,
      reviewed_sha: binding.head,
      ...(binding.local ? {
        run_sha256: resolvedRunDigest,
        verification_event_id: binding.verification.event_id,
      } : {}),
      done_criteria_sha256: record.contract.done_criteria_sha256,
      diff_sha256: diffDigest,
      prompt_sha256: promptDigest,
      staging_request_sha256: stagedBinding.request_sha256,
      executed_runtime: executedRuntime,
      verdict,
    };
    const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const artifactDigest = crypto.createHash("sha256").update(artifactBytes).digest("hex");
    const artifactPath = immutableBytes(path.join(runDir, `review-${round}-${artifactDigest}.json`), artifactBytes);
    const fact = {
      event_id: crypto.createHash("sha256").update(`review:${record.run_id}:${round}:${artifactDigest}`).digest("hex"),
      run_id: record.run_id,
      type: "review_recorded",
      at: new Date().toISOString(),
      actor: reviewer,
      payload: {
        round,
        verdict: verdict.verdict === "pass" ? "lgtm" : verdict.verdict,
        reviewed_sha: binding.head,
        base_sha: binding.base || record.git.start_sha,
        done_criteria_sha256: record.contract.done_criteria_sha256,
        reviewer,
        review_artifact: artifactPath,
        executed_runtime: executedRuntime,
        ...(escalationKind ? { escalation_kind: escalationKind } : {}),
        ...(binding.retryOfEventId ? { retry_of_event_id: binding.retryOfEventId } : {}),
        override: null,
      },
    };
    services.appendFact({ eventsPath: path.join(runDir, "events.jsonl"), fact, lockContext });
    return { round, artifactPath, fact };
  });
  const inspection = await services.inspectRun({ runDir });
  return {
    run_id: record.run_id,
    reviewer,
    round: written.round,
    verdict: written.fact.payload.verdict,
    reviewed_sha: binding.head,
    done_criteria_sha256: record.contract.done_criteria_sha256,
    pr_number: binding.prNumber,
    review_artifact: written.artifactPath,
    recommended_action: inspection.recommended_action,
    filesystem_isolation: filesystemIsolation,
  };
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) { console.log(usage()); return 0; }
  const result = await runReview(cli);
  console.log(cli.values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    const payload = { ok: false, code: error.code || "REVIEW_FAILED", error: error.message };
    console.error(process.argv.includes("--json") ? JSON.stringify(payload) : `Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  REVIEW_RESULT_SCHEMA,
  main,
  normalizeVerdict,
  parseCli,
  readFrozenCriteria,
  requireReviewAction,
  runReview,
};
