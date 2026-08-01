"use strict";

const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");

const [command, checkoutRoot, remote, payloadJson] = process.argv.slice(2);
const store = generation.initializeStore({ checkoutRoot, remote });
const payload = payloadJson ? JSON.parse(payloadJson) : {};

function rollbackFacts() {
  return [{
    run_id: "run-1",
    closed: true,
    facts: [
      { event_id: "1".repeat(64), type: "pull_request_recorded", payload: { pr_number: 42, repo: "sungjunlee/dev-relay", head_ref: "issue-1136", base_ref: "main", head_sha: "a".repeat(40), created_by_relay: true } },
      { event_id: "2".repeat(64), type: "attempt_started", attempt_id: "attempt-1", payload: { start_sha: "a".repeat(40) } },
      { event_id: "3".repeat(64), type: "attempt_finished", attempt_id: "attempt-1", payload: { status: "completed", start_sha: "a".repeat(40), final_sha: "b".repeat(40) } },
      { event_id: "4".repeat(64), type: "merge_recorded", payload: { pr_number: 42, reviewed_source_sha: "b".repeat(40), pr_head_sha: "b".repeat(40), result_target_sha: "c".repeat(40), method: "squash", operation_id: "merge-42" } },
    ],
  }];
}

try {
  let result;
  if (command === "observe") {
    result = generation.observeLegacyRead({ store, ...payload });
  } else if (command === "switch") {
    result = generation.switchGeneration({ store, ...payload });
  } else if (command === "crash-switch") {
    result = generation.switchGeneration({
      store,
      ...payload,
      fault(stage, target) {
        if (stage === "rename" && target.endsWith("runtime-generation.json")) process.exit(73);
      },
    });
  } else if (command === "crash-switch-before-marker") {
    result = generation.switchGeneration({
      store,
      ...payload,
      fault(stage, target) {
        if (stage === "dir_fsync" && target.includes("generation-transitions")) process.exit(74);
      },
    });
  } else if (command === "crash-rollback-before-marker" || command === "crash-rollback") {
    result = generation.rollbackToLegacy({
      store,
      ...payload,
      runIds: ["run-1"],
      loadRunFacts: rollbackFacts,
      fault(stage, target) {
        if (command === "crash-rollback-before-marker" && stage === "fsync" && target.includes("legacy-recovery-overlays")) process.exit(75);
        if (command === "crash-rollback" && stage === "rename" && target.endsWith("runtime-generation.json")) process.exit(76);
      },
    });
  } else {
    throw new Error(`unknown runtime generation worker command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || null, message: error.message })}\n`);
  process.exitCode = 1;
}
