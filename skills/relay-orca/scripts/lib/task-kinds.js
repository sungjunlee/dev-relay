"use strict";

const { reject } = require("./reasons");

// The five supported task kinds. recommended_route names the relay OPERATOR
// surface only; the executor/reviewer engine is deliberately absent — engine
// selection is relay route configuration, not part of the program (D11).
const TASK_KINDS = {
  relay_run: {
    route: { operator: "relay", mode: "single_run", read_only: false },
    evidence: ["relay manifest reaches merged", "PR merged", "issue closed"],
  },
  relay_fleet: {
    route: { operator: "relay-fleet", mode: "prepared_leaves", read_only: false },
    evidence: ["every fleet child terminal (merged/closed)", "fleet manifest closed"],
  },
  integration_gate: {
    route: { operator: "relay-review", mode: "integration_gate", read_only: true },
    evidence: ["integration gate report produced", "gate check passes on live evidence"],
  },
  advisory_review: {
    route: { operator: "relay-review", mode: "advisory", read_only: true },
    evidence: ["advisory review evidence posted", "blocking findings triaged"],
  },
  tracker_reconciliation: {
    route: { operator: "dev-backlog", mode: "reconcile", read_only: true },
    evidence: ["tracker/issue state reconciled against relay manifests"],
  },
};

const SUPPORTED_KINDS = Object.keys(TASK_KINDS);

// relay-orca supervising a relay-orca program is forbidden (D9). Kept out of the
// generic UNSUPPORTED_TASK_KIND bucket so it fails with its own reason code.
const NESTED_ORCA_KINDS = new Set(["relay_orca", "relay-orca", "orca"]);

function assertSupportedKind(outcome) {
  const kind = outcome.task_kind;
  if (NESTED_ORCA_KINDS.has(kind)) {
    reject("NESTED_RELAY_ORCA", `outcome ${outcome.id} nests relay-orca (task_kind=${kind}); nested relay-orca is forbidden`);
  }
  if (!SUPPORTED_KINDS.includes(kind)) {
    reject("UNSUPPORTED_TASK_KIND", `outcome ${outcome.id} has unsupported task_kind ${JSON.stringify(kind)}; supported: ${SUPPORTED_KINDS.join(", ")}`);
  }
}

function assertPreparedFleet(outcome) {
  if (outcome.task_kind !== "relay_fleet") return;
  const leaves = Array.isArray(outcome.leaves) ? outcome.leaves : [];
  if (leaves.length === 0) {
    reject("UNPREPARED_FLEET_LEAF", `relay_fleet outcome ${outcome.id} has no prepared leaves`);
  }
  leaves.forEach((leaf, index) => assertPreparedLeaf(outcome, leaf, index));
}

function assertPreparedLeaf(outcome, leaf, index) {
  for (const field of ["prompt_file", "rubric_file", "done_criteria_file"]) {
    const value = leaf && leaf[field];
    if (typeof value !== "string" || value.trim() === "") {
      reject("UNPREPARED_FLEET_LEAF", `relay_fleet outcome ${outcome.id} leaf #${index + 1} is missing prepared ${field}`);
    }
  }
}

function routeFor(kind) {
  return { ...TASK_KINDS[kind].route };
}

function defaultEvidenceFor(kind) {
  return [...TASK_KINDS[kind].evidence];
}

module.exports = {
  TASK_KINDS,
  SUPPORTED_KINDS,
  assertSupportedKind,
  assertPreparedFleet,
  routeFor,
  defaultEvidenceFor,
};
