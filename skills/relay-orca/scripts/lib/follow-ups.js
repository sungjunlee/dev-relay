"use strict";

// Follow-up PROPOSAL derivation (#947 D3). Pure: no I/O. A follow-up is ADVISORY: this
// module only shapes proposals for the report (and, ONLY under an explicit
// `--record-proposals` flag, for the receipt append performed by the top-level script).
// No code path here creates issues, dispatches work, merges, deploys, or mutates a
// tracker — acceptance is an OPERATOR act (file the issue, append a NEW LATER-wave
// outcome to the program JSON, re-run plan/run).
const { boundedExcerpt } = require("./bounded-excerpt");

// The verbatim proposed-follow-up entry shape (D3). Exactly one source key.
function proposal({ id, sourceGate, sourceOutcome, description, proposedWave }) {
  const entry = { id };
  if (sourceGate != null) entry.source_gate = sourceGate;
  else entry.source_outcome = sourceOutcome != null ? sourceOutcome : null;
  entry.description = boundedExcerpt(description);
  entry.proposed_wave = proposedWave;
  entry.status = "proposed";
  return entry;
}

function sanitizeId(source) {
  return String(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "source";
}

// The next wave int = one past the highest wave recorded in the receipt mapping (D3).
function nextWave(receipt) {
  const tasks = Array.isArray(receipt && receipt.tasks) ? receipt.tasks : [];
  const maxWave = tasks.reduce((max, task) => (Number.isInteger(task.wave) && task.wave > max ? task.wave : max), 0);
  return maxWave + 1;
}

// Derive proposals from evaluated gates + reconciliation. A failing/unevaluable EXIT gate
// implies remediation work; an escalated/inconsistent/stale outcome discovered before the
// prerequisites reconcile is discovered implementation work. Each becomes one proposal.
function deriveProposals({ report, gates, receipt }) {
  const wave = nextWave(receipt);
  const proposals = [];
  (gates || []).forEach((gate) => {
    if (gate.state === "failed" || gate.state === "unevaluable") {
      proposals.push(
        proposal({
          id: `followup-${sanitizeId(gate.gate)}`,
          sourceGate: gate.gate,
          description: `Exit gate "${gate.gate}" is ${gate.state}; file remediation work as a new later-wave outcome`,
          proposedWave: wave,
        }),
      );
    }
  });
  (report.outcomes || []).forEach((outcome) => {
    if (outcome.state === "escalated" || outcome.state === "inconsistent" || outcome.state === "stale_missing") {
      proposals.push(
        proposal({
          id: `followup-${sanitizeId(outcome.outcome_id)}`,
          sourceOutcome: outcome.outcome_id,
          description: `Outcome "${outcome.outcome_id}" reconciled ${outcome.state}; file follow-up work as a new later-wave outcome`,
          proposedWave: wave,
        }),
      );
    }
  });
  return proposals;
}

// Merge freshly-derived proposals with any receipt-recorded follow_ups, de-duplicating by
// id (a recorded entry wins so an operator-set `deferred` status is preserved). Returns
// { blocking, deferred }: blocking = status "proposed" (targets accepted scope → blocks
// completion); deferred = status "deferred" (non-blocking, listed separately, D6).
function mergeFollowUps({ derived, recorded }) {
  const byId = new Map();
  (derived || []).forEach((entry) => byId.set(entry.id, entry));
  (Array.isArray(recorded) ? recorded : []).forEach((entry) => {
    if (entry && typeof entry.id === "string") byId.set(entry.id, normalizeRecorded(entry));
  });
  const all = [...byId.values()];
  return {
    blocking: all.filter((entry) => entry.status !== "deferred"),
    deferred: all.filter((entry) => entry.status === "deferred"),
  };
}

// Normalize a receipt-recorded follow_up back into the verbatim entry shape so a
// hand-appended or prior-write entry renders deterministically. Unknown status defaults
// to "proposed" (fail closed: an unrecognized status still blocks completion).
function normalizeRecorded(entry) {
  const status = entry.status === "deferred" ? "deferred" : "proposed";
  return proposalFrom(entry, status);
}

function proposalFrom(entry, status) {
  const out = { id: entry.id };
  if (entry.source_gate != null) out.source_gate = entry.source_gate;
  else out.source_outcome = entry.source_outcome != null ? entry.source_outcome : null;
  out.description = boundedExcerpt(entry.description != null ? entry.description : "");
  out.proposed_wave = Number.isInteger(entry.proposed_wave) ? entry.proposed_wave : null;
  out.status = status;
  return out;
}

// Additive id-keyed upsert for the `--record-proposals` receipt append (#947 owner
// amendment A1). The recorded follow_ups already on the receipt are preserved BYTE-FOR-BYTE
// (same object references, untouched) and WIN on id conflict — so an operator-set `deferred`
// row is never overwritten by a freshly-derived `proposed` one. Only derived proposals whose
// id is not already recorded are appended, in derivation order, after the recorded block.
// Pure: no I/O, no mutation of either input array or its entries.
function upsertRecordedFollowUps({ recorded, derived }) {
  const existing = Array.isArray(recorded) ? recorded : [];
  const recordedIds = new Set(
    existing.filter((entry) => entry && typeof entry.id === "string").map((entry) => entry.id),
  );
  const appended = (Array.isArray(derived) ? derived : []).filter(
    (entry) => entry && typeof entry.id === "string" && !recordedIds.has(entry.id),
  );
  return [...existing, ...appended];
}

module.exports = { proposal, deriveProposals, mergeFollowUps, upsertRecordedFollowUps, nextWave, sanitizeId };
