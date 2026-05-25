const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
  listAgentAdapterNames,
  listAgentAdapters,
  supportsAgentAdapterPhase,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters");

test("agent adapter registry exposes the current built-in adapters", () => {
  assert.deepEqual(listAgentAdapterNames(), ["claude", "codex", "opencode", "pi"]);
  assert.deepEqual(listAgentAdapters().map((descriptor) => descriptor.name), ["claude", "codex", "opencode", "pi"]);
});

test("agent adapter registry reports dispatch, primary review, and advisory review independently", () => {
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.ADVISORY_REVIEW), false);

  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.ADVISORY_REVIEW), false);

  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.PRIMARY_REVIEW), false);
  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.ADVISORY_REVIEW), true);

  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.ADVISORY_REVIEW), false);
});

test("agent adapter descriptors expose structured capabilities and the executor contract", () => {
  const codex = getAgentAdapterDescriptor("codex");
  assert.equal(codex.executor.cliBinary, "codex");
  assert.equal(codex.capabilities.appRegistration.supported, true);
  assert.equal(codex.capabilities.appRegistration.transport, "codex-app");
  assert.equal(codex.capabilities.modelDefaults.provider, "openai");
  assert.equal(codex.capabilities.modelDefaults.dispatch.configKey, "codex");
  assert.deepEqual(codex.capabilities.sandbox.dispatch.modes, ["read-only", "workspace-write"]);
  assert.equal(codex.capabilities.network.dispatch.configurable, true);
  assert.equal(codex.capabilities.readOnly.primaryReview, true);
  assert.equal(codex.capabilities.transport.primaryReview, "codex-cli");
  assert.equal(codex.capabilities.structuredOutput.primaryReview, "json-schema-file");

  const claude = getAgentAdapterDescriptor("claude");
  assert.equal(claude.executor.cliBinary, "claude");
  assert.equal(claude.capabilities.appRegistration.transport, "claude-app");
  assert.equal(claude.capabilities.modelDefaults.provider, "anthropic");
  assert.equal(claude.capabilities.network.dispatch.configurable, false);
  assert.equal(claude.capabilities.readOnly.primaryReview, true);
  assert.equal(claude.capabilities.transport.primaryReview, "claude-cli");
  assert.equal(claude.capabilities.structuredOutput.primaryReview, "json-schema-argv");

  const opencode = getAgentAdapterDescriptor("opencode");
  assert.equal(opencode.executor.cliBinary, "opencode");
  assert.equal(opencode.capabilities.appRegistration.supported, false);
  assert.equal(opencode.capabilities.modelDefaults.provider, "opencode-go");
  assert.equal(opencode.capabilities.modelDefaults.dispatch.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.deepEqual(opencode.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(opencode.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(opencode.capabilities.network.dispatch.configurable, false);
  assert.equal(opencode.capabilities.readOnly.advisoryReview, true);
  assert.equal(opencode.capabilities.transport.advisoryReview, "opencode-cli");
  assert.equal(opencode.capabilities.structuredOutput.advisoryReview, "json-text");

  const pi = getAgentAdapterDescriptor("pi");
  assert.equal(pi.executor.cliBinary, "pi");
  assert.equal(pi.capabilities.appRegistration.supported, false);
  assert.equal(pi.capabilities.modelDefaults.provider, "pi");
  assert.deepEqual(pi.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(pi.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(pi.capabilities.network.dispatch.configurable, false);
  assert.equal(pi.capabilities.readOnly.primaryReview, true);
  assert.equal(pi.capabilities.transport.primaryReview, "pi-cli");
  assert.equal(pi.capabilities.structuredOutput.primaryReview, "json-text");
  assert.deepEqual(pi.capabilities.policy.primary_review.read_only.true.flags, ["--tools read,grep,find,ls"]);
});

test("agent adapter registry fails closed for unknown adapters and phases", () => {
  assert.throws(
    () => getAgentAdapterDescriptor("antigravity"),
    /unknown agent adapter 'antigravity'\. Supported: claude, codex, opencode, pi/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.DISPATCH),
    /unknown agent adapter 'antigravity'\. Supported: claude, codex, opencode, pi/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("codex", "sidecar"),
    /unknown agent adapter phase 'sidecar'\. Supported: dispatch, primary_review, advisory_review/
  );
});
