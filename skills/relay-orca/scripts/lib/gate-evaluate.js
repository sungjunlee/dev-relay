"use strict";

// Pure exit-gate evaluation (#947 D1/D2/D4/D5). Given the #945 reconciliation report, the
// parsed receipt, the program's VERBATIM exit_gates, and an injected integration-evidence
// reader, this module evaluates each gate per kind and returns the per-gate results plus
// the prerequisite verdict and blocking reasons. It performs NO I/O — the top-level
// script injects the live-evidence reader — so plan.js's frozen lib source-scan keeps
// passing.
//
// Two invariants are load-bearing (severity-calibrated safety properties):
//   - Gates are INPUT artifacts: every result is keyed to a program exit-gate string
//     verbatim; nothing is invented, renamed, dropped, or weakened. Unrecognized prefix →
//     `unevaluable`, NEVER passed (fail closed).
//   - Gate results derive EXCLUSIVELY from live evidence (integration artifact, decision /
//     authorization records, receipt counters, reconciliation) — NEVER from Orca task or
//     worker status. A failing integration gate can never be masked by task completion.
const { boundedExcerpt } = require("./bounded-excerpt");
const { parseGate } = require("./gate-kinds");
const { effectiveCounters, parseBudgetRef, COUNTER_NAMES } = require("./budget-counters");
const { validateDecisionRecord, isResolved, findById } = require("./decision-records");
const { indexDeclarations, validateArtifact } = require("./integration-evidence");

function result(state, evidence, message) {
  return { state, evidence: boundedExcerpt(evidence), message: boundedExcerpt(message) };
}

// integration: a named live check / evidence artifact must PASS live. The artifact is read
// through the injected reader (top-level fs), NEVER from task status. Absent artifact →
// failed (no live pass evidence), never passed.
function evalIntegration(ref, readIntegrationEvidence, integrationContract, programId, runtimeId) {
  const declarationError = integrationContract && integrationContract.errors
    ? integrationContract.errors.get(ref)
    : "accepted program has no integration identity contract";
  if (declarationError) {
    return result(
      "failed",
      `identity:${declarationError}`,
      `integration check "${ref}" rejected: identity contract ${declarationError}`,
    );
  }
  const declaration = integrationContract && integrationContract.byRef ? integrationContract.byRef.get(ref) : null;
  const evidence = typeof readIntegrationEvidence === "function" ? readIntegrationEvidence(ref) : null;
  if (!evidence || evidence.present !== true) {
    return result("failed", `no live evidence artifact for ${ref}`, `integration check "${ref}" has no live evidence artifact; gate cannot pass`);
  }
  if (evidence.valid !== true) {
    const reason = evidence.reason || "artifact identity or verification binding is invalid";
    return result(
      "failed",
      `identity:${reason}`,
      `integration check "${ref}" rejected: identity contract ${reason}`,
    );
  }
  const checked = validateArtifact(evidence.artifact, { declaration, programId, runtimeId, checkRef: ref });
  if (!checked.valid) {
    return result(
      "failed",
      `identity:${checked.reason}`,
      `integration check "${ref}" rejected: identity contract ${checked.reason}`,
    );
  }
  if (checked.passed === true) {
    return result("passed", checked.evidence, `integration check "${ref}" passed live`);
  }
  return result("failed", checked.evidence, `integration check "${ref}" failed live`);
}

// advisory: reuse the #945 advisory contract — advisory evidence posted AND every blocking
// finding triaged, derived from the reconciled advisory_review outcomes.
function evalAdvisory(ref, advisory) {
  if (advisory.posted && advisory.triaged) {
    return result("passed", `advisory ${ref} posted+triaged`, `advisory "${ref}": evidence posted and blocking findings triaged`);
  }
  return result("failed", `advisory ${ref} incomplete`, `advisory "${ref}": evidence not posted or blocking findings not triaged`);
}

// tracker: tracker reconciliation clean for the program's issues — no reopened issue, no
// duplicate/lost receipt↔live mapping, no unreconciled back-pointer.
function evalTracker(ref, trackerClean) {
  if (trackerClean) return result("passed", `tracker ${ref} reconciled`, `tracker "${ref}": reconciliation clean for the program's issues`);
  return result("failed", `tracker ${ref} ambiguous`, `tracker "${ref}": reconciliation not clean (reopened issue or ambiguous receipt/tracker graph)`);
}

// decision: resolves ONLY against a decision record carrying all six provenance keys.
// Missing key → unevaluable (fail closed). Present-but-unresolved → awaiting_decision.
function evalDecision(ref, receipt) {
  const record = findById(receipt.decisions, ref);
  if (!record) return result("awaiting_decision", "no decision record", `decision "${ref}" has no record; awaiting explicit operator resolution`);
  const check = validateDecisionRecord(record);
  if (!check.valid) {
    return result("unevaluable", "invalid decision record", `decision record "${ref}" is invalid: missing/ill-typed provenance key "${check.missingKey}"`);
  }
  if (!isResolved(record)) return result("awaiting_decision", "recorded but unresolved", `decision "${ref}" is recorded but unresolved; awaiting a resolution`);
  return result("passed", `resolved: ${record.resolution}`, `decision "${ref}" resolved by ${record.resolver}`);
}

// budget: compare a receipt-recorded counter against the gate's numeric ceiling. Under
// ceiling → passed; at/over → failed with BOTH numbers in the message.
function evalBudget(ref, receipt) {
  const parsed = parseBudgetRef(ref);
  if (!parsed) return result("unevaluable", "unparseable budget ref", `budget gate ref "${ref}" is not a <counter> <= <int> expression; fail closed`);
  if (!COUNTER_NAMES.includes(parsed.counter)) {
    return result("unevaluable", "unknown counter", `budget gate references unknown counter "${parsed.counter}" (known: ${COUNTER_NAMES.join(", ")})`);
  }
  const value = effectiveCounters(receipt)[parsed.counter];
  if (value < parsed.ceiling) {
    return result("passed", `${parsed.counter}=${value} < ${parsed.ceiling}`, `budget "${parsed.counter}": ${value} under ceiling ${parsed.ceiling}`);
  }
  return result("failed", `${parsed.counter}=${value} >= ${parsed.ceiling}`, `budget ceiling reached: ${parsed.counter}=${value} at/over ceiling ${parsed.ceiling}`);
}

// authorization: requires an explicit authorization record. Absent → awaiting_decision-
// equivalent gate state, never passed (D5).
function evalAuthorization(ref, receipt) {
  const record = findById(receipt.authorizations, ref);
  if (!record) return result("awaiting_decision", "absent", `authorization "${ref}" has no record; awaiting explicit operator authorization`);
  return result("passed", `authorizer ${record.authorizer}`, `authorization "${ref}" recorded by ${record.authorizer}`);
}

// Derive the advisory/tracker reconciliation facts once from the report.
function reconciliationFacts(report) {
  const outcomes = report.outcomes || [];
  const advisoryOutcomes = outcomes.filter((outcome) => outcome.kind === "advisory_review");
  const advisory = {
    posted: advisoryOutcomes.length > 0 && advisoryOutcomes.every((outcome) => outcome.evidence && outcome.evidence.advisory_evidence_posted === true),
    triaged: advisoryOutcomes.length > 0 && advisoryOutcomes.every((outcome) => outcome.evidence && outcome.evidence.blocking_findings_triaged === true),
  };
  const codes = new Set((report.diagnostics || []).map((diagnostic) => diagnostic.code));
  const trackerClean =
    !codes.has("ISSUE_REOPENED") &&
    !codes.has("DUPLICATE_MAPPING") &&
    !codes.has("MISSING_RELAY_RUN") &&
    (report.repair_candidates || []).length === 0;
  return { advisory, trackerClean };
}

function evaluateOneGate(gateString, ctx) {
  const parsed = parseGate(gateString);
  const { kind, ref } = parsed;
  let evaluated;
  switch (kind) {
    case "integration":
      evaluated = evalIntegration(ref, ctx.readIntegrationEvidence, ctx.integrationContract, ctx.programId, ctx.runtimeId);
      break;
    case "advisory":
      evaluated = evalAdvisory(ref, ctx.facts.advisory);
      break;
    case "tracker":
      evaluated = evalTracker(ref, ctx.facts.trackerClean);
      break;
    case "decision":
      evaluated = evalDecision(ref, ctx.receipt);
      break;
    case "budget":
      evaluated = evalBudget(ref, ctx.receipt);
      break;
    case "authorization":
      evaluated = evalAuthorization(ref, ctx.receipt);
      break;
    default:
      evaluated = result(
        "unevaluable",
        "",
        `exit gate "${gateString}" has no recognized kind prefix (integration:/advisory:/tracker:/decision:/budget:/authorization:); fail closed`,
      );
  }
  return { gate: gateString, kind, state: evaluated.state, evidence: evaluated.evidence, message: evaluated.message };
}

const BLOCKING_REASON_BY_STATE = Object.freeze({
  failed: "GATE_FAILED",
  unevaluable: "GATE_UNEVALUABLE",
  awaiting_decision: "GATE_AWAITING_DECISION",
});

// Evaluate every program exit gate verbatim (D1). Prerequisite (D2): gates evaluate ONLY
// after every accepted outcome reconciles complete_with_evidence; before that they are
// `not_yet_evaluable` with the blocking outcomes listed. Returns { prerequisites_met,
// gates, blocking_reasons, blocking_outcomes }.
function evaluateGates({ report, receipt, exitGates, readIntegrationEvidence, integrationEvidenceVersion, integrationEvidence }) {
  const gateStrings = Array.isArray(exitGates) ? exitGates : [];
  const outcomes = report.outcomes || [];
  const blockingOutcomes = outcomes.filter((outcome) => outcome.state !== "complete_with_evidence");
  const prerequisitesMet = outcomes.length > 0 && blockingOutcomes.length === 0;

  if (!prerequisitesMet) {
    const gates = gateStrings.map((gateString) => {
      const parsed = parseGate(gateString);
      return {
        gate: gateString,
        kind: parsed.kind,
        state: "not_yet_evaluable",
        evidence: "",
        message: boundedExcerpt(`prerequisite: ${blockingOutcomes.length} accepted outcome(s) not yet complete_with_evidence`),
      };
    });
    const blocking = blockingOutcomes.map((outcome) => ({
      reason_code: "PREREQUISITES_NOT_MET",
      message: boundedExcerpt(`outcome ${outcome.outcome_id} is ${outcome.state}, not complete_with_evidence`),
    }));
    return { prerequisites_met: false, gates, blocking_reasons: blocking, blocking_outcomes: blockingOutcomes.map((outcome) => outcome.outcome_id) };
  }

  const integrationRefs = gateStrings
    .map((gateString) => parseGate(gateString))
    .filter((parsed) => parsed.kind === "integration")
    .map((parsed) => parsed.ref);
  const integrationContract = indexDeclarations({
    programId: report.program_id,
    runtimeId: receipt && receipt.runtime_id,
    refs: integrationRefs,
    version: integrationEvidenceVersion,
    declarations: integrationEvidence,
  });
  const ctx = {
    receipt,
    readIntegrationEvidence,
    integrationContract,
    programId: report.program_id,
    runtimeId: receipt && receipt.runtime_id,
    facts: reconciliationFacts(report),
  };
  const gates = gateStrings.map((gateString) => evaluateOneGate(gateString, ctx));
  const blocking = gates
    .filter((gate) => gate.state !== "passed")
    .map((gate) => ({ reason_code: BLOCKING_REASON_BY_STATE[gate.state] || "GATE_BLOCKED", message: boundedExcerpt(gate.message) }));
  return { prerequisites_met: true, gates, blocking_reasons: blocking, blocking_outcomes: [] };
}

function allGatesPassed(gates) {
  return Array.isArray(gates) && gates.length > 0 && gates.every((gate) => gate.state === "passed");
}

module.exports = { evaluateGates, evaluateOneGate, reconciliationFacts, allGatesPassed };
