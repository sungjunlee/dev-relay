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

const FLEET_OUTCOME_ID = "fleet-leaf";
const FLEET_ID = "fleet-xyz";
const TRACKER_OUTCOME_ID = "tracker-recon";
const TRACKER_RUN_ID = "run-tracker";

function liveRow(outcomeId, orcaTaskId) {
  return { id: orcaTaskId, task_title: `relay-orca: ${programSegment(PROGRAM_ID)}/${outcomeId}`, status: "completed", worker_done: true };
}

// A relay_fleet outcome added alongside the base relay_run + integration_gate outcomes so
// the shared exit-gate/generic-evidence machinery stays satisfied while checkFleet runs.
function fleetFixture() {
  const inputs = fixture();
  inputs.acceptedProgram.outcomes.push({ id: FLEET_OUTCOME_ID, task_kind: "relay_fleet", accepted_outcomes: ["closed"] });
  inputs.receipt.tasks.push({
    ...receiptTask(FLEET_OUTCOME_ID, "relay_fleet", "orca-fleet"),
    relay_ids: { request: null, run: null, fleet: FLEET_ID },
  });
  inputs.orcaSnapshot.task_list.tasks.push(liveRow(FLEET_OUTCOME_ID, "orca-fleet"));
  inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID] = {
    fleet_manifest: {
      fleet_state: "closed",
      fleet_id: FLEET_ID,
      children: [
        { run_id: "child-run-1", leaf_ref: "leaf-1" },
        { run_id: "child-run-2", leaf_ref: "leaf-2" },
      ],
    },
    fleet_children: [
      { run_id: "child-run-1", leaf_ref: "leaf-1", state: "merged" },
      { run_id: "child-run-2", leaf_ref: "leaf-2", state: "merged" },
    ],
  };
  return inputs;
}

// A tracker_reconciliation outcome added the same way so checkDurableOutcome's tracker
// branch runs against a fully consistent program.
function trackerFixture() {
  const inputs = fixture();
  inputs.acceptedProgram.outcomes.push({ id: TRACKER_OUTCOME_ID, task_kind: "tracker_reconciliation", accepted_outcomes: ["closed"] });
  inputs.receipt.tasks.push({
    ...receiptTask(TRACKER_OUTCOME_ID, "tracker_reconciliation", "orca-tracker"),
    relay_ids: { request: null, run: TRACKER_RUN_ID, fleet: null },
  });
  inputs.orcaSnapshot.task_list.tasks.push(liveRow(TRACKER_OUTCOME_ID, "orca-tracker"));
  inputs.durableOutcomeEvidence[TRACKER_OUTCOME_ID] = {
    manifest: { state: "closed", run_id: TRACKER_RUN_ID, issue_number: 303 },
    issue: { state: "CLOSED", number: 303 },
  };
  return inputs;
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

// DC #1: the three Orca reads must supply INDEPENDENT, agreeing runtime ids. A compact snapshot
// shares one object, so its task/gate runtime ids must be explicit — never invented from the
// shared status object (which would make all three trivially agree).
test("a compact snapshot must supply explicit, agreeing task/gate runtime ids or fail closed", () => {
  const base = fixture().orcaSnapshot;
  const tasks = base.task_list.tasks;
  const gates = base.gate_list.gates;
  for (const compact of [
    { runtimeId: RUNTIME_ID, tasks, gates }, // no task/gate runtime override at all
    { runtimeId: RUNTIME_ID, taskRuntimeId: RUNTIME_ID, tasks, gates }, // gate override still missing
    { runtimeId: RUNTIME_ID, gateRuntimeId: RUNTIME_ID, tasks, gates }, // task override still missing
    { runtimeId: RUNTIME_ID, taskRuntimeId: "other-runtime", gateRuntimeId: RUNTIME_ID, tasks, gates }, // present but different
  ]) {
    const inputs = fixture();
    inputs.orcaSnapshot = compact;
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_CROSS_RUNTIME");
  }
  // All three explicit runtime ids present and equal → the compact shape passes.
  const ok = fixture();
  ok.orcaSnapshot = { runtimeId: RUNTIME_ID, taskRuntimeId: RUNTIME_ID, gateRuntimeId: RUNTIME_ID, tasks, gates };
  assert.equal(PROOF.verifyClosedProgram(ok).ok, true);
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

// #1021 class closure: whenever a receipt maps a run id, the manifest MUST carry the same
// run id — an absent manifest run id is a fail-closed mismatch, never a skip.
test("relay run identity: mapped run id requires a matching manifest run id; absent or mismatched manifest run id fails closed", () => {
  const cases = [
    // mapping present, manifest run id ABSENT (the R4 class-closure case) → fail closed.
    { mutate: (inputs) => { delete inputs.durableOutcomeEvidence["relay-build"].manifest.run_id; }, ok: false, match: /omits the run id/ },
    // mapping present, manifest run id MISMATCH → fail closed.
    { mutate: (inputs) => { inputs.durableOutcomeEvidence["relay-build"].manifest.run_id = "run-foreign"; }, ok: false, match: /does not match/ },
    // mapping present, manifest run id MATCH → accepted.
    { mutate: () => {}, ok: true },
    // mapping ABSENT (receipt declares no run id) → comparison skipped, existing behavior.
    {
      mutate: (inputs) => {
        inputs.receipt.tasks.find((task) => task.outcome_id === "relay-build").relay_ids.run = null;
        delete inputs.durableOutcomeEvidence["relay-build"].manifest.run_id;
      },
      ok: true,
    },
  ];
  for (const { mutate, ok, match } of cases) {
    const inputs = fixture();
    mutate(inputs);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, ok);
    if (!ok) {
      assert.equal(result.reasonCode, "PROOF_STALE_EVIDENCE");
      assert.match(result.message, match);
      assert.equal(result.final_summary.program_complete, false);
      assert.notEqual(result.final_summary.stopped_on, null);
    }
  }
});

test("fleet identity: mapped fleet id requires a matching manifest fleet id; absent or mismatched manifest fleet id fails closed", () => {
  assert.equal(PROOF.verifyClosedProgram(fleetFixture()).ok, true); // mapping present + match → accepted
  for (const { mutate, match } of [
    { mutate: (inputs) => { delete inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.fleet_id; }, match: /omits the fleet id/ },
    { mutate: (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.fleet_id = "fleet-foreign"; }, match: /does not match/ },
  ]) {
    const inputs = fleetFixture();
    mutate(inputs);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_STALE_EVIDENCE");
    assert.match(result.message, match);
  }
  // mapping ABSENT (receipt declares no fleet id) → comparison skipped even when manifest id absent.
  const skip = fleetFixture();
  skip.receipt.tasks.find((task) => task.outcome_id === FLEET_OUTCOME_ID).relay_ids.fleet = null;
  delete skip.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.fleet_id;
  assert.equal(PROOF.verifyClosedProgram(skip).ok, true);
});

test("fleet children must equal the manifest's declared roster exactly before any child state is trusted", () => {
  for (const mutate of [
    // subset: supplied drops a declared child.
    (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children = [{ run_id: "child-run-1", leaf_ref: "leaf-1", state: "merged" }]; },
    // superset: supplied adds a child the manifest never declared.
    (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children.push({ run_id: "child-run-3", leaf_ref: "leaf-3", state: "merged" }); },
    // renamed: supplied forges one declared child's run id.
    (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children[1].run_id = "child-run-forged"; },
    // identity-less: a supplied child omits both ids the manifest declares.
    (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children[1] = { state: "merged" }; },
    // duplicated: supplied repeats one child so it no longer matches the declared roster.
    (inputs) => { inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children[1] = { run_id: "child-run-1", leaf_ref: "leaf-1", state: "merged" }; },
  ]) {
    const inputs = fleetFixture();
    mutate(inputs);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_STALE_EVIDENCE");
    assert.match(result.message, /does not match the fleet manifest's declared children/);
  }
  // Identity is checked BEFORE child state: an exactly-matching roster with a failed child
  // still surfaces the child-state stop, proving the identity gate did not mask it.
  const failedChild = fleetFixture();
  failedChild.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_children[1].state = "failed";
  assert.equal(PROOF.verifyClosedProgram(failedChild).reasonCode, "PROOF_STOPPED");
  // Binding is OMITTED when the manifest declares no child identities (authoritative-has-no-id).
  const noDeclaredIds = fleetFixture();
  noDeclaredIds.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.children = [{ state: "merged" }, { state: "merged" }];
  assert.equal(PROOF.verifyClosedProgram(noDeclaredIds).ok, true);
});

// DC #1: `fleet_state` is the ONLY fleet closed authority; a live/derived `manifest.state` is
// never sufficient and must not substitute for it.
test("fleet_state is the only closed authority — a terminal manifest.state cannot substitute", () => {
  for (const mutate of [
    // fleet_state non-terminal while a derived state claims closed.
    (m) => { m.fleet_state = "review_pending"; m.state = "closed"; },
    // fleet_state absent entirely while a derived state claims merged.
    (m) => { delete m.fleet_state; m.state = "merged"; },
  ]) {
    const inputs = fleetFixture();
    mutate(inputs.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_OUTCOME_INCOMPLETE");
    assert.match(result.message, /is not terminal/);
  }
});

// DC #3: once ANY declared child carries identity, EVERY declared child must — a partially
// identified roster is malformed authority and fails closed, while a fully identity-less roster
// keeps the existing authoritative-has-no-id skip.
test("a partially identified declared fleet roster fails closed; a fully identity-less roster keeps existing behavior", () => {
  const mixed = fleetFixture();
  mixed.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.children = [
    { run_id: "child-run-1", leaf_ref: "leaf-1" },
    { state: "merged" },
  ];
  const mixedResult = PROOF.verifyClosedProgram(mixed);
  assert.equal(mixedResult.ok, false);
  assert.equal(mixedResult.reasonCode, "PROOF_STALE_EVIDENCE");
  assert.match(mixedResult.message, /only partially identified/);
  // Fully identity-less declared roster: binding omitted, existing behavior preserved.
  const none = fleetFixture();
  none.durableOutcomeEvidence[FLEET_OUTCOME_ID].fleet_manifest.children = [{ state: "merged" }, { state: "merged" }];
  assert.equal(PROOF.verifyClosedProgram(none).ok, true);
});

test("tracker reconciliation binds the receipt-mapped run and the declared issue number", () => {
  assert.equal(PROOF.verifyClosedProgram(trackerFixture()).ok, true); // both mappings present + match → accepted
  for (const { mutate, match } of [
    // receipt-mapped run present, manifest run id ABSENT → fail closed.
    { mutate: (inputs) => { delete inputs.durableOutcomeEvidence[TRACKER_OUTCOME_ID].manifest.run_id; }, match: /omits the run id/ },
    // receipt-mapped run present, manifest run id MISMATCH → fail closed.
    { mutate: (inputs) => { inputs.durableOutcomeEvidence[TRACKER_OUTCOME_ID].manifest.run_id = "run-foreign"; }, match: /does not match/ },
    // declared issue number present, injected issue number ABSENT → fail closed.
    { mutate: (inputs) => { delete inputs.durableOutcomeEvidence[TRACKER_OUTCOME_ID].issue.number; }, match: /does not match/ },
    // declared issue number present, injected issue number MISMATCH → fail closed.
    { mutate: (inputs) => { inputs.durableOutcomeEvidence[TRACKER_OUTCOME_ID].issue.number = 999; }, match: /does not match/ },
  ]) {
    const inputs = trackerFixture();
    mutate(inputs);
    const result = PROOF.verifyClosedProgram(inputs);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "PROOF_STALE_EVIDENCE");
    assert.match(result.message, match);
  }
  // Both mappings ABSENT → comparisons skipped (existing behavior preserved).
  const skip = trackerFixture();
  skip.receipt.tasks.find((task) => task.outcome_id === TRACKER_OUTCOME_ID).relay_ids.run = null;
  delete skip.durableOutcomeEvidence[TRACKER_OUTCOME_ID].manifest.run_id;
  skip.durableOutcomeEvidence[TRACKER_OUTCOME_ID].manifest.issue_number = null;
  skip.durableOutcomeEvidence[TRACKER_OUTCOME_ID].issue.number = 999;
  assert.equal(PROOF.verifyClosedProgram(skip).ok, true);
});
