#!/usr/bin/env node
"use strict";

/** Relay review: immutable inputs -> one independent verdict -> one durable fact. */

const crypto = require("crypto");
const path = require("path");
const { parseArgs } = require("util");

const { getAdapter } = require("../../relay-dispatch/scripts/adapters");
const { filesystemIsolationDiagnostic, validateCapabilities } = require("../../relay-dispatch/scripts/adapter-contract");
const runStore = require("../../relay-dispatch/scripts/run-store");
const {
  REVIEW_RESULT_SCHEMA,
  fail,
  gitRaw,
  hasReviewInputBindingError,
  immutableBytes,
  normalizeExecutedRuntime,
  normalizeVerdict,
  productionServices,
  readFrozenCriteria,
  requireReviewAction,
  resolveRun,
  reviewPrompt,
  runRecordDigest,
  secureDigest,
} = require("./review-runner-helpers");

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const OPTIONS = Object.freeze({
  repo: { type: "string" },
  "run-dir": { type: "string" },
  "run-id": { type: "string" },
  reviewer: { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  "network-access": { type: "string", default: "enabled" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

function usage() {
  return [
    "Usage: review-runner.js --repo <path> (--run-id <id> | --run-dir <path>) [options]",
    "",
    "Options:",
    "  --reviewer <name>  Must equal the immutable run reviewer binding.",
    "  --model <name>     Optional opaque model selection for that adapter.",
    "  --timeout <sec>    Reviewer timeout in seconds.",
    "  --network-access <enabled|disabled>  Model/tool network policy; provider transport remains enabled (default: enabled).",
    "  --json             Emit one JSON object.",
  ].join("\n");
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

async function runReview(cli, overrides = {}) {
  const services = { ...productionServices(), ...overrides };
  const { runDir, record } = resolveRun(cli);
  const resolvedRunDigest = runRecordDigest(record);
  const reviewer = cli.values.reviewer || record.roles.reviewer;
  if (reviewer !== record.roles.reviewer) {
    fail(`reviewer override is not part of the Relay contract; immutable binding is '${record.roles.reviewer}'`, "REVIEWER_BINDING_MISMATCH");
  }
  const adapter = getAdapter(reviewer);
  const capabilityRequest = { readOnly: true, networkAccess: cli.values["network-access"], model: cli.values.model || null };
  validateCapabilities(adapter, "primary_review", capabilityRequest);
  const filesystemIsolation = filesystemIsolationDiagnostic(adapter, "primary_review", capabilityRequest);
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
  const diffRange = binding.local ? `${record.git.start_sha}..${binding.head}` : `${binding.base}...${binding.head}`;
  const diff = gitRaw(record.git.worktree, ["diff", "--binary", "--no-ext-diff", diffRange, "--"]);
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
        ...(binding.resolutionOfEventId ? { resolution_of_event_id: binding.resolutionOfEventId } : {}),
        schema: REVIEW_RESULT_SCHEMA,
      },
    });
  } catch (error) {
    if (error.review_evidence_preserved) throw error;
    if (hasReviewInputBindingError(error)) throw error;
    if (error?.diagnostic?.stage === "pre-provider") throw error;
    if (error.classification === "provider_unavailable") throw error;
    if (error.executed_runtime === undefined) throw error;
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
    if ((fresh.derived?.resolution_of_event_id || null) !== binding.resolutionOfEventId) {
      fail("review resolution subject changed during independent review", "REVIEW_BINDING_CHANGED");
    }
    const freshBinding = requireReviewAction(fresh, freshRecord);
    if (
      freshBinding.retryOfEventId !== binding.retryOfEventId
      || freshBinding.resolutionOfEventId !== binding.resolutionOfEventId
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
      ...(binding.resolutionOfEventId ? { resolution_of_event_id: binding.resolutionOfEventId } : {}),
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
        ...(binding.resolutionOfEventId ? { resolution_of_event_id: binding.resolutionOfEventId } : {}),
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
    const payload = { ok: false, code: error.code || "REVIEW_FAILED", error: error.message,
      ...(error.classification ? { classification: error.classification } : {}) };
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
