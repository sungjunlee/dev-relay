const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
  listAgentAdapterNames,
  supportsAgentAdapterPhase,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters");

const NAMES = ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"];

test("registry exposes seven dispatch adapters and only closed runtime phases", () => {
  assert.deepEqual(listAgentAdapterNames(), NAMES);
  assert.deepEqual(Object.values(ADAPTER_PHASES), ["dispatch", "primary_review"]);
  for (const name of NAMES) {
    assert.equal(supportsAgentAdapterPhase(name, ADAPTER_PHASES.DISPATCH), true);
  }
});

test("primary review support is explicit and Cline remains dispatch-only", () => {
  for (const name of NAMES.filter((value) => value !== "cline")) {
    assert.equal(supportsAgentAdapterPhase(name, ADAPTER_PHASES.PRIMARY_REVIEW), true);
    assert.match(getAgentAdapterDescriptor(name).reviewer.primaryReviewScript, /^invoke-reviewer-/);
  }
  const cline = getAgentAdapterDescriptor("cline");
  assert.equal(supportsAgentAdapterPhase("cline", ADAPTER_PHASES.PRIMARY_REVIEW), false);
  assert.equal(cline.reviewer.primaryReviewScript, null);
});

test("descriptors retain executor and containment metadata without a secondary review lane", () => {
  for (const name of NAMES) {
    const descriptor = getAgentAdapterDescriptor(name);
    assert.equal(typeof descriptor.executor.buildExecCommand, "function");
    assert.equal(Object.hasOwn(descriptor.phases, "advisory_review"), false);
    assert.equal(Object.hasOwn(descriptor.capabilities.policy, "advisory_review"), false);
    assert.equal(Object.hasOwn(descriptor.capabilities, "advisoryReview"), false);
    assert.equal(Object.hasOwn(descriptor.reviewer, "advisoryReviewScript"), false);
  }
});

test("registry fails closed for unknown adapters and phases", () => {
  assert.throws(
    () => getAgentAdapterDescriptor("nonexistent"),
    /unknown agent adapter 'nonexistent'/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("codex", "advisory_review"),
    /unknown agent adapter phase 'advisory_review'.*dispatch, primary_review/
  );
});
