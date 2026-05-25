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
  assert.deepEqual(listAgentAdapterNames(), ["claude", "codex", "opencode", "pi", "antigravity"]);
  assert.deepEqual(listAgentAdapters().map((descriptor) => descriptor.name), ["claude", "codex", "opencode", "pi", "antigravity"]);
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

  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.ADVISORY_REVIEW), false);
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
  assert.equal(opencode.phases[ADAPTER_PHASES.DISPATCH].trust, "executor");
  assert.equal(opencode.phases[ADAPTER_PHASES.PRIMARY_REVIEW].supported, false);
  assert.equal(opencode.phases[ADAPTER_PHASES.PRIMARY_REVIEW].trust, "unsupported");
  assert.match(opencode.phases[ADAPTER_PHASES.PRIMARY_REVIEW].reason, /advisory-only/i);
  assert.equal(opencode.phases[ADAPTER_PHASES.ADVISORY_REVIEW].trust, "advisory");
  assert.equal(opencode.capabilities.appRegistration.supported, false);
  assert.equal(opencode.capabilities.modelDefaults.provider, "opencode-go");
  assert.equal(opencode.capabilities.modelDefaults.dispatch.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.equal(opencode.capabilities.modelDefaults.advisoryReview.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.deepEqual(opencode.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(opencode.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(opencode.capabilities.sandbox.primaryReview.supported, false);
  assert.match(opencode.capabilities.sandbox.primaryReview.failClosedReason, /--advisory-reviewer opencode/i);
  assert.equal(opencode.capabilities.network.dispatch.configurable, false);
  assert.equal(opencode.capabilities.network.primaryReview.supported, false);
  assert.equal(opencode.capabilities.readOnly.advisoryReview, true);
  assert.equal(opencode.capabilities.readOnly.primaryReview, false);
  assert.equal(opencode.capabilities.policy.primary_review.sandbox["read-only"].enforcement_level, "unsupported");
  assert.match(opencode.capabilities.policy.primary_review.sandbox["read-only"].fail_closed_reason, /primary review/i);
  assert.equal(opencode.capabilities.transport.advisoryReview, "opencode-cli");
  assert.equal(opencode.capabilities.transport.primaryReview, null);
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

  const antigravity = getAgentAdapterDescriptor("antigravity");
  assert.equal(antigravity.executor.cliBinary, "agy");
  assert.equal(antigravity.capabilities.appRegistration.supported, false);
  assert.equal(antigravity.capabilities.modelDefaults.provider, "google");
  assert.deepEqual(antigravity.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(antigravity.capabilities.sandbox.dispatch.enforced, true);
  assert.equal(antigravity.capabilities.network.dispatch.configurable, false);
  assert.equal(antigravity.capabilities.readOnly.primaryReview, true);
  assert.equal(antigravity.capabilities.transport.primaryReview, "agy-cli");
  assert.equal(antigravity.capabilities.structuredOutput.dispatch, "stdout-copied-result-file");
  assert.equal(antigravity.capabilities.structuredOutput.primaryReview, "json-text");
  assert.deepEqual(antigravity.capabilities.policy.dispatch.sandbox["workspace-write"].flags, ["--sandbox", "--add-dir <git-common-dir>"]);
  assert.deepEqual(antigravity.capabilities.policy.primary_review.read_only.true.flags, ["--sandbox", "prompt:do-not-modify-files", "git-status-before-after"]);
});

test("agent adapter registry fails closed for unknown adapters and phases", () => {
  assert.throws(
    () => getAgentAdapterDescriptor("nonexistent"),
    /unknown agent adapter 'nonexistent'\. Supported: claude, codex, opencode, pi, antigravity/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("nonexistent", ADAPTER_PHASES.DISPATCH),
    /unknown agent adapter 'nonexistent'\. Supported: claude, codex, opencode, pi, antigravity/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("codex", "sidecar"),
    /unknown agent adapter phase 'sidecar'\. Supported: dispatch, primary_review, advisory_review/
  );
});
