#!/usr/bin/env node
"use strict";

/** Explicit Relay merge: inspect, authorize, merge, record provenance, clean up. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");

const facts = require("../../relay-dispatch/scripts/facts");
const { cleanupWorktree } = require("../../relay-dispatch/scripts/cleanup-worktree");
const {
  fail,
  requireMergeAction,
  resolveRun,
  terminalMergeFact,
} = require("./review-gate");
const {
  assertBaseIntegrity,
  finishTerminal,
  mergeObserver,
  productionServices,
  readRegularJson,
} = require("./finalize-run-terminal");

const SHA1_RE = /^[0-9a-f]{40}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const METHODS = new Set(["squash", "merge", "rebase"]);
const OPTIONS = Object.freeze({
  repo: { type: "string" },
  "run-dir": { type: "string" },
  "run-id": { type: "string" },
  "merge-method": { type: "string", default: "squash" },
  actor: { type: "string" },
  "operation-id": { type: "string" },
  "no-cleanup": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

function usage() {
  return [
    "Usage: finalize-run.js --repo <path> (--run-id <id> | --run-dir <path>) [options]",
    "",
    "Options:",
    "  --merge-method <method>  squash | merge | rebase (default: squash)",
    "  --actor <name>           Explicit operator identity (default: git user.name)",
    "  --operation-id <id>      Stable id for audited crash recovery",
    "  --no-cleanup             Retain the linked worktree after merge",
    "  --dry-run                Validate the exact merge gate without mutation",
    "  --json                   Emit one JSON object",
    "",
    "The command has no review/state bypass. A current passing review is mandatory.",
  ].join("\n");
}

function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) {
    const unknown = new RegExp("^Unknown option ['\\\"]?([^'\\\"]+)['\\\"]?").exec(error.message);
    fail(unknown ? `unknown flag: ${unknown[1]}` : error.message, "MERGE_USAGE");
  }
  if (parsed.values.help) return { help: true, values: parsed.values, repo: "." };
  if (parsed.positionals.length > 1) fail("at most one positional repo is allowed", "MERGE_USAGE");
  if (parsed.values.repo && parsed.positionals.length) fail("use positional repo or --repo, not both", "MERGE_USAGE");
  if (!METHODS.has(parsed.values["merge-method"])) fail("--merge-method must be squash, merge, or rebase", "MERGE_USAGE");
  if (parsed.values["operation-id"] && !SAFE_TOKEN_RE.test(parsed.values["operation-id"])) {
    fail("--operation-id must be a safe 1-127 character identifier", "MERGE_USAGE");
  }
  if (parsed.values.actor !== undefined && !String(parsed.values.actor).trim()) {
    fail("--actor must be non-empty", "MERGE_USAGE");
  }
  return {
    help: false,
    values: parsed.values,
    repo: parsed.values.repo || parsed.positionals[0] || ".",
  };
}

function command(repo, executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function git(repo, args) {
  return command(repo, process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args]);
}

function gh(repo, args) {
  return command(repo, process.env.RELAY_GH_BIN || "gh", args);
}

function operatorName(repo, explicit) {
  const candidate = explicit || (() => {
    try { return git(repo, ["config", "user.name"]); }
    catch { return process.env.USER || "operator"; }
  })();
  const actor = String(candidate).trim();
  if (!actor || actor.includes("\0") || /[\r\n]/.test(actor)) {
    fail("operator identity is invalid", "MERGE_ACTOR_INVALID");
  }
  return actor;
}

function operationId(record, binding, method, explicit) {
  if (explicit) return explicit;
  return `merge-${crypto.createHash("sha256")
    .update(`${record.run_id}\0${binding.prNumber}\0${binding.head}\0${method}`)
    .digest("hex").slice(0, 32)}`;
}

function findAuthorizationOperation(runDir, preferredId) {
  const prefix = "merge-authorization-";
  const suffix = ".json";
  const operations = fs.readdirSync(runDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, -suffix.length));
  if (operations.some((id) => !SAFE_TOKEN_RE.test(id))) {
    fail("run contains an unsafe merge authorization filename", "MERGE_AUTHORIZATION_INVALID");
  }
  if (operations.length > 1) {
    fail("run contains multiple durable merge authorizations", "MERGE_AUTHORIZATION_CONFLICT");
  }
  return { operationId: operations[0] || preferredId, existing: operations.length === 1 };
}

function pendingPath(runDir, operationIdValue) {
  return path.join(runDir, `merge-pending-${operationIdValue}.json`);
}

function requestIntentPath(runDir, operationIdValue) {
  return path.join(runDir, `merge-request-intent-${operationIdValue}.json`);
}

function ambiguousPath(runDir, operationIdValue) {
  return path.join(runDir, `merge-ambiguous-${operationIdValue}.json`);
}

function writeImmutableJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  try {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); }
    finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readRegularJson(filePath, path.basename(filePath));
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      fail("immutable merge artifact conflict", "MERGE_ARTIFACT_CONFLICT");
    }
  }
}

function mergeMethodName(method) {
  return String(method || "").toLowerCase();
}

function pendingMethod(live) {
  return mergeMethodName(live.auto_merge_request?.mergeMethod || live.auto_merge_request?.merge_method);
}

function isMergePending(live) {
  return live?.pr_state === "OPEN" && Boolean(
    live.auto_merge_request
    || live.merge_state_status === "QUEUED",
  );
}

function validatePending(pending, authorization, binding) {
  const expected = {
    schema_version: 1,
    operation_id: authorization.operationId,
    authorization_id: authorization.authorizationId,
    pr_number: binding.prNumber,
    pr_head_sha: binding.head,
    method: authorization.method,
    github_login: authorization.githubLogin,
  };
  if (JSON.stringify(pending) !== JSON.stringify(expected)) {
    fail("merge pending artifact does not match the durable authorization", "MERGE_PENDING_MISMATCH");
  }
  return pending;
}

function recordPending(runDir, authorization, binding) {
  const pending = {
    schema_version: 1,
    operation_id: authorization.operationId,
    authorization_id: authorization.authorizationId,
    pr_number: binding.prNumber,
    pr_head_sha: binding.head,
    method: authorization.method,
    github_login: authorization.githubLogin,
  };
  writeImmutableJson(pendingPath(runDir, authorization.operationId), pending);
  return pending;
}

function requestIntentValue(authorization, binding) {
  return {
    schema_version: 1,
    operation_id: authorization.operationId,
    authorization_id: authorization.authorizationId,
    pr_number: binding.prNumber,
    pr_head_sha: binding.head,
    method: authorization.method,
    operator: authorization.actor,
    github_login: authorization.githubLogin,
  };
}

function validateRequestIntent(value, authorization, binding) {
  if (JSON.stringify(value) !== JSON.stringify(requestIntentValue(authorization, binding))) {
    fail("merge request intent does not match the durable authorization", "MERGE_REQUEST_INTENT_MISMATCH");
  }
  return value;
}

function requireRelayRequestEvidence({ live, pending, requestIntent, mergePerformed }) {
  if (live.pr_state !== "MERGED") return;
  if (pending || mergePerformed) return;
  if (requestIntent) {
    fail(
      "a durable merge request intent has no confirmed Relay request outcome; use canonical recover",
      "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
    );
  }
  fail(
    "an externally merged PR without durable Relay request evidence must use canonical recover",
    "MERGE_RECOVER_REQUIRED",
  );
}

function recordRequestIntent(runDir, authorization, binding) {
  const intent = requestIntentValue(authorization, binding);
  writeImmutableJson(requestIntentPath(runDir, authorization.operationId), intent);
  return intent;
}

function ambiguousValue(authorization, binding) {
  return {
    schema_version: 1,
    operation_id: authorization.operationId,
    authorization_id: authorization.authorizationId,
    pr_number: binding.prNumber,
    pr_head_sha: binding.head,
    method: authorization.method,
    operator: authorization.actor,
    github_login: authorization.githubLogin,
    reason: "merge_command_error_external_merged",
  };
}

function validateAmbiguous(value, authorization, binding) {
  if (JSON.stringify(value) !== JSON.stringify(ambiguousValue(authorization, binding))) {
    fail("ambiguous merge artifact does not match the durable authorization", "MERGE_AMBIGUOUS_MISMATCH");
  }
  return value;
}

function headRepository(pr) {
  return pr?.headRepository?.nameWithOwner
    || (pr?.headRepositoryOwner?.login && pr?.headRepository?.name
      ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`
      : null);
}

function normalizePr(record, raw) {
  return {
    repo: record.repo.remote,
    head_repo: headRepository(raw),
    pr_number: raw?.number,
    pr_state: raw?.state,
    pr_head_sha: raw?.headRefOid,
    pr_base_sha: raw?.baseRefOid,
    head_ref: raw?.headRefName,
    base_ref: raw?.baseRefName,
    merge_sha: raw?.mergeCommit?.oid || null,
    auto_merge_request: raw?.autoMergeRequest || null,
    merge_state_status: raw?.mergeStateStatus || null,
  };
}

function observeLivePr(record, prNumber) {
  const raw = JSON.parse(gh(record.repo.root, [
    "pr", "view", String(prNumber), "--repo", record.repo.remote,
    "--json", "number,state,headRefName,headRefOid,baseRefName,baseRefOid,headRepository,headRepositoryOwner,mergeCommit,autoMergeRequest,mergeStateStatus",
  ]));
  return normalizePr(record, raw);
}

function assertQueueRequestor(live, authorization) {
  if (authorization.githubLogin === null) return;
  const enabledBy = live.auto_merge_request?.enabledBy?.login;
  if (!enabledBy || enabledBy !== authorization.githubLogin) {
    fail(
      "GitHub merge queue requestor does not match the authenticated durable request principal",
      "MERGE_QUEUE_REQUESTOR_MISMATCH",
    );
  }
}

function assertExactPr(observed, record, binding, allowedStates) {
  if (
    !observed || !allowedStates.has(observed.pr_state)
    || observed.repo !== record.repo.remote
    || observed.head_repo !== record.repo.remote
    || observed.pr_number !== binding.prNumber
    || observed.pr_head_sha !== binding.head
    || !SHA1_RE.test(String(observed.pr_base_sha || ""))
    || observed.head_ref !== record.git.branch
    || !observed.base_ref
    || (binding.liveBaseRef && observed.base_ref !== binding.liveBaseRef)
  ) fail("fresh GitHub observation changed PR identity or state", "MERGE_LIVE_OBSERVATION_MISMATCH");
  if (observed.pr_state === "MERGED" && !SHA1_RE.test(String(observed.merge_sha || ""))) {
    fail("merged PR observation is missing the result target SHA", "MERGE_TARGET_MISSING");
  }
  return observed;
}

function resumeBinding(inspection, record, binding) {
  if (inspection.blockers?.length) fail(`merge resume is blocked: ${inspection.blockers[0].code}`, "MERGE_BLOCKED");
  if (
    inspection.derived?.action !== "recover"
    || inspection.derived?.reason !== "merged_pr_unrecorded"
  ) fail("durable merge authorization can resume only an exact unrecorded merged PR", "MERGE_RESUME_MISMATCH");
  const observed = inspection.observations?.github;
  assertExactPr(observed, record, binding, new Set(["MERGED"]));
  return observed;
}

async function finalizeRun(cli, overrides = {}) {
  const services = { ...productionServices(), ...overrides };
  const resolved = resolveRun({
    repo: cli.repo,
    runDir: cli.values["run-dir"] || null,
    runId: cli.values["run-id"] || null,
  });
  const { record, runDir } = resolved;
  const terminal = terminalMergeFact(runDir, facts);
  if (terminal.fact) {
    const observer = services.mergeObserver(record);
    return finishTerminal({
      resolved,
      mergeFact: terminal.fact,
      cleanup: !cli.values["no-cleanup"],
      services,
      observer,
    });
  }

  const initial = await services.inspectRun({ runDir });
  let binding;
  try { binding = requireMergeAction(initial, record); }
  catch (error) {
    const derivedHead = initial.derived?.head_sha;
    const derivedPr = initial.derived?.pr_number;
    if (
      initial.derived?.reason !== "merged_pr_unrecorded"
      || !SHA1_RE.test(String(derivedHead || ""))
      || !Number.isInteger(derivedPr)
    ) throw error;
    const review = initial.facts.filter((fact) => fact.type === "review_recorded").at(-1);
    binding = {
      head: derivedHead,
      prNumber: derivedPr,
      reviewedBase: review?.payload?.base_sha,
      liveBase: initial.observations?.github?.pr_base_sha,
      liveBaseRef: initial.observations?.github?.base_ref,
    };
  }
  const method = cli.values["merge-method"];
  const preferredId = operationId(record, binding, method, cli.values["operation-id"] || null);
  const authorizationLookup = findAuthorizationOperation(runDir, preferredId);
  const id = authorizationLookup.operationId;
  const hasAuthorization = authorizationLookup.existing;
  if (initial.derived?.action !== "merge" && !hasAuthorization) {
    fail("an externally merged PR without this command's durable authorization must use canonical recover", "MERGE_RECOVER_REQUIRED");
  }
  if (cli.values["dry-run"]) {
    if (initial.derived?.action !== "merge") fail("dry-run cannot resume an in-flight merge", "MERGE_DRY_RUN_RESUME_UNSUPPORTED");
    const gate = requireMergeAction(initial, record);
    services.assertBaseIntegrity(record, gate, gate.liveBase);
    return {
      run_id: record.run_id,
      status: "ready_to_merge",
      dry_run: true,
      pr_number: gate.prNumber,
      pr_head_sha: gate.head,
      method,
      operation_id: id,
      action_key: initial.recommended_action.key,
    };
  }

  const actor = operatorName(record.repo.root, cli.values.actor);
  const observer = services.mergeObserver(record);
  return services.withRunLock(runDir, async (lockContext) => {
    // Scope the re-inspection to this lock, as dispatch.js and recover.js do.
    // Without it the observer probes the ownership ledger, finds the merge lock
    // this process just took, and reports it as a live executor host.
    const fresh = await services.inspectRun({ runDir, activeRunLock: lockContext });
    let freshBinding;
    if (hasAuthorization) {
      if (fresh.derived?.action === "merge") freshBinding = requireMergeAction(fresh, record);
      else {
        resumeBinding(fresh, record, binding);
        freshBinding = binding;
      }
    } else {
      freshBinding = requireMergeAction(fresh, record);
    }
    if (freshBinding.head !== binding.head || freshBinding.prNumber !== binding.prNumber) {
      fail("merge binding changed while acquiring the run lock", "MERGE_BINDING_CHANGED");
    }
    const direct = assertExactPr(
      await services.observeLivePr(record, binding.prNumber),
      record,
      binding,
      hasAuthorization ? new Set(["OPEN", "MERGED"]) : new Set(["OPEN"]),
    );
    if (freshBinding.liveBase && direct.pr_base_sha !== freshBinding.liveBase) {
      fail("direct GitHub observation changed the live base SHA", "MERGE_BASE_OBSERVATION_MISMATCH");
    }
    const revalidated = await services.revalidateExternalFacts({
      runDir,
      lockContext,
      observer,
      request: {
        repo: record.repo.remote,
        pr_number: binding.prNumber,
        expected_pr_head_sha: binding.head,
        expected_pr_base_sha: direct.pr_base_sha,
        expected_head_ref: record.git.branch,
        expected_base_ref: record.git.base_branch,
        expected_state: direct.pr_state,
        expected_auto_merge_request: direct.auto_merge_request,
        expected_merge_state_status: direct.merge_state_status,
      },
      authorize: (observed) => {
        assertExactPr(
          observed,
          record,
          binding,
          hasAuthorization ? new Set(["OPEN", "MERGED"]) : new Set(["OPEN"]),
        );
        if (
          observed.pr_base_sha !== direct.pr_base_sha
          ||
          isMergePending(observed) !== isMergePending(direct)
          || (isMergePending(direct) && pendingMethod(observed) !== pendingMethod(direct))
        ) fail("merge queue state changed across independent observations", "MERGE_QUEUE_OBSERVATION_MISMATCH");
        return { authorized: true };
      },
    });
    services.assertBaseIntegrity(record, freshBinding, revalidated.facts.pr_base_sha);
    if (!hasAuthorization && isMergePending(revalidated.facts)) {
      fail("an existing external merge queue request requires canonical recover", "MERGE_RECOVER_REQUIRED");
    }
    const authorization = hasAuthorization
      ? services.resumeOperatorMerge({
          runDir,
          lockContext,
          operationId: id,
          freshObservation: revalidated.observationCapability,
        })
      : services.planOperatorMerge({
          runDir,
          lockContext,
          freshObservation: revalidated.observationCapability,
          operatorAction: { actor, method, operationId: id },
          currentHead: binding.head,
          currentDoneCriteriaSha256: record.contract.done_criteria_sha256,
          verdict: {
            verdict: freshBinding.review.payload.verdict,
            reviewed_sha: freshBinding.review.payload.reviewed_sha,
            done_criteria_sha256: freshBinding.review.payload.done_criteria_sha256,
          },
          prNumber: binding.prNumber,
        });

    if (hasAuthorization && (authorization.method !== method || authorization.actor !== actor)) {
      fail(
        "requested method or actor differs from the verified durable authorization",
        "MERGE_AUTHORIZATION_REQUEST_MISMATCH",
      );
    }
    const ambiguousFile = ambiguousPath(runDir, authorization.operationId);
    const ambiguous = readRegularJson(ambiguousFile, "ambiguous merge artifact");
    if (ambiguous) {
      validateAmbiguous(ambiguous, authorization, binding);
      fail("a prior merge command failed after GitHub reported MERGED; use canonical external recover", "MERGE_EXTERNAL_RECOVER_REQUIRED");
    }
    const pendingFile = pendingPath(runDir, authorization.operationId);
    let pending = readRegularJson(pendingFile, "merge pending artifact");
    if (pending) validatePending(pending, authorization, binding);
    const intentFile = requestIntentPath(runDir, authorization.operationId);
    let requestIntent = readRegularJson(intentFile, "merge request intent");
    if (requestIntent) validateRequestIntent(requestIntent, authorization, binding);

    let live = revalidated.facts;
    let mergePerformed = false;
    if (live.pr_state === "OPEN") {
      if (isMergePending(live)) {
        const queuedMethod = pendingMethod(live);
        if (queuedMethod && queuedMethod !== authorization.method) {
          fail("GitHub merge queue method differs from the durable authorization", "MERGE_QUEUE_METHOD_MISMATCH");
        }
        if (!pending && !requestIntent) {
          fail(
            "an external merge queue request without durable Relay request evidence must use canonical recover",
            "MERGE_RECOVER_REQUIRED",
          );
        }
        assertQueueRequestor(live, authorization);
        if (!pending) pending = recordPending(runDir, authorization, binding);
        return {
          run_id: record.run_id,
          status: "merge_pending",
          merge_performed: false,
          merge_recorded: false,
          pr_number: binding.prNumber,
          pr_head_sha: binding.head,
          method: authorization.method,
          operator: authorization.actor,
          operation_id: authorization.operationId,
          cleanup: { status: "deferred_until_merged" },
        };
      }
      if (pending) {
        fail("durable merge queue request disappeared before merge", "MERGE_QUEUE_STATE_LOST");
      }
      if (requestIntent) {
        fail(
          "a durable merge request intent has no confirmed GitHub outcome; use canonical recover",
          "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
        );
      }
      const preflight = assertExactPr(
        await services.observeLivePr(record, binding.prNumber),
        record,
        binding,
        new Set(["OPEN"]),
      );
      services.assertBaseIntegrity(record, freshBinding, preflight.pr_base_sha);
      if (isMergePending(preflight)) {
        fail("merge queue state changed immediately before the merge request", "MERGE_QUEUE_OBSERVATION_MISMATCH");
      }
      await services.beforeMerge({ record, binding, authorization });
      requestIntent = recordRequestIntent(runDir, authorization, binding);
      await services.afterRequestIntent({ record, binding, authorization });
      try {
        await services.mergePullRequest(record, binding, authorization.method);
        mergePerformed = true;
      } catch (error) {
        live = await services.observeLivePr(record, binding.prNumber);
        if (live.pr_state === "MERGED") {
          writeImmutableJson(ambiguousFile, ambiguousValue(authorization, binding));
          fail(
            "merge command failed after GitHub reported MERGED; use canonical external recover",
            "MERGE_EXTERNAL_RECOVER_REQUIRED",
          );
        }
        if (live.pr_state === "OPEN" && isMergePending(live)) {
          const queuedMethod = pendingMethod(live);
          if (queuedMethod && queuedMethod !== authorization.method) {
            fail("GitHub merge queue method differs from the durable authorization", "MERGE_QUEUE_METHOD_MISMATCH");
          }
          assertQueueRequestor(live, authorization);
          pending = recordPending(runDir, authorization, binding);
          return {
            run_id: record.run_id,
            status: "merge_pending",
            merge_performed: true,
            merge_recorded: false,
            pr_number: binding.prNumber,
            pr_head_sha: binding.head,
            method: authorization.method,
            operator: authorization.actor,
            operation_id: authorization.operationId,
            cleanup: { status: "deferred_until_merged" },
          };
        }
        fail(
          `merge request outcome is ambiguous after command failure: ${error.message}`,
          "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
        );
      }
      await services.afterMergeRequest({ record, binding, authorization });
      // A successful command is the exactly-once request boundary. Persist
      // confirmation only after the post-call crash seam has been crossed.
      pending = recordPending(runDir, authorization, binding);
      await services.afterMerge({ record, binding, operationId: id });
      live = await services.observeLivePr(record, binding.prNumber);
      if (live.pr_state === "OPEN" && isMergePending(live)) {
        const queuedMethod = pendingMethod(live);
        if (queuedMethod && queuedMethod !== authorization.method) {
          fail("GitHub merge queue method differs from the durable authorization", "MERGE_QUEUE_METHOD_MISMATCH");
        }
        assertQueueRequestor(live, authorization);
        pending = recordPending(runDir, authorization, binding);
        return {
          run_id: record.run_id,
          status: "merge_pending",
          merge_performed: true,
          merge_recorded: false,
          pr_number: binding.prNumber,
          pr_head_sha: binding.head,
          method: authorization.method,
          operator: authorization.actor,
          operation_id: authorization.operationId,
          cleanup: { status: "deferred_until_merged" },
        };
      }
    }
    assertExactPr(live, record, binding, new Set(["MERGED"]));
    requireRelayRequestEvidence({ live, pending, requestIntent, mergePerformed });
    const mergeFact = await services.recordMerge({
      eventsPath: path.join(runDir, "events.jsonl"),
      provenance: {
        pr_number: binding.prNumber,
        reviewed_source_sha: binding.head,
        pr_head_sha: binding.head,
        result_target_sha: live.merge_sha,
        method: authorization.method,
        operator: authorization.actor,
        override_reason: authorization.overrideReason,
      },
      authorization,
      lockContext,
      observer,
    });
    const cleanup = cli.values["no-cleanup"]
      ? { status: "retained_by_request" }
      : await services.cleanupWorktree(record, mergeFact);
    return {
      run_id: record.run_id,
      status: "merged",
      merge_performed: mergePerformed,
      merge_recorded: true,
      pr_number: binding.prNumber,
      pr_head_sha: binding.head,
      result_target_sha: mergeFact.payload.result_target_sha,
      method: mergeFact.payload.method,
      operator: mergeFact.payload.operator,
      operation_id: mergeFact.payload.operation_id,
      cleanup,
    };
  });
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) {
    console.log(usage());
    return 0;
  }
  const result = await finalizeRun(cli);
  console.log(cli.values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    const payload = { ok: false, code: error.code || "MERGE_FAILED", error: error.message };
    console.error(process.argv.includes("--json") ? JSON.stringify(payload) : `Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertBaseIntegrity,
  assertExactPr,
  cleanupWorktree,
  finalizeRun,
  finishTerminal,
  main,
  mergeObserver,
  observeLivePr,
  operationId,
  parseCli,
  productionServices,
  readRegularJson,
  usage,
};
