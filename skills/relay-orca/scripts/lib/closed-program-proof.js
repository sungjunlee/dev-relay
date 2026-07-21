"use strict";

// Pure leaf-1 closure proof (#1021). This module accepts already-parsed structured
// facts. It never reads a receipt, invokes Orca/GitHub, interprets diagnostic prose,
// or treats a receipt stop record/live terminal bit/caller summary as completion
// authority. The later admission leaf may use this proof while classifying unrelated
// live rows globally.
const { validateReceipt } = require("./receipt");
const { SUPPORTED_KINDS } = require("./task-kinds");
const { parseGate } = require("./gate-kinds");
const {
  canonicalIntegrationQuestion,
  canonicalGateKey,
  gateId,
  gateResolution,
  inspectCanonicalGates,
} = require("./integration-lifecycle");
const {
  ARTIFACT_KEYS,
  validateArtifact,
  validateDeclaration,
  INTEGRATION_EVIDENCE_VERSION,
} = require("./integration-evidence");
const { isTerminalManifestState } = require("./manifest-parse");
const { taskDisplayString } = require("./status-derive");
const { programSegment: defaultProgramSegment } = require("./program-segment");
const { pickStoppedOn } = require("./final-summary");

const PROOF_REASON_CODES = Object.freeze([
  "PROOF_MALFORMED_INPUT",
  "PROOF_DUPLICATE_CONFLICT",
  "PROOF_CROSS_PROGRAM",
  "PROOF_CROSS_RUNTIME",
  "PROOF_STALE_EVIDENCE",
  "PROOF_STOPPED",
  "PROOF_INCOMPLETE",
  "PROOF_OUTCOME_MISSING",
  "PROOF_OUTCOME_FAILED",
  "PROOF_OUTCOME_INCOMPLETE",
  "PROOF_EVIDENCE_MISSING",
  "PROOF_EVIDENCE_MALFORMED",
  "PROOF_EVIDENCE_FAILED",
  "PROOF_TASK_MISSING",
  "PROOF_TASK_DUPLICATE",
  "PROOF_TASK_FOREIGN",
  "PROOF_TASK_ACTIVE",
  "PROOF_TASK_FAILED",
  "PROOF_TASK_MARKER_MISMATCH",
  "PROOF_GATE_MISSING",
  "PROOF_GATE_DUPLICATE",
  "PROOF_GATE_NONCANONICAL",
  "PROOF_GATE_CONFLICT",
  "PROOF_GATE_PENDING",
  "PROOF_GATE_FAILED",
  "PROOF_GATE_MALFORMED",
  "PROOF_GATE_UNEVALUABLE",
]);

const REASON_SET = new Set(PROOF_REASON_CODES);
const STOPPED_CODES = new Set(["PROOF_STOPPED", "PROOF_TASK_FAILED", "PROOF_GATE_FAILED", "PROOF_EVIDENCE_FAILED"]);
const LIFECYCLE_CODES = new Set([
  "PROOF_CROSS_PROGRAM",
  "PROOF_CROSS_RUNTIME",
  "PROOF_STALE_EVIDENCE",
  "PROOF_STOPPED",
  "PROOF_TASK_MISSING",
  "PROOF_TASK_DUPLICATE",
  "PROOF_TASK_FOREIGN",
  "PROOF_TASK_ACTIVE",
  "PROOF_TASK_FAILED",
  "PROOF_TASK_MARKER_MISMATCH",
  "PROOF_OUTCOME_MISSING",
  "PROOF_OUTCOME_FAILED",
  "PROOF_OUTCOME_INCOMPLETE",
  "PROOF_GATE_MISSING",
  "PROOF_GATE_DUPLICATE",
  "PROOF_GATE_NONCANONICAL",
  "PROOF_GATE_CONFLICT",
  "PROOF_GATE_PENDING",
  "PROOF_GATE_FAILED",
  "PROOF_GATE_MALFORMED",
]);

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sortedStrings(values) {
  return [...new Set(values.filter(nonEmpty))].sort((left, right) => left.localeCompare(right));
}

function reason(code, message, details = {}) {
  return { code: REASON_SET.has(code) ? code : "PROOF_MALFORMED_INPUT", message, ...details };
}

function stoppedOn(code) {
  if (code === "PROOF_CROSS_RUNTIME" || code === "PROOF_CROSS_PROGRAM" || code === "PROOF_STALE_EVIDENCE") return "orca_lifecycle_failure";
  if (STOPPED_CODES.has(code)) return code === "PROOF_GATE_FAILED" || code === "PROOF_EVIDENCE_FAILED" ? "integration_gate_failed" : "relay_escalated";
  if (code.startsWith("PROOF_GATE_")) return "gate_unevaluable";
  if (code.startsWith("PROOF_TASK_") || code.startsWith("PROOF_OUTCOME_")) return "outcomes_incomplete";
  return "graph_ambiguous";
}

function emptySummary(ok, failures) {
  const blocking = failures.map((failure) => ({ reason_code: failure.code, message: failure.message }));
  const lifecycle = failures.filter((failure) => LIFECYCLE_CODES.has(failure.code)).map((failure) => ({
    code: failure.code,
    message: failure.message,
  }));
  // `blocking_reasons` stays the deterministic sorted listing produced by result(); the
  // single `stopped_on` token is the MOST SEVERE stop present, not the alphabetically-first
  // failure. Map every failure code to its stop token and defer the severity ordering to
  // lib/final-summary.js STOP_PRIORITY via pickStoppedOn (no forked severity policy). Every
  // stoppedOn() token is a STOP_PRIORITY member, so a non-empty failure set always resolves.
  const stopTokens = new Set(failures.map((failure) => stoppedOn(failure.code)));
  if (stopTokens.size === 0) stopTokens.add(stoppedOn("PROOF_MALFORMED_INPUT"));
  return {
    program_complete: ok,
    stopped_on: ok ? null : pickStoppedOn(stopTokens),
    blocking_reasons: blocking,
    lifecycle_diagnostics: lifecycle,
  };
}

function result({ ok, programId = null, runtimeId = null, outcomeIds = [], taskIds = [], gateIds = [], failures = [] }) {
  const orderedFailures = failures.slice().sort((left, right) => {
    const code = left.code.localeCompare(right.code);
    return code || left.message.localeCompare(right.message);
  });
  const first = orderedFailures[0] || null;
  return {
    ok,
    reasonCode: first ? first.code : null,
    message: first ? first.message : "closed program proof passed",
    program_id: programId,
    runtime_id: runtimeId,
    outcome_ids: sortedStrings(outcomeIds),
    orca_task_ids: sortedStrings(taskIds),
    integration_gate_ids: sortedStrings(gateIds),
    final_summary: emptySummary(ok, orderedFailures),
  };
}

function unwrapProgram(input) {
  const candidate = isObject(input) && isObject(input.program) ? input.program : input;
  if (!isObject(candidate)) return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program is not a structured object") };
  const programId = nonEmpty(candidate.id) ? candidate.id : candidate.program_id;
  if (!nonEmpty(programId)) return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program id is missing") };
  const rawOutcomes = Array.isArray(candidate.outcomes)
    ? candidate.outcomes
    : Array.isArray(candidate.tasks)
      ? candidate.tasks.map((task) => ({ ...task, id: task && task.id !== undefined ? task.id : task && task.outcome_id, task_kind: task && (task.task_kind || task.kind) }))
      : null;
  if (!Array.isArray(rawOutcomes)) return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program outcomes are missing") };
  const outcomes = [];
  const byId = new Map();
  for (const raw of rawOutcomes) {
    const id = raw && raw.id;
    const kind = raw && (raw.task_kind || raw.kind);
    if (!isObject(raw) || !nonEmpty(id) || !nonEmpty(kind) || !SUPPORTED_KINDS.includes(kind)) {
      return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program contains a malformed or unsupported outcome") };
    }
    if (byId.has(id)) return { failure: reason("PROOF_DUPLICATE_CONFLICT", `accepted program outcome ${id} is duplicated`) };
    const outcome = { ...raw, id, task_kind: kind };
    outcomes.push(outcome);
    byId.set(id, outcome);
  }
  if (outcomes.length === 0) return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program has no outcomes") };
  const exitGates = candidate.exit_gates === undefined ? [] : candidate.exit_gates;
  if (!Array.isArray(exitGates) || exitGates.length === 0 || exitGates.some((gate) => typeof gate !== "string" || gate.trim() === "")) {
    return { failure: reason("PROOF_MALFORMED_INPUT", "accepted program exit_gates is malformed") };
  }
  return { program: candidate, programId, outcomes: outcomes.sort((left, right) => left.id.localeCompare(right.id)), byId, exitGates };
}

function normalizeSnapshot(input) {
  if (!isObject(input)) return { failure: reason("PROOF_CROSS_RUNTIME", "injected Orca snapshot is missing") };
  const status = isObject(input.status) ? input.status : input;
  const taskList = isObject(input.task_list) ? input.task_list : isObject(input.taskList) ? input.taskList : input;
  const gateList = isObject(input.gate_list) ? input.gate_list : isObject(input.gateList) ? input.gateList : input;
  const runtimeFrom = (value) => {
    if (!isObject(value)) return null;
    const resultValue = isObject(value.result) ? value.result : {};
    const meta = isObject(value._meta) ? value._meta : {};
    const runtime = isObject(resultValue.runtime) ? resultValue.runtime : {};
    return [value.runtime_id, value.runtimeId, resultValue.runtime_id, resultValue.runtimeId, runtime.runtime_id, runtime.runtimeId, meta.runtime_id, meta.runtimeId]
      .find(nonEmpty) || null;
  };
  const runtimeId = runtimeFrom(status);
  const taskRuntimeId = [input.taskRuntimeId, input.task_runtime_id, runtimeFrom(taskList)].find(nonEmpty) || null;
  const gateRuntimeId = [input.gateRuntimeId, input.gate_runtime_id, runtimeFrom(gateList)].find(nonEmpty) || null;
  if (!runtimeId || !taskRuntimeId || !gateRuntimeId || runtimeId !== taskRuntimeId || runtimeId !== gateRuntimeId) {
    return { failure: reason("PROOF_CROSS_RUNTIME", "status, task-list, and gate-list runtime ids must be present, non-empty, and identical") };
  }
  const taskResult = isObject(taskList.result) ? taskList.result : {};
  const gateResult = isObject(gateList.result) ? gateList.result : {};
  const tasks = Array.isArray(taskList.tasks) ? taskList.tasks : Array.isArray(taskResult.tasks) ? taskResult.tasks : null;
  const gates = Array.isArray(gateList.gates) ? gateList.gates : Array.isArray(gateResult.gates) ? gateResult.gates : null;
  if (!tasks || !gates) return { failure: reason("PROOF_MALFORMED_INPUT", "Orca task-list and gate-list rows are missing or malformed") };
  return { runtimeId, tasks: tasks.slice(), gates: gates.slice() };
}

function normalizeReceipt(receipt, programId, runtimeId) {
  const structuralError = validateReceipt(receipt);
  if (structuralError) return { failure: reason("PROOF_MALFORMED_INPUT", `canonical receipt is invalid: ${structuralError}`) };
  if (receipt.program_id !== programId) return { failure: reason("PROOF_CROSS_PROGRAM", "receipt program_id does not match the accepted program") };
  if (!nonEmpty(receipt.runtime_id) || receipt.runtime_id !== runtimeId) return { failure: reason("PROOF_CROSS_RUNTIME", "receipt runtime_id does not match the attributable Orca runtime") };
  const byOutcome = new Map();
  const byTask = new Map();
  const byRelayTask = new Map();
  for (const entry of receipt.tasks) {
    if (!isObject(entry) || !nonEmpty(entry.outcome_id) || !nonEmpty(entry.kind) || !nonEmpty(entry.task_id) || !nonEmpty(entry.orca_task_id)) {
      return { failure: reason("PROOF_MALFORMED_INPUT", "receipt contains a malformed outcome/task mapping") };
    }
    if (byOutcome.has(entry.outcome_id) || byTask.has(entry.orca_task_id) || byRelayTask.has(entry.task_id)) {
      return { failure: reason("PROOF_DUPLICATE_CONFLICT", "receipt outcome and Orca task mappings must be unique") };
    }
    byOutcome.set(entry.outcome_id, entry);
    byTask.set(entry.orca_task_id, entry);
    byRelayTask.set(entry.task_id, entry);
  }
  return { receipt, byOutcome, byTask };
}

function normalizeRecords(input, label) {
  const records = [];
  if (input instanceof Map) {
    for (const [key, value] of input.entries()) records.push({ key, value });
  } else if (Array.isArray(input)) {
    for (const record of input) records.push({ key: record && record.outcome_id, value: record });
  } else if (isObject(input)) {
    const source = isObject(input.outcomes) ? input.outcomes : input;
    if (Array.isArray(source)) return normalizeRecords(source, label);
    for (const [key, value] of Object.entries(source)) records.push({ key, value });
  } else {
    return { failure: reason("PROOF_MALFORMED_INPUT", `${label} is missing or malformed`) };
  }
  const byId = new Map();
  for (const entry of records) {
    if (!nonEmpty(entry.key) || !isObject(entry.value)) return { failure: reason("PROOF_MALFORMED_INPUT", `${label} has a malformed outcome record`) };
    if (entry.value.outcome_id !== undefined && entry.value.outcome_id !== entry.key) {
      return { failure: reason("PROOF_CROSS_PROGRAM", `${label} outcome record key and outcome_id disagree`) };
    }
    if (byId.has(entry.key)) return { failure: reason("PROOF_DUPLICATE_CONFLICT", `${label} contains duplicate outcome ${entry.key}`) };
    byId.set(entry.key, { ...entry.value, outcome_id: entry.key });
  }
  return { byId };
}

function normalizeEvidenceArtifacts(input) {
  const entries = [];
  if (input instanceof Map) {
    for (const [key, value] of input.entries()) entries.push({ key, value });
  } else if (Array.isArray(input)) {
    for (const value of input) entries.push({ key: value && value.check_ref, value });
  } else if (isObject(input)) {
    const source = isObject(input.artifacts) ? input.artifacts : input;
    for (const [key, value] of Object.entries(source)) entries.push({ key, value });
  } else if (input === undefined || input === null) {
    return { byRef: new Map() };
  } else {
    return { failure: reason("PROOF_EVIDENCE_MALFORMED", "trusted generic integration evidence is malformed") };
  }
  const byRef = new Map();
  for (const entry of entries) {
    if (!nonEmpty(entry.key)) return { failure: reason("PROOF_EVIDENCE_MALFORMED", "generic integration evidence has no raw check ref") };
    if (byRef.has(entry.key)) return { failure: reason("PROOF_DUPLICATE_CONFLICT", `generic integration evidence duplicates raw check ref ${entry.key}`) };
    const source = entry.value;
    if (source && source.present === false) continue;
    const artifact = isObject(source) && source.artifact !== undefined ? source.artifact : source && source.value !== undefined ? source.value : source;
    if (!isObject(artifact)) return { failure: reason("PROOF_EVIDENCE_MALFORMED", `generic integration evidence for ${entry.key} is not an artifact`) };
    if (artifact.check_ref !== undefined && artifact.check_ref !== entry.key) return { failure: reason("PROOF_CROSS_PROGRAM", `generic integration evidence raw check ref ${entry.key} disagrees with its artifact`) };
    byRef.set(entry.key, artifact);
  }
  return { byRef };
}

function classifyDeclarationFailure(declaration, programId, runtimeId) {
  if (!isObject(declaration)) return "PROOF_EVIDENCE_MALFORMED";
  if (declaration.program_id !== programId) return "PROOF_CROSS_PROGRAM";
  if (declaration.runtime_id !== runtimeId) return "PROOF_CROSS_RUNTIME";
  return "PROOF_EVIDENCE_MALFORMED";
}

function classifyArtifactFailure(artifact, programId, runtimeId, declaration) {
  if (!isObject(artifact)) return "PROOF_EVIDENCE_MALFORMED";
  if (artifact.schema !== INTEGRATION_EVIDENCE_VERSION || Object.keys(artifact).some((key) => !ARTIFACT_KEYS.includes(key)) || !artifact.verification) return "PROOF_EVIDENCE_MALFORMED";
  if (artifact.program_id !== programId || (declaration && declaration.program_id !== programId)) return "PROOF_CROSS_PROGRAM";
  if (artifact.runtime_id !== runtimeId || (declaration && declaration.runtime_id !== runtimeId)) return "PROOF_CROSS_RUNTIME";
  if (declaration && artifact.verification) return "PROOF_STALE_EVIDENCE";
  return "PROOF_EVIDENCE_MALFORMED";
}

function verifyGenericGates({ program, programId, runtimeId, exitGates, trustedEvidence }) {
  const refs = [];
  const seen = new Set();
  for (const gate of exitGates) {
    const parsed = parseGate(gate);
    if (parsed.kind === "unevaluable") return { failures: [reason("PROOF_GATE_UNEVALUABLE", `exit gate ${gate} has no recognized structured kind`)] };
    if (parsed.kind !== "integration") return { failures: [reason("PROOF_GATE_UNEVALUABLE", `exit gate ${gate} requires a structured proof contract not supplied to leaf 1`)] };
    if (seen.has(parsed.ref)) return { failures: [reason("PROOF_DUPLICATE_CONFLICT", `integration exit gate ${parsed.ref} is duplicated`)] };
    seen.add(parsed.ref);
    refs.push(parsed.ref);
  }
  const declarations = program.integration_evidence;
  const byDeclaration = new Map();
  if (refs.length > 0 && program.integration_evidence_version !== INTEGRATION_EVIDENCE_VERSION) {
    return { failures: [reason("PROOF_EVIDENCE_MALFORMED", `generic integration evidence version ${INTEGRATION_EVIDENCE_VERSION} is required`)] };
  }
  if (refs.length > 0 && !Array.isArray(declarations)) return { failures: [reason("PROOF_EVIDENCE_MISSING", "accepted program has no generic integration identity declarations")] };
  for (const declaration of Array.isArray(declarations) ? declarations : []) {
    if (!isObject(declaration) || !nonEmpty(declaration.check_ref)) return { failures: [reason("PROOF_EVIDENCE_MALFORMED", "generic integration identity declaration is malformed")] };
    if (byDeclaration.has(declaration.check_ref)) return { failures: [reason("PROOF_DUPLICATE_CONFLICT", `generic integration identity declaration ${declaration.check_ref} is duplicated`)] };
    byDeclaration.set(declaration.check_ref, declaration);
  }
  const artifacts = normalizeEvidenceArtifacts(trustedEvidence);
  if (!artifacts.byRef) return { failures: [artifacts.failure] };
  const failures = [];
  for (const ref of refs.sort((left, right) => left.localeCompare(right))) {
    const declaration = byDeclaration.get(ref);
    if (!declaration) {
      failures.push(reason("PROOF_EVIDENCE_MISSING", `generic integration identity declaration for ${ref} is missing`));
      continue;
    }
    const declarationCheck = validateDeclaration(declaration, { programId, runtimeId, checkRef: ref });
    if (!declarationCheck.valid) {
      failures.push(reason(classifyDeclarationFailure(declaration, programId, runtimeId), `generic integration identity for ${ref} is invalid`));
      continue;
    }
    const artifact = artifacts.byRef.get(ref);
    if (!artifact) {
      failures.push(reason("PROOF_EVIDENCE_MISSING", `generic integration evidence artifact for ${ref} is missing`));
      continue;
    }
    const artifactCheck = validateArtifact(artifact, { declaration, programId, runtimeId, checkRef: ref });
    if (!artifactCheck.valid) {
      const code = classifyArtifactFailure(artifact, programId, runtimeId, declaration);
      failures.push(reason(code, `generic integration evidence for ${ref} failed its #1046 identity contract`));
    } else if (artifactCheck.passed !== true) {
      failures.push(reason("PROOF_EVIDENCE_FAILED", `generic integration check ${ref} did not pass`));
    }
  }
  for (const ref of artifacts.byRef.keys()) {
    if (!seen.has(ref)) failures.push(reason("PROOF_CROSS_PROGRAM", `generic integration evidence ${ref} is not an accepted exit gate`));
  }
  for (const ref of byDeclaration.keys()) {
    if (!seen.has(ref)) failures.push(reason("PROOF_CROSS_PROGRAM", `generic integration identity ${ref} is not an accepted exit gate`));
  }
  return { failures };
}

function checkIdentity(record, programId, runtimeId) {
  if (record.program_id !== undefined && record.program_id !== programId) return reason("PROOF_CROSS_PROGRAM", `durable outcome ${record.outcome_id} belongs to another program`);
  if (record.runtime_id !== undefined && record.runtime_id !== runtimeId) return reason("PROOF_CROSS_RUNTIME", `durable outcome ${record.outcome_id} belongs to another runtime`);
  return null;
}

// Pull the receipt-mapped relay/fleet id for this outcome. Null ONLY when the receipt
// (the authoritative mapping) declares no such id — in that case the comparison is
// omitted. A non-null return is REQUIRED on the evidence side (see bindMappedId).
function receiptRelayId(receiptTask, field) {
  const ids = isObject(receiptTask) && isObject(receiptTask.relay_ids) ? receiptTask.relay_ids : null;
  return ids && nonEmpty(ids[field]) ? ids[field] : null;
}

function numberLabel(value) {
  return typeof value === "number" ? `#${value}` : "with no number";
}

// #1021 uniform identity-binding rule (class closure). Whenever an authoritative mapping
// declares an id, the durable evidence MUST carry the same id, non-empty and equal. An
// evidence side that omits a declared id fails CLOSED — it is never skipped. The
// comparison is omitted ONLY when the authoritative side itself declares no such id.
//
// bindMappedId binds a receipt-mapped relay/fleet id (authoritative) to a manifest id.
function bindMappedId(mapped, actual, label, noun) {
  if (!nonEmpty(mapped)) return null;
  if (!nonEmpty(actual)) return reason("PROOF_STALE_EVIDENCE", `${label} manifest omits the ${noun} id required by the receipt-mapped ${noun} ${mapped}`);
  if (actual !== mapped) return reason("PROOF_STALE_EVIDENCE", `${label} manifest ${noun} ${actual} does not match the receipt-mapped ${noun} ${mapped}`);
  return null;
}

// bindDeclaredNumber binds a manifest-declared PR/issue number (authoritative) to an
// injected GitHub record number. An absent record number fails closed (undefined never
// equals a declared number).
function bindDeclaredNumber(declared, actual, label, noun) {
  if (declared == null) return null;
  if (actual !== declared) return reason("PROOF_STALE_EVIDENCE", `${label} ${noun} ${numberLabel(actual)} does not match its declared manifest ${noun} #${declared}`);
  return null;
}

// A fleet child's durable identity is its { run_id, leaf_ref } pair (#945 D4). Null when
// the child declares neither id, so a manifest whose children carry no identities cannot
// bind (the authoritative-has-no-id branch of the uniform rule).
function fleetChildKey(child) {
  if (!isObject(child)) return null;
  const runId = [child.run_id, child.runId].find(nonEmpty) || "";
  const leafRef = [child.leaf_ref, child.leafRef].find(nonEmpty) || "";
  if (runId === "" && leafRef === "") return null;
  return `${runId} ${leafRef}`;
}

// Sorted multiset of child identity keys (duplicates preserved so counts must match), or
// null when any child in the set declares no identity.
function fleetChildIdentities(children) {
  const keys = [];
  for (const child of children) {
    const key = fleetChildKey(child);
    if (key === null) return null;
    keys.push(key);
  }
  return keys.sort((left, right) => left.localeCompare(right));
}

function childIdentitiesEqual(declared, supplied) {
  return supplied !== null && declared.length === supplied.length && declared.every((key, index) => key === supplied[index]);
}

function checkRelayRun(record, receiptTask) {
  const manifest = record.manifest || record.relay_manifest;
  if (!isObject(manifest)) return reason("PROOF_OUTCOME_INCOMPLETE", `relay outcome ${record.outcome_id} has no durable relay manifest`);
  if (manifest.state === "closed" || manifest.state === "escalated" || manifest.state === "failed") return reason("PROOF_STOPPED", `relay outcome ${record.outcome_id} is ${manifest.state}`);
  if (manifest.state !== "merged") return reason("PROOF_OUTCOME_INCOMPLETE", `relay outcome ${record.outcome_id} is not durably merged`);
  // Bind durable evidence to the receipt mapping identity: a merged shape alone is not
  // authority. When the receipt maps a run id, the manifest MUST carry the same run id —
  // an omitted manifest run id fails closed, never skips (see bindMappedId).
  const runFailure = bindMappedId(receiptRelayId(receiptTask, "run"), manifest.run_id, `relay outcome ${record.outcome_id}`, "run");
  if (runFailure) return runFailure;
  const pr = record.pr || (isObject(record.github) && record.github.pr);
  const issue = record.issue || (isObject(record.github) && record.github.issue);
  if (!isObject(pr) || !isObject(issue)) return reason("PROOF_STALE_EVIDENCE", `relay outcome ${record.outcome_id} is missing GitHub evidence`);
  if (!((pr.state === "MERGED") || nonEmpty(pr.mergedAt))) return reason("PROOF_OUTCOME_FAILED", `relay outcome ${record.outcome_id} does not have a merged PR`);
  // Absent manifest head_sha is optional, not stale (parseManifest nulls a missing
  // git.head_sha). Flag stale only when BOTH SHAs are present non-empty strings and
  // disagree — mirrors the status-classify PR_CHANGED head comparison.
  if (nonEmpty(manifest.head_sha) && nonEmpty(pr.headRefOid) && manifest.head_sha !== pr.headRefOid) return reason("PROOF_STALE_EVIDENCE", `relay outcome ${record.outcome_id} PR head differs from its merged manifest`);
  // The manifest's declared PR/issue numbers must match the injected GitHub records before
  // the outcome counts as complete_with_evidence — else foreign merged/closed records pass.
  const prNumberFailure = bindDeclaredNumber(manifest.pr_number, pr.number, `relay outcome ${record.outcome_id}`, "PR");
  if (prNumberFailure) return prNumberFailure;
  if (issue.state !== "CLOSED") return reason("PROOF_OUTCOME_FAILED", `relay outcome ${record.outcome_id} issue is not closed`);
  const issueNumberFailure = bindDeclaredNumber(manifest.issue_number, issue.number, `relay outcome ${record.outcome_id}`, "issue");
  if (issueNumberFailure) return issueNumberFailure;
  return null;
}

function checkFleet(record, receiptTask) {
  const manifest = record.fleet_manifest || record.fleetManifest;
  if (!isObject(manifest)) return reason("PROOF_OUTCOME_INCOMPLETE", `fleet outcome ${record.outcome_id} has no durable fleet manifest`);
  if (manifest.fleet_state === "escalated" || manifest.state === "escalated") return reason("PROOF_STOPPED", `fleet outcome ${record.outcome_id} is escalated`);
  if (!(isTerminalManifestState(manifest.fleet_state) || isTerminalManifestState(manifest.state))) return reason("PROOF_OUTCOME_INCOMPLETE", `fleet outcome ${record.outcome_id} is not terminal`);
  // Same uniform binding as relay runs: when the receipt maps a fleet id, the manifest MUST
  // carry the same fleet id — an omitted manifest fleet id fails closed, never skips.
  const fleetFailure = bindMappedId(receiptRelayId(receiptTask, "fleet"), manifest.fleet_id, `fleet outcome ${record.outcome_id}`, "fleet");
  if (fleetFailure) return fleetFailure;
  // The fleet manifest's declared children (#945 D4 `children:` frontmatter → { leaf_ref,
  // run_id }) are the AUTHORITATIVE roster. When the record supplies its own child
  // evidence, its child identities must equal the declared roster exactly — same
  // { run_id, leaf_ref } set and same count — before any child state is trusted. A subset,
  // superset, renamed, or identity-less child fails closed rather than passing on a forged
  // roster. The binding is omitted only when the manifest declares no child identities.
  const declaredChildren = Array.isArray(manifest.children) ? manifest.children : Array.isArray(manifest.fleet_children) ? manifest.fleet_children : null;
  const suppliedChildren = Array.isArray(record.fleet_children) ? record.fleet_children : Array.isArray(record.fleetChildren) ? record.fleetChildren : null;
  if (suppliedChildren && declaredChildren) {
    const declaredKeys = fleetChildIdentities(declaredChildren);
    if (declaredKeys && !childIdentitiesEqual(declaredKeys, fleetChildIdentities(suppliedChildren))) {
      return reason("PROOF_STALE_EVIDENCE", `fleet outcome ${record.outcome_id} child evidence does not match the fleet manifest's declared children`);
    }
  }
  const children = suppliedChildren || declaredChildren;
  if (!children || children.length === 0) return reason("PROOF_OUTCOME_INCOMPLETE", `fleet outcome ${record.outcome_id} has no child evidence`);
  for (const child of children) {
    const state = child && (child.state || (isObject(child.manifest) && child.manifest.state));
    if (state === "escalated" || state === "failed") return reason("PROOF_STOPPED", `fleet outcome ${record.outcome_id} has a failed child`);
    if (!isTerminalManifestState(state)) return reason("PROOF_OUTCOME_INCOMPLETE", `fleet outcome ${record.outcome_id} has an incomplete child`);
  }
  return null;
}

function checkDurableOutcome(record, kind, programId, runtimeId, receiptTask) {
  const identityFailure = checkIdentity(record, programId, runtimeId);
  if (identityFailure) return identityFailure;
  if (kind === "relay_run") return checkRelayRun(record, receiptTask);
  if (kind === "relay_fleet") return checkFleet(record, receiptTask);
  if (kind === "advisory_review") {
    const advisory = record.advisory || record;
    return advisory.evidence_posted === true && advisory.blocking_findings_triaged === true
      ? null
      : reason("PROOF_OUTCOME_INCOMPLETE", `advisory outcome ${record.outcome_id} lacks posted and triaged evidence`);
  }
  if (kind === "tracker_reconciliation") {
    const manifest = record.manifest || record.relay_manifest;
    const issue = record.issue || (isObject(record.github) && record.github.issue);
    if (!manifest || !isTerminalManifestState(manifest.state) || !issue || issue.state !== "CLOSED") return reason("PROOF_OUTCOME_INCOMPLETE", `tracker outcome ${record.outcome_id} is not durably reconciled`);
    // Uniform identity binding on the reconciled evidence: the receipt-mapped run and the
    // manifest's declared issue number, when present, must equal the injected records so a
    // foreign closed issue or manifest cannot satisfy the tracker outcome.
    const runFailure = bindMappedId(receiptRelayId(receiptTask, "run"), manifest.run_id, `tracker outcome ${record.outcome_id}`, "run");
    if (runFailure) return runFailure;
    const issueFailure = bindDeclaredNumber(manifest.issue_number, issue.number, `tracker outcome ${record.outcome_id}`, "issue");
    if (issueFailure) return issueFailure;
    return null;
  }
  if (kind === "integration_gate") {
    return record.integration || record.gate_report ? null : reason("PROOF_OUTCOME_INCOMPLETE", `integration outcome ${record.outcome_id} has no structured lifecycle evidence`);
  }
  return reason("PROOF_MALFORMED_INPUT", `outcome ${record.outcome_id} has an unsupported kind`);
}

function liveTaskId(task) {
  return isObject(task) && nonEmpty(task.id) ? task.id : null;
}

function verifyLiveTasks({ tasks, receiptTasks, programId, segment }) {
  const taskIds = [];
  const failures = [];
  const rowsById = new Map();
  for (const row of tasks) {
    const id = liveTaskId(row);
    if (id) {
      const rows = rowsById.get(id) || [];
      rows.push(row);
      rowsById.set(id, rows);
    }
  }
  for (const entry of receiptTasks.slice().sort((left, right) => left.outcome_id.localeCompare(right.outcome_id))) {
    const rows = rowsById.get(entry.orca_task_id) || [];
    if (rows.length === 0) {
      failures.push(reason("PROOF_TASK_MISSING", `mapped Orca task ${entry.orca_task_id} is absent from the live task-list`));
      continue;
    }
    if (rows.length > 1) {
      failures.push(reason("PROOF_TASK_DUPLICATE", `mapped Orca task ${entry.orca_task_id} appears more than once in the live task-list`));
      continue;
    }
    const row = rows[0];
    if (row.status === "failed") failures.push(reason("PROOF_TASK_FAILED", `mapped Orca task ${entry.orca_task_id} is failed`));
    else if (row.status !== "completed") failures.push(reason("PROOF_TASK_ACTIVE", `mapped Orca task ${entry.orca_task_id} is ${nonEmpty(row.status) ? row.status : "malformed"}`));
    const marker = `relay-orca: ${segment(programId)}/${entry.outcome_id}`;
    if (taskDisplayString(row) !== marker) failures.push(reason("PROOF_TASK_MARKER_MISMATCH", `mapped Orca task ${entry.orca_task_id} does not have the exact accepted-program marker`));
    taskIds.push(entry.orca_task_id);
  }
  return { failures, taskIds };
}

function verifyCanonicalGates({ gates, receiptTasks, outcomes, programId, segment }) {
  const gateIds = [];
  const seenGateIds = new Set();
  const failures = [];
  for (const entry of receiptTasks.filter((task) => task.kind === "integration_gate").sort((left, right) => left.outcome_id.localeCompare(right.outcome_id))) {
    const outcome = outcomes.get(entry.outcome_id);
    let identity;
    try {
      identity = canonicalGateKey({
        taskId: entry.orca_task_id,
        question: canonicalIntegrationQuestion(programId, outcome.id, segment),
      });
    } catch {
      failures.push(reason("PROOF_GATE_MALFORMED", `canonical integration gate identity for ${entry.outcome_id} is unavailable`));
      continue;
    }
    const inspected = inspectCanonicalGates(gates, identity);
    if (!inspected.ok) {
      const code = inspected.reasonCode === "INTEGRATION_GATE_DUPLICATE"
        ? "PROOF_GATE_DUPLICATE"
        : inspected.reasonCode === "INTEGRATION_GATE_NONCANONICAL"
          ? "PROOF_GATE_NONCANONICAL"
          : inspected.reasonCode === "INTEGRATION_GATE_CONFLICT"
            ? "PROOF_GATE_CONFLICT"
            : "PROOF_GATE_MALFORMED";
      failures.push(reason(code, `canonical integration gate for ${entry.outcome_id} is not uniquely trustworthy`));
      continue;
    }
    if (inspected.state === "missing") failures.push(reason("PROOF_GATE_MISSING", `canonical integration gate for ${entry.outcome_id} is missing`));
    else if (inspected.state === "pending") failures.push(reason("PROOF_GATE_PENDING", `canonical integration gate for ${entry.outcome_id} is pending`));
    else if (inspected.state === "failed") failures.push(reason("PROOF_GATE_FAILED", `canonical integration gate for ${entry.outcome_id} failed`));
    else {
      const gate = inspected.gate;
      const explicit = [gate.resolution, gate.result, gate.outcome].filter((value) => value === "passed");
      const id = gateId(gate);
      if (!id || explicit.length === 0) failures.push(reason("PROOF_GATE_MALFORMED", `canonical integration gate for ${entry.outcome_id} lacks an explicit passed resolution`));
      else if (seenGateIds.has(id)) failures.push(reason("PROOF_GATE_DUPLICATE", `physical canonical gate ${id} is mapped by more than one accepted outcome`));
      else {
        seenGateIds.add(id);
        gateIds.push(id);
      }
    }
  }
  return { failures, gateIds };
}

function verifyClosedProgram(input = {}) {
  const programInput = input.acceptedProgram !== undefined ? input.acceptedProgram : input.program;
  const parsedProgram = unwrapProgram(programInput);
  if (parsedProgram.failure) return result({ ok: false, failures: [parsedProgram.failure] });
  const segment = input.programSegment || defaultProgramSegment;
  if (typeof segment !== "function") return result({ ok: false, programId: parsedProgram.programId, failures: [reason("PROOF_MALFORMED_INPUT", "collision-resistant program segment encoder is unavailable")] });
  const parsedSnapshot = normalizeSnapshot(input.orcaSnapshot !== undefined ? input.orcaSnapshot : input.snapshot);
  if (parsedSnapshot.failure) return result({ ok: false, programId: parsedProgram.programId, failures: [parsedSnapshot.failure] });
  if (parsedProgram.program.runtime_id !== undefined && parsedProgram.program.runtime_id !== parsedSnapshot.runtimeId) {
    return result({ ok: false, programId: parsedProgram.programId, runtimeId: parsedSnapshot.runtimeId, failures: [reason("PROOF_CROSS_RUNTIME", "accepted program runtime_id does not match the attributable Orca runtime")] });
  }
  const parsedReceipt = normalizeReceipt(input.receipt, parsedProgram.programId, parsedSnapshot.runtimeId);
  if (parsedReceipt.failure) return result({ ok: false, programId: parsedProgram.programId, runtimeId: parsedSnapshot.runtimeId, failures: [parsedReceipt.failure] });
  const receiptOutcomeIds = new Set(parsedReceipt.byOutcome.keys());
  const acceptedIds = new Set(parsedProgram.byId.keys());
  const mappingFailures = [];
  for (const id of [...acceptedIds].sort()) {
    if (!receiptOutcomeIds.has(id)) mappingFailures.push(reason("PROOF_OUTCOME_MISSING", `accepted outcome ${id} has no receipt mapping`));
    else if (parsedReceipt.byOutcome.get(id).kind !== parsedProgram.byId.get(id).task_kind) mappingFailures.push(reason("PROOF_CROSS_PROGRAM", `receipt mapping for ${id} has the wrong outcome kind`));
  }
  for (const id of [...receiptOutcomeIds].sort()) if (!acceptedIds.has(id)) mappingFailures.push(reason("PROOF_CROSS_PROGRAM", `receipt maps unaccepted outcome ${id}`));
  if (mappingFailures.length > 0) return result({ ok: false, programId: parsedProgram.programId, runtimeId: parsedSnapshot.runtimeId, outcomeIds: [...acceptedIds], taskIds: [...parsedReceipt.byTask.keys()], failures: mappingFailures });

  const generic = input.trustedGenericIntegrationEvidence !== undefined
    ? input.trustedGenericIntegrationEvidence
    : input.genericIntegrationEvidence !== undefined ? input.genericIntegrationEvidence : input.integrationEvidence;
  const genericResult = verifyGenericGates({ program: parsedProgram.program, programId: parsedProgram.programId, runtimeId: parsedSnapshot.runtimeId, exitGates: parsedProgram.exitGates, trustedEvidence: generic });
  const durableInput = input.durableOutcomeEvidence !== undefined
    ? input.durableOutcomeEvidence
    : input.outcomeEvidence !== undefined ? input.outcomeEvidence : input.durableEvidence;
  const durable = normalizeRecords(durableInput, "durable outcome evidence");
  if (durable.failure) return result({ ok: false, programId: parsedProgram.programId, runtimeId: parsedSnapshot.runtimeId, outcomeIds: [...acceptedIds], taskIds: [...parsedReceipt.byTask.keys()], failures: [durable.failure] });
  const durableFailures = [];
  for (const id of [...acceptedIds].sort()) {
    const record = durable.byId.get(id);
    if (!record) durableFailures.push(reason("PROOF_OUTCOME_MISSING", `durable evidence for accepted outcome ${id} is missing`));
    else {
      const failure = checkDurableOutcome(record, parsedProgram.byId.get(id).task_kind, parsedProgram.programId, parsedSnapshot.runtimeId, parsedReceipt.byOutcome.get(id));
      if (failure) durableFailures.push(failure);
    }
  }
  for (const id of durable.byId.keys()) if (!acceptedIds.has(id)) durableFailures.push(reason("PROOF_CROSS_PROGRAM", `durable evidence contains unaccepted outcome ${id}`));
  const live = verifyLiveTasks({ tasks: parsedSnapshot.tasks, receiptTasks: [...parsedReceipt.byOutcome.values()], programId: parsedProgram.programId, segment });
  const canonical = verifyCanonicalGates({ gates: parsedSnapshot.gates, receiptTasks: [...parsedReceipt.byOutcome.values()], outcomes: parsedProgram.byId, programId: parsedProgram.programId, segment });
  const failures = [...genericResult.failures, ...durableFailures, ...live.failures, ...canonical.failures];
  return result({
    ok: failures.length === 0,
    programId: parsedProgram.programId,
    runtimeId: parsedSnapshot.runtimeId,
    outcomeIds: [...acceptedIds],
    taskIds: live.taskIds,
    gateIds: canonical.gateIds,
    failures,
  });
}

module.exports = {
  PROOF_REASON_CODES,
  verifyClosedProgram,
  recomputeClosedProgramProof: verifyClosedProgram,
  verifyClosedProgramProof: verifyClosedProgram,
};
