"use strict";

// `status` gather + assembly (#945 D4/D6/D9). Given the parsed receipt and injected
// read-only adapters (Orca reads, GitHub reads, already-parsed relay manifests), this
// module gathers live facts, threads them through the pure classifier, and assembles
// the stable D9 report. All subprocess/fs work happens in the top-level script via
// the injected adapters; this module performs no I/O itself, so plan.js's frozen lib
// source-scan keeps passing.
//
// Durable truth outranks runtime signals (D4). When the runtime is a mismatch,
// foreign, or unreachable, Orca-derived facts are NOT adopted for this program (D6):
// they degrade to `stale_missing` while durable evidence still renders.
const { boundedExcerpt, boundedIds } = require("./bounded-excerpt");
const { orcaStatus, orcaTaskList, orcaGateList, orcaDispatchShow } = require("./orca-reads");
const { ghIssueView, ghPrView } = require("./gh-reads");
const { classifyOutcome, deriveProgramState, requiredEvidenceFor } = require("./status-classify");
const { isTerminalManifestState } = require("./manifest-parse");
const { orderReport } = require("./status-report");

// Every subprocess-derived value that reaches a diagnostic — inside `message` AND
// inside `ids` — is bounded (≤256 chars, marker included) so a wedged/adversarial CLI
// can never inflate or line-inject the status report (D7).
function diag(code, outcomeId, message, ids) {
  return { code, outcome_id: outcomeId ?? null, message: boundedExcerpt(message), ids: boundedIds(ids) };
}

function programMarker(programId) {
  // Literal task-title marker run.js injects: `relay-orca: <program_id>/<outcome_id>`.
  return `relay-orca: ${programId}/`;
}

function referencesProgram(text, programId) {
  const body = String(text || "");
  return body.includes("relay-orca") && body.includes(programId);
}

// Attribute the live runtime (D6). Orca facts are trusted ONLY when the live runtime
// id matches the receipt AND every live orchestration task is marked for this program.
function attributeRuntime({ receipt, programId, orca }) {
  const unreachable = { runtime: "unreachable", orcaTrusted: false, tasks: [], gates: [], diagnostic: null };
  if (!orca) return unreachable;
  const status = orcaStatus(orca, null, {});
  if (!status.ok) return unreachable;
  // Runtime is "ok" (Orca facts adopted) ONLY when status AND task-list AND gate-list
  // all succeed. A failed REQUIRED read is unreachable — never an empty array with a
  // runtime of "ok" (D4). Fabricating [] would hide awaiting_decision and forge a false
  // MISSING_TASK against a receipt whose task simply could not be listed. On unreachable,
  // Orca-derived facts are withheld and each outcome's Orca facts degrade per D5/D6.
  const taskList = orcaTaskList(orca, null, {});
  if (!taskList.ok) return unreachable;
  const gateList = orcaGateList(orca, null, {});
  if (!gateList.ok) return unreachable;
  const tasks = taskList.tasks;
  const gates = gateList.gates;
  const marker = programMarker(programId);
  const foreignTasks = tasks.filter((task) => !(typeof task.title === "string" && task.title.includes(marker)));
  // The live runtime id is subprocess-derived, so it is bounded (≤256 chars, marker
  // included) before it enters a diagnostic — the same rule the probe uses (D7).
  const liveRuntime = boundedExcerpt(status.runtimeId);
  if (receipt.runtime_id && status.runtimeId && status.runtimeId !== receipt.runtime_id) {
    return {
      runtime: "mismatch",
      orcaTrusted: false,
      tasks: [],
      gates: [],
      diagnostic: diag("RUNTIME_MISMATCH", null, "live Orca runtime id does not match the receipt; runtime signals are not adopted", { receipt_runtime: receipt.runtime_id, live_runtime: liveRuntime }),
    };
  }
  if (foreignTasks.length > 0) {
    return {
      runtime: "foreign_state",
      orcaTrusted: false,
      tasks: [],
      gates: [],
      diagnostic: diag("RUNTIME_MISMATCH", null, "live runtime carries orchestration tasks not marked for this program; runtime signals are not adopted", { foreign_task_count: foreignTasks.length, live_runtime: liveRuntime }),
    };
  }
  return { runtime: "ok", orcaTrusted: true, tasks, gates, diagnostic: null };
}

function isPendingGate(gate) {
  return gate && (gate.status === "pending" || gate.pending === true);
}

function gateBlocksTask(gate, orcaTaskId) {
  if (!gate) return false;
  if (gate.task_id === orcaTaskId || gate.task === orcaTaskId) return true;
  return Array.isArray(gate.blocks) && gate.blocks.includes(orcaTaskId);
}

// Build the gathered fact bundle for one receipt task.
function gatherOutcomeFacts(task, ctx) {
  const { manifestByRunId, fleetManifestById, runtime, gh, orca, urlFor } = ctx;
  const mappedRunId = task.relay_ids && task.relay_ids.run ? task.relay_ids.run : null;
  let manifest = null;
  let mappedRunMissing = false;
  if (mappedRunId) {
    manifest = manifestByRunId.get(mappedRunId) || null;
    mappedRunMissing = !manifest;
  }

  let orcaTask = null;
  let orcaTaskMissing = false;
  let dispatch = null;
  if (runtime.orcaTrusted && task.orca_task_id) {
    orcaTask = runtime.tasks.find((candidate) => candidate.id === task.orca_task_id) || null;
    orcaTaskMissing = !orcaTask;
    if (orcaTask) dispatch = orcaDispatchShow(orca, null, task.orca_task_id, {});
  }
  const gateBlocking = Boolean(
    runtime.orcaTrusted && task.orca_task_id && runtime.gates.some((gate) => isPendingGate(gate) && gateBlocksTask(gate, task.orca_task_id)),
  );
  // The live decision/review gates mapped to this outcome's orca_task_id feed the
  // integration_gate / advisory_review evidence contracts. Gates are runtime signals,
  // so they are only gathered when the runtime is trusted (untrusted → [] → the gate
  // evidence checks degrade to null in the classifier).
  const outcomeGates = runtime.orcaTrusted && task.orca_task_id
    ? runtime.gates.filter((gate) => gateBlocksTask(gate, task.orca_task_id))
    : [];

  // relay_fleet outcomes map via relay_ids.fleet to a fleet manifest under the SEPARATE
  // FLEETS root (see receipt-and-status.md § A8) — NOT the runs root. Its `children`
  // list still resolves each child run against the runs-root manifest map so the
  // classifier can require every child terminal.
  const mappedFleetId = task.relay_ids && task.relay_ids.fleet ? task.relay_ids.fleet : null;
  let fleetManifest = null;
  let fleetChildren = [];
  if (mappedFleetId) {
    fleetManifest = fleetManifestById.get(mappedFleetId) || null;
    if (fleetManifest && Array.isArray(fleetManifest.fleet_children)) {
      fleetChildren = fleetManifest.fleet_children.map((child) => {
        const childManifest = child.run_id ? manifestByRunId.get(child.run_id) || null : null;
        return {
          leaf_ref: child.leaf_ref ?? null,
          run_id: child.run_id ?? null,
          terminal: childManifest ? isTerminalManifestState(childManifest.state) : false,
        };
      });
    }
  }

  // GitHub reachability (#945 A11): a REQUIRED live GitHub read is one whose result
  // feeds this outcome's evidence contract. `pr_merged` needs `gh pr view`;
  // `issue_closed` / `tracker_reconciled` need `gh issue view`. When such a read is
  // attempted (the manifest names the PR/issue AND a gh runner exists) but FAILS,
  // the fact stays null AND we flag the outcome so it degrades to `stale_missing`
  // rather than silently classifying `running` on a null fact.
  const contract = requiredEvidenceFor(task.kind);
  const prRequired = contract.includes("pr_merged");
  const issueRequired = contract.includes("issue_closed") || contract.includes("tracker_reconciled");
  let pr = null;
  let issue = null;
  let prUrl = null;
  let issueUrl = null;
  let githubUnreachable = false;
  if (manifest) {
    if (manifest.pr_number != null) {
      prUrl = urlFor("pull", manifest.pr_number);
      if (gh) {
        const prView = ghPrView(gh, null, manifest.pr_number, {});
        if (prView.ok) pr = prView;
        else if (prRequired) githubUnreachable = true;
      }
    }
    if (manifest.issue_number != null) {
      issueUrl = urlFor("issues", manifest.issue_number);
      if (gh) {
        const issueView = ghIssueView(gh, null, manifest.issue_number, {});
        if (issueView.ok) issue = issueView;
        else if (issueRequired) githubUnreachable = true;
      }
    }
  }

  return {
    receiptTask: task,
    manifest,
    mappedRunId,
    mappedRunMissing,
    orcaTask,
    orcaTaskMissing,
    dispatch,
    gateBlocking,
    outcomeGates,
    fleetManifest,
    mappedFleetId,
    fleetChildren,
    pr,
    issue,
    prUrl,
    issueUrl,
    githubUnreachable,
  };
}

// Program-level duplicate-mapping detector (D7): two receipt entries sharing an
// orca_task_id or a relay run id. Returns diagnostics plus the involved outcome ids.
function detectDuplicateMappings(tasks) {
  const diagnostics = [];
  const duplicateOutcomeIds = new Set();
  const group = (keyOf, label, idKey) => {
    const byKey = new Map();
    tasks.forEach((task) => {
      const key = keyOf(task);
      if (!key) return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(task.outcome_id);
    });
    for (const [key, outcomes] of byKey) {
      if (outcomes.length > 1) {
        outcomes.forEach((id) => duplicateOutcomeIds.add(id));
        diagnostics.push(diag("DUPLICATE_MAPPING", null, `${label} ${key} is mapped by ${outcomes.length} outcomes`, { [idKey]: key, outcomes }));
      }
    }
  };
  group((task) => task.orca_task_id, "Orca task", "orca_task_id");
  group((task) => (task.relay_ids && task.relay_ids.run) || null, "relay run", "run");
  return { diagnostics, duplicateOutcomeIds };
}

// live→receipt back-pointer discovery (D7): a relay manifest referencing this program
// but absent from the receipt's mappings. Text only; NO mutation is performed.
function discoverBackPointers({ manifests, tasks, programId }) {
  const knownRunIds = new Set(tasks.map((task) => task.relay_ids && task.relay_ids.run).filter(Boolean));
  const candidates = [];
  manifests.forEach((entry) => {
    if (!entry.run_id || knownRunIds.has(entry.run_id)) return;
    if (!referencesProgram(entry.text, programId)) return;
    candidates.push({
      kind: "adopt_relay_run",
      outcome_id: null,
      proposal: boundedExcerpt(`relay run ${entry.run_id} references program ${programId} but is absent from the receipt; reconcile it into the receipt mapping (no mutation performed)`),
    });
  });
  return candidates;
}

function repairForOutcome(entry) {
  const repairs = [];
  entry.diagnostics.forEach((diagnostic) => {
    if (diagnostic.code === "MISSING_RELAY_RUN") {
      repairs.push({ kind: "reconcile_relay_run", outcome_id: diagnostic.outcome_id, proposal: boundedExcerpt(`mapped relay run for outcome ${diagnostic.outcome_id} is absent; re-establish or clear the mapping via a supervised reconcile (no mutation performed)`) });
    }
    if (diagnostic.code === "MISSING_TASK" || diagnostic.code === "MISSING_DISPATCH" || diagnostic.code === "MISSING_TERMINAL") {
      repairs.push({ kind: "reconcile_runtime_mapping", outcome_id: diagnostic.outcome_id, proposal: boundedExcerpt(`runtime mapping for outcome ${diagnostic.outcome_id} is stale (${diagnostic.code}); reconcile against durable evidence (no mutation performed)`) });
    }
  });
  return repairs;
}

// Assemble the full D9 report from the receipt + injected read adapters. `manifests`
// are the child run manifests (runs root); `fleetManifests` are the fleet manifests
// from the SEPARATE fleets root (#945 A8), keyed by fleet id.
function deriveStatusReport({ receipt, programId, receiptPath, manifests, fleetManifests = [], orca, gh, urlFor }) {
  const resolvedUrlFor = typeof urlFor === "function" ? urlFor : () => null;
  const manifestByRunId = new Map(manifests.filter((entry) => entry.run_id).map((entry) => [entry.run_id, entry.parsed]));
  const fleetManifestById = new Map(fleetManifests.filter((entry) => entry.run_id).map((entry) => [entry.run_id, entry.parsed]));
  const runtime = attributeRuntime({ receipt, programId, orca });
  const { diagnostics: duplicateDiagnostics, duplicateOutcomeIds } = detectDuplicateMappings(receipt.tasks);

  const entries = receipt.tasks.map((task) => {
    const facts = gatherOutcomeFacts(task, { manifestByRunId, fleetManifestById, runtime, gh, orca, urlFor: resolvedUrlFor });
    return classifyOutcome(facts, { orcaTrusted: runtime.orcaTrusted, isDuplicate: duplicateOutcomeIds.has(task.outcome_id) });
  });

  const diagnostics = [];
  if (runtime.diagnostic) diagnostics.push(runtime.diagnostic);
  entries.forEach((entry) => entry.diagnostics.forEach((entryDiag) => diagnostics.push(entryDiag)));
  duplicateDiagnostics.forEach((duplicateDiag) => diagnostics.push(duplicateDiag));

  const repairCandidates = [];
  entries.forEach((entry) => repairForOutcome(entry).forEach((repair) => repairCandidates.push(repair)));
  discoverBackPointers({ manifests, tasks: receipt.tasks, programId }).forEach((candidate) => repairCandidates.push(candidate));

  const report = {
    ok: true,
    program_id: programId,
    receipt_path: receiptPath,
    runtime: runtime.runtime,
    program_state: deriveProgramState(entries),
    outcomes: entries.map((entry) => entry.outcome),
    diagnostics,
    repair_candidates: repairCandidates,
    evidence_checked: true,
  };
  return orderReport(report);
}

module.exports = { deriveStatusReport, attributeRuntime, detectDuplicateMappings, discoverBackPointers };
