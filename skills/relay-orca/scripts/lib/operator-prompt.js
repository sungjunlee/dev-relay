"use strict";

const { coordinationMarkerFor, shellQuote } = require("./coordination-marker");

// Engine-agnostic operator prompt builder (D8). One prompt per task kind. The
// operator SURFACE is sourced from the plan's recommended_route (operator name +
// mode only). NO executor/reviewer engine name, model name, or engine-specific
// flag ever appears here — engine selection is relay-config, resolved at relay
// dispatch time, never named in a program-altitude operator prompt.

// The operator completion payload contract (D8): every prompt lists these fields
// verbatim so an operator returns machine-checkable provenance, not prose.
const PAYLOAD_FIELDS = Object.freeze([
  "program_id",
  "task_id",
  "outcome_id",
  "orca_task_id",
  "dispatch_id",
  "assignee",
  "relay_ids", // request/run/fleet ids when applicable
  "issue_url",
  "pr_url",
  "verification",
  "observed_state",
  "follow_ups",
]);

// Pinned literals — the reviewer greps generated prompts for these exact strings.
const RECONCILIATION_SENTENCE =
  "Live reconciliation is still required; this payload is not completion evidence.";
const LIFECYCLE_NOTE =
  "Orca worker_done and task status are lifecycle signals, never completion authority.";
const OWNERSHIP_NOTE =
  "The coordinator and Orca terminals never edit implementation code directly; relay owns every implementation worktree and durable run manifest.";
const READ_ONLY_MARKER = "read-only";
const NO_EDIT_CLAUSE =
  "This is a read-only task: review completion does not authorize coordinator file edits or silent fixes; findings become tracker follow-ups.";
const RELAY_PATH =
  "Drive the normal relay path: readiness -> plan -> dispatch -> review -> merge.";

function payloadContractBlock() {
  return [
    "Completion payload contract (return ALL fields):",
    ...PAYLOAD_FIELDS.map((field) => `  - ${field}`),
    RECONCILIATION_SENTENCE,
    LIFECYCLE_NOTE,
  ].join("\n");
}

function headerBlock(task, program, outcome) {
  const route = task.recommended_route || {};
  return [
    `relay-orca operator task for program ${program.id}`,
    `outcome: ${task.outcome_id} (kind ${task.kind}, wave ${task.wave})`,
    `operator surface: ${route.operator} (mode ${route.mode})`,
    `accepted outcomes: ${(outcome.accepted_outcomes || []).join("; ")}`,
    `expected evidence: ${(task.expected_evidence || []).join("; ")}`,
  ].join("\n");
}

// relay_fleet prompts embed ONLY already-prepared leaf artifacts (D8). The plan
// already rejects UNPREPARED_FLEET_LEAF, so leaves arrive prepared; no second check.
function fleetLeavesBlock(outcome) {
  const leaves = Array.isArray(outcome.leaves) ? outcome.leaves : [];
  const lines = leaves.map(
    (leaf, index) =>
      `  leaf ${index + 1}: prompt=${leaf.prompt_file} rubric=${leaf.rubric_file} done_criteria=${leaf.done_criteria_file}`,
  );
  return ["prepared fleet leaves:", ...lines].join("\n");
}

function manifestMarkerBlock(task, program, segmentEncoder) {
  if (task.kind !== "relay_run" && task.kind !== "relay_fleet") return null;
  if (typeof segmentEncoder !== "function") throw new TypeError("operator prompt requires the shared program segment encoder");
  const destination = task.kind === "relay_fleet" ? "relay fleet manifest" : "relay run manifest";
  const marker = coordinationMarkerFor(program.id, task.outcome_id, segmentEncoder);
  return `Embed this exact program marker line in the ${destination}:\n${marker}`;
}

function relayDispatchMarkerContract(task, program, segmentEncoder) {
  if (task.kind !== "relay_run") return null;
  if (typeof segmentEncoder !== "function") throw new TypeError("operator prompt requires the shared program segment encoder");
  const marker = coordinationMarkerFor(program.id, task.outcome_id, segmentEncoder);
  return [
    "Relay coordination-marker contract (fail closed before dispatch):",
    `Exact resolved marker: ${marker}`,
    "Authoritative relay dispatch CLI shape:",
    `node "\${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" <repo-root> --branch <branch> --prompt-file <prompt-file> --rubric-file <rubric-file> --coordination-marker ${shellQuote(marker)}`,
    "Use that --coordination-marker value on the initial relay dispatch. If the flag is unavailable or its exact marker cannot be persisted before executor spawn, stop before worktree/executor mutation; do not dispatch or replay.",
  ].join("\n");
}

function bodyBlock(task, program, outcome, segmentEncoder) {
  const route = task.recommended_route || {};
  if (route.read_only) {
    return [NO_EDIT_CLAUSE, `Deliver the ${route.mode} evidence, then triage blocking findings into tracker follow-ups.`].join("\n");
  }
  const marker = manifestMarkerBlock(task, program, segmentEncoder);
  if (task.kind === "relay_fleet") {
    return [RELAY_PATH, fleetLeavesBlock(outcome), OWNERSHIP_NOTE, marker].join("\n");
  }
  return [RELAY_PATH, OWNERSHIP_NOTE, marker, relayDispatchMarkerContract(task, program, segmentEncoder)]
    .filter(Boolean)
    .join("\n");
}

function integrationGateBlock(lifecycle) {
  const base = [
    "Integration-gate lifecycle contract (coordinator-owned):",
    "The coordinator alone creates/adopts and resolves the canonical Orca gate. The operator writes only deterministic live evidence and sends no gate mutation.",
    "The canonical gate question is tied to the shared #1016 program-segment/outcome marker and its exact options are [\"passed\",\"failed\"].",
    "Gate resolution must be observed before worker_done; never use task-update, reset, receipt edits, or manual dispatch replay.",
  ];
  if (!lifecycle || !lifecycle.completion_command) {
    return base.concat("Wait for a fresh coordinator instruction containing the current dispatch provenance before sending worker_done.").join("\n");
  }
  const provenance = lifecycle.evidence_provenance || {};
  return base.concat([
    `Write the live evidence JSON at this exact path: ${lifecycle.report_path}`,
    "The JSON must contain passed:true, deterministic evidence text, and these exact provenance fields binding it to THIS dispatch (a reused or prior-run artifact is rejected):",
    `  "runtime_id": ${JSON.stringify(provenance.runtime_id || null)}, "task_id": ${JSON.stringify(provenance.task_id || null)}, "dispatch_id": ${JSON.stringify(provenance.dispatch_id || null)}`,
    "After the coordinator resolves this exact gate to passed, copy-paste the following command exactly once from the current dispatched pane:",
    lifecycle.completion_command.copy_paste,
  ]).join("\n");
}

// Build the full operator prompt for a single task. `outcome` is the original
// program outcome (carries relay_fleet leaves); `task` is the compiled plan task.
function buildOperatorPrompt(task, program, outcome = {}, segmentEncoder, options = {}) {
  const lifecycle = task.kind === "integration_gate" ? integrationGateBlock(options.integrationGate) : null;
  return [
    headerBlock(task, program, outcome),
    bodyBlock(task, program, outcome, segmentEncoder),
    lifecycle,
    payloadContractBlock(),
  ].filter(Boolean).join("\n\n");
}

module.exports = {
  PAYLOAD_FIELDS,
  RECONCILIATION_SENTENCE,
  LIFECYCLE_NOTE,
  OWNERSHIP_NOTE,
  READ_ONLY_MARKER,
  NO_EDIT_CLAUSE,
  RELAY_PATH,
  relayDispatchMarkerContract,
  buildOperatorPrompt,
};
