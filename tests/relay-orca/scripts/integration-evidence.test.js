"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  artifactFileName,
  indexDeclarations,
  rawRefError,
  validateArtifact,
  validateVerification,
  verificationBinding,
} = require("../../../skills/relay-orca/scripts/lib/integration-evidence.js");
const { compileProgram } = require("../../../skills/relay-orca/scripts/lib/compile-program.js");

const RUNTIME = "runtime-fixture";
const PROGRAM = "epic-evidence-unit";

function trustedVerification(passed = true) {
  return verificationBinding({
    input_sha256: `sha256:${"a".repeat(64)}`,
    result_sha256: `sha256:${"b".repeat(64)}`,
    passed,
  });
}

function declaration(checkRef = "full-suite", verification = trustedVerification(true)) {
  return { program_id: PROGRAM, runtime_id: RUNTIME, check_ref: checkRef, verification };
}

function artifact(overrides = {}) {
  return {
    schema: 1,
    ...declaration(),
    evidence: "fixture",
    ...overrides,
  };
}

test("verification binding is canonical and changes when the result changes", () => {
  const passing = trustedVerification(true);
  const failing = trustedVerification(false);
  assert.equal(validateVerification(passing).valid, true);
  assert.equal(validateVerification(failing).valid, true);
  assert.notEqual(passing.binding_sha256, failing.binding_sha256);
  assert.equal(validateVerification({ ...passing, passed: false }).valid, false);
});

test("artifact validation requires exact identity, schema, and the accepted verification binding", () => {
  const expected = declaration();
  assert.equal(validateArtifact(artifact(), { declaration: expected, programId: PROGRAM, runtimeId: RUNTIME, checkRef: "full-suite" }).passed, true);
  assert.equal(validateArtifact(artifact({ program_id: "other-program" }), { declaration: expected, programId: PROGRAM, runtimeId: RUNTIME, checkRef: "full-suite" }).valid, false);
  assert.equal(validateArtifact(artifact({ check_ref: "integration-main-suite" }), { declaration: expected, programId: PROGRAM, runtimeId: RUNTIME, checkRef: "full-suite" }).valid, false);
  assert.equal(validateArtifact(artifact({ verification: trustedVerification(false) }), { declaration: expected, programId: PROGRAM, runtimeId: RUNTIME, checkRef: "full-suite" }).valid, false);
  assert.equal(validateArtifact({ ...artifact(), passed: true }, { declaration: expected, programId: PROGRAM, runtimeId: RUNTIME, checkRef: "full-suite" }).valid, false);
});

test("declaration indexing rejects missing, duplicate, unbound, and unsafe raw refs", () => {
  const missing = indexDeclarations({ programId: PROGRAM, runtimeId: RUNTIME, refs: ["full-suite"], version: 1, declarations: [] });
  assert.match(missing.errors.get("full-suite"), /no identity declaration/);
  const duplicate = indexDeclarations({
    programId: PROGRAM,
    runtimeId: RUNTIME,
    refs: ["full-suite"],
    version: 1,
    declarations: [declaration(), declaration()],
  });
  assert.match(duplicate.errors.get("full-suite"), /duplicate\/conflicting/);
  const unsafe = indexDeclarations({
    programId: PROGRAM,
    runtimeId: RUNTIME,
    refs: ["a/../secret"],
    version: 1,
    declarations: [declaration("a/../secret")],
  });
  assert.match(unsafe.errors.get("a/../secret"), /unsafe/);
  const extra = indexDeclarations({
    programId: PROGRAM,
    runtimeId: RUNTIME,
    refs: ["full-suite"],
    version: 1,
    declarations: [declaration(), declaration("unbound")],
  });
  assert.match(extra.errors.get("full-suite"), /unbound/);
});

test("accepted-program compilation rejects identity-less generic integration gates", () => {
  assert.throws(
    () => compileProgram({
      id: PROGRAM,
      exit_gates: ["integration:full-suite"],
      outcomes: [{ id: "outcome", task_kind: "relay_run", accepted_outcomes: ["merged"] }],
    }),
    (error) => error && error.reasonCode === "INVALID_INPUT" && /integration evidence/.test(error.message),
  );
  assert.throws(
    () => compileProgram({
      id: PROGRAM,
      integration_evidence_version: 1,
      integration_evidence: [{ ...declaration("full-suite", trustedVerification(true)), runtime_id: "" }],
      exit_gates: ["integration:full-suite"],
      outcomes: [{ id: "outcome", task_kind: "relay_run", accepted_outcomes: ["merged"] }],
    }),
    (error) => error && error.reasonCode === "INVALID_INPUT" && /runtime_id/.test(error.message),
  );
});

test("raw refs are checked before lookup and collision-resistant names preserve a/b versus a-b", () => {
  assert.equal(rawRefError("a/b"), null);
  assert.match(rawRefError("a/../b"), /unsafe/);
  assert.match(rawRefError("/absolute"), /absolute/);
  assert.notEqual(artifactFileName("a/b"), artifactFileName("a-b"));
});
