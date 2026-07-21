"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const PROOF = require(path.join(SCRIPTS, "lib", "closed-program-proof.js"));
const { programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
const { RECEIPT_NOTE } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { verificationBinding, sha256 } = require(path.join(SCRIPTS, "lib", "integration-evidence.js"));
const { canonicalIntegrationQuestion } = require(path.join(SCRIPTS, "lib", "integration-lifecycle.js"));

const PROGRAM_ID = "proof-program/2026-07";
const RUNTIME_ID = "runtime-proof-1";
const OUTCOME_ID = "integration-main-suite";
const RAW_CHECK_REF = "full-suite";

function receiptTask(outcomeId, kind, orcaTaskId) {
  return {
    outcome_id: outcomeId,
    task_id: `relay-task-${outcomeId}`,
    kind,
    wave: 1,
    orca_task_id: orcaTaskId,
    dispatch_id: `dispatch-${outcomeId}`,
    assignee: `operator-${outcomeId}`,
    relay_ids: { request: null, run: kind === "relay_run" ? `run-${outcomeId}` : null, fleet: null },
  };
}

function makeVerification(passed = true) {
  return verificationBinding({
    input_sha256: `sha256:${"a".repeat(64)}`,
    result_sha256: sha256(passed ? "fixture-result-passed" : "fixture-result-failed"),
    passed,
  });
}

function genericArtifact({ programId = PROGRAM_ID, runtimeId = RUNTIME_ID, checkRef = RAW_CHECK_REF, passed = true } = {}) {
  return {
    schema: 1,
    program_id: programId,
    runtime_id: runtimeId,
    check_ref: checkRef,
    verification: makeVerification(passed),
    evidence: "fixture evidence; not parsed by the verifier",
  };
}

function acceptedProgram() {
  return {
    id: PROGRAM_ID,
    outcomes: [
      { id: "relay-build", task_kind: "relay_run", accepted_outcomes: ["merged"] },
      { id: OUTCOME_ID, task_kind: "integration_gate", accepted_outcomes: ["passed"] },
    ],
    exit_gates: [`integration:${RAW_CHECK_REF}`],
    integration_evidence_version: 1,
    integration_evidence: [{
      program_id: PROGRAM_ID,
      runtime_id: RUNTIME_ID,
      check_ref: RAW_CHECK_REF,
      verification: makeVerification(true),
    }],
  };
}

function receipt(stopped = {}) {
  return {
    schema: 1,
    program_id: PROGRAM_ID,
    source: "/tmp/accepted-program.json",
    repo: { slug: "fixture-repo", root: "/tmp/fixture-repo" },
    runtime_id: RUNTIME_ID,
    tasks: [
      receiptTask("relay-build", "relay_run", "orca-build"),
      receiptTask(OUTCOME_ID, "integration_gate", "orca-integration"),
    ],
    terminals_created: [],
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    note: RECEIPT_NOTE,
    ...stopped,
  };
}

function canonicalGate({ id = "gate-integration", resolution = "passed", status = "passed", question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment) } = {}) {
  return {
    id,
    task_id: "orca-integration",
    question,
    options: ["passed", "failed"],
    resolution,
    status,
  };
}

function fixture(overrides = {}) {
  const program = acceptedProgram();
  const baseReceipt = receipt();
  const outcomeEvidence = {
    "relay-build": {
      manifest: { state: "merged", run_id: "run-relay-build", pr_number: 101, issue_number: 202, head_sha: "abc" },
      pr: { state: "MERGED", mergedAt: "2026-07-20T00:01:00.000Z", headRefOid: "abc", number: 101 },
      issue: { state: "CLOSED", number: 202 },
    },
    [OUTCOME_ID]: { integration: { report_present: true } },
  };
  const tasks = [
    { id: "orca-build", task_title: `relay-orca: ${programSegment(PROGRAM_ID)}/relay-build`, status: "completed", worker_done: true },
    { id: "orca-integration", task_title: `relay-orca: ${programSegment(PROGRAM_ID)}/${OUTCOME_ID}`, status: "completed", worker_done: true },
  ];
  const snapshot = {
    status: { runtime_id: RUNTIME_ID },
    task_list: { runtime_id: RUNTIME_ID, tasks },
    gate_list: { runtime_id: RUNTIME_ID, gates: [canonicalGate()] },
  };
  const inputs = {
    acceptedProgram: program,
    receipt: baseReceipt,
    trustedGenericIntegrationEvidence: { [RAW_CHECK_REF]: genericArtifact() },
    durableOutcomeEvidence: outcomeEvidence,
    orcaSnapshot: snapshot,
    programSegment,
    ...overrides,
  };
  return inputs;
}

function verify(overrides = {}) {
  return PROOF.verifyClosedProgram(fixture(overrides));
}

test("closed-program proof recomputes the exact identity and keeps generic/lifecycle names distinct", () => {
  const result = verify();
  assert.equal(result.ok, true);
  assert.equal(result.program_id, PROGRAM_ID);
  assert.equal(result.runtime_id, RUNTIME_ID);
  assert.deepEqual(result.outcome_ids, [OUTCOME_ID, "relay-build"].sort());
  assert.deepEqual(result.orca_task_ids, ["orca-build", "orca-integration"]);
  assert.deepEqual(result.integration_gate_ids, ["gate-integration"]);
  assert.equal(result.final_summary.program_complete, true);
  assert.equal(result.final_summary.stopped_on, null);
  assert.deepEqual(result.final_summary.blocking_reasons, []);
  assert.deepEqual(result.final_summary.lifecycle_diagnostics, []);
});

test("proof is byte-deterministic across accepted, receipt, live, and evidence ordering", () => {
  const first = verify();
  const inputs = fixture();
  inputs.acceptedProgram.outcomes.reverse();
  inputs.receipt.tasks.reverse();
  inputs.orcaSnapshot.task_list.tasks.reverse();
  inputs.orcaSnapshot.gate_list.gates.reverse();
  inputs.trustedGenericIntegrationEvidence = [{ ...genericArtifact() }];
  inputs.durableOutcomeEvidence = [
    { outcome_id: OUTCOME_ID, integration: { report_present: true } },
    { outcome_id: "relay-build", manifest: { state: "merged", run_id: "run-relay-build", pr_number: 101, issue_number: 202, head_sha: "abc" }, pr: { state: "MERGED", mergedAt: "2026-07-20T00:01:00.000Z", headRefOid: "abc", number: 101 }, issue: { state: "CLOSED", number: 202 } },
  ];
  const second = PROOF.verifyClosedProgram(inputs);
  assert.deepEqual(second, first);
});

test("receipt stop drill and caller false-complete bits are not proof authority", () => {
  const inputs = fixture({ receipt: receipt({ stopped_at: "2026-07-20T00:02:00.000Z", stop_reason: "operator drill" }), program_complete: true, finalSummary: { program_complete: true, stopped_on: null } });
  const result = PROOF.verifyClosedProgram(inputs);
  assert.equal(result.ok, true);
  assert.equal(result.receipt_stopped_at, undefined);
});

test("failed or active live task fails even when durable evidence claims closure", () => {
  for (const status of ["failed", "dispatched"]) {
    const inputs = fixture();
    inputs.orcaSnapshot.task_list.tasks.find((task) => task.id === "orca-build").status = status;
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false, status);
    assert.match(result.reasonCode, /^PROOF_TASK_/);
  }
});

test("missing, cross-runtime, stale, and failed generic evidence fail closed", () => {
  for (const overrides of [
    { trustedGenericIntegrationEvidence: {} },
    { trustedGenericIntegrationEvidence: { [RAW_CHECK_REF]: genericArtifact({ runtimeId: "other-runtime" }) } },
    { trustedGenericIntegrationEvidence: { [RAW_CHECK_REF]: { ...genericArtifact(), verification: makeVerification(false) } } },
    { trustedGenericIntegrationEvidence: { [RAW_CHECK_REF]: genericArtifact({ programId: "other-program" }) } },
  ]) {
    const result = verify(overrides);
    assert.equal(result.ok, false);
    assert.match(result.reasonCode, /^(PROOF_EVIDENCE_|PROOF_CROSS_|PROOF_STALE_)/);
  }
});

test("canonical integration gate must be exactly one, passed, and canonical", () => {
  for (const gates of [
    [canonicalGate({ status: "pending", resolution: undefined })],
    [canonicalGate({ status: "failed", resolution: "failed" })],
    [canonicalGate({ question: "same words, wrong identity" })],
    [canonicalGate(), canonicalGate({ id: "gate-duplicate" })],
  ]) {
    const result = verify({ orcaSnapshot: { ...fixture().orcaSnapshot, gate_list: { runtime_id: RUNTIME_ID, gates } } });
    assert.equal(result.ok, false);
    assert.match(result.reasonCode, /^PROOF_GATE_/);
  }
});

test("runtime identity requires all three structured Orca reads to be present and identical", () => {
  for (const snapshot of [
    { status: { runtime_id: RUNTIME_ID }, task_list: { runtime_id: "other", tasks: [] }, gate_list: { runtime_id: RUNTIME_ID, gates: [] } },
    { status: { runtime_id: "" }, task_list: { runtime_id: RUNTIME_ID, tasks: [] }, gate_list: { runtime_id: RUNTIME_ID, gates: [] } },
  ]) {
    const result = verify({ orcaSnapshot: { ...fixture().orcaSnapshot, ...snapshot } });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_CROSS_RUNTIME");
  }
});

test("program-scoped proof ignores unrelated foreign rows for the later admission filter", () => {
  const inputs = fixture();
  inputs.orcaSnapshot.task_list.tasks.push({ id: "foreign-active", task_title: "relay-orca: another-program/old", status: "dispatched" });
  inputs.orcaSnapshot.gate_list.gates.push({ id: "foreign-gate", task_id: "foreign-active", question: "unrelated", options: ["yes", "no"], status: "pending" });
  const result = PROOF.verifyClosedProgram(inputs);
  assert.equal(result.ok, true);
});

test("the compact injected snapshot shape used by the admission boundary is supported", () => {
  const inputs = fixture();
  const snapshot = inputs.orcaSnapshot;
  inputs.orcaSnapshot = {
    runtimeId: RUNTIME_ID,
    taskRuntimeId: RUNTIME_ID,
    gateRuntimeId: RUNTIME_ID,
    tasks: snapshot.task_list.tasks,
    gates: snapshot.gate_list.gates,
  };
  assert.equal(PROOF.verifyClosedProgram(inputs).ok, true);
});

test("a false-complete durable summary cannot mask an incomplete manifest", () => {
  const inputs = fixture();
  inputs.durableOutcomeEvidence["relay-build"].manifest.state = "review_pending";
  inputs.finalSummary = { program_complete: true, stopped_on: null, blocking_reasons: [] };
  const result = PROOF.verifyClosedProgram(inputs);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "PROOF_OUTCOME_INCOMPLETE");
  assert.equal(result.final_summary.program_complete, false);
  assert.notEqual(result.final_summary.stopped_on, null);
});

test("durable evidence must match the receipt-mapped run/PR/issue identity, not a generic merged shape", () => {
  const cases = [
    // Manifest run id disagrees with the receipt-mapped run-relay-build.
    (evidence) => { evidence["relay-build"].manifest.run_id = "run-foreign"; },
    // Injected PR record number disagrees with the merged manifest's declared PR number.
    (evidence) => { evidence["relay-build"].pr.number = 999; },
    // Injected PR record carries no number at all, so identity cannot be confirmed.
    (evidence) => { delete evidence["relay-build"].pr.number; },
    // Injected issue record number disagrees with the merged manifest's declared issue number.
    (evidence) => { evidence["relay-build"].issue.number = 888; },
  ];
  for (const mutate of cases) {
    const inputs = fixture();
    mutate(inputs.durableOutcomeEvidence);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_STALE_EVIDENCE");
    assert.match(result.message, /does not match/);
    assert.equal(result.final_summary.program_complete, false);
    assert.notEqual(result.final_summary.stopped_on, null);
  }
});

test("absent manifest head_sha is optional, but two present disagreeing SHAs stay stale", () => {
  // A valid merged manifest whose head_sha is null/absent (parseManifest nulls a missing
  // git.head_sha) is accepted, and a present-but-absent live head is not treated as stale.
  for (const mutate of [
    (record) => { record.manifest.head_sha = null; },
    (record) => { delete record.manifest.head_sha; },
    (record) => { delete record.pr.headRefOid; },
  ]) {
    const inputs = fixture();
    mutate(inputs.durableOutcomeEvidence["relay-build"]);
    assert.equal(PROOF.verifyClosedProgram(inputs).ok, true);
  }
  // Both SHAs present and disagreeing is still stale evidence.
  const stale = fixture();
  stale.durableOutcomeEvidence["relay-build"].pr.headRefOid = "moved-after-merge";
  const staleResult = PROOF.verifyClosedProgram(stale);
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.reasonCode, "PROOF_STALE_EVIDENCE");
});

test("stopped_on is the STOP_PRIORITY-most-severe token while blocking_reasons stay deterministically listed", () => {
  const inputs = fixture();
  // Two failures with distinct stop tokens: PROOF_STOPPED (relay_escalated, severe) and
  // PROOF_OUTCOME_INCOMPLETE (outcomes_incomplete, least severe). Alphabetically
  // PROOF_OUTCOME_INCOMPLETE sorts first, so a first-failure policy would pick the WEAK token.
  inputs.durableOutcomeEvidence["relay-build"].manifest.state = "closed";
  inputs.durableOutcomeEvidence[OUTCOME_ID] = {};
  const result = PROOF.verifyClosedProgram(inputs);
  assert.equal(result.ok, false);
  const codes = result.final_summary.blocking_reasons.map((entry) => entry.reason_code);
  assert.deepEqual(codes, ["PROOF_OUTCOME_INCOMPLETE", "PROOF_STOPPED"]);
  assert.deepEqual(codes, [...codes].sort());
  assert.equal(result.reasonCode, "PROOF_OUTCOME_INCOMPLETE");
  assert.equal(result.final_summary.stopped_on, "relay_escalated");
  assert.notEqual(result.final_summary.stopped_on, "outcomes_incomplete");
});

test("pure verifier has no filesystem, Orca, or GitHub mutation boundary", () => {
  const source = fs.readFileSync(path.join(SCRIPTS, "lib", "closed-program-proof.js"), "utf8");
  assert.doesNotMatch(source, /node:fs|node:child_process|execSync|spawn|writeFile|unlink|reset|task-create|gate-resolve/);
  const before = JSON.stringify(fixture());
  verify();
  assert.equal(JSON.stringify(fixture()), before);
});

test("the verifier does not change the frozen receipt or report shapes", () => {
  const inputs = fixture();
  const receiptBefore = JSON.stringify(inputs.receipt);
  const result = PROOF.verifyClosedProgram(inputs);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(inputs.receipt), receiptBefore);
  assert.deepEqual(Object.keys(result.final_summary).sort(), ["blocking_reasons", "lifecycle_diagnostics", "program_complete", "stopped_on"].sort());
});
