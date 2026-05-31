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
  assert.deepEqual(listAgentAdapterNames(), ["claude", "codex", "opencode", "pi", "antigravity", "cursor"]);
  assert.deepEqual(listAgentAdapters().map((descriptor) => descriptor.name), ["claude", "codex", "opencode", "pi", "antigravity", "cursor"]);
});

test("agent adapter registry reports dispatch, primary review, and advisory review independently", () => {
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("codex", ADAPTER_PHASES.ADVISORY_REVIEW), false);

  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("claude", ADAPTER_PHASES.ADVISORY_REVIEW), false);

  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("opencode", ADAPTER_PHASES.ADVISORY_REVIEW), true);

  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("pi", ADAPTER_PHASES.ADVISORY_REVIEW), true);

  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.DISPATCH), true);
  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.PRIMARY_REVIEW), true);
  assert.equal(supportsAgentAdapterPhase("antigravity", ADAPTER_PHASES.ADVISORY_REVIEW), true);
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
  assert.equal(opencode.phases[ADAPTER_PHASES.PRIMARY_REVIEW].supported, true);
  assert.equal(opencode.phases[ADAPTER_PHASES.PRIMARY_REVIEW].trust, "trusted");
  assert.equal(opencode.phases[ADAPTER_PHASES.ADVISORY_REVIEW].trust, "advisory");
  assert.equal(opencode.capabilities.appRegistration.supported, false);
  assert.equal(opencode.capabilities.modelDefaults.provider, "opencode-go");
  assert.equal(opencode.capabilities.modelDefaults.dispatch.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.equal(opencode.capabilities.modelDefaults.primaryReview.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.equal(opencode.capabilities.modelDefaults.advisoryReview.defaultModel, "opencode-go/deepseek-v4-pro");
  assert.deepEqual(opencode.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(opencode.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(opencode.capabilities.sandbox.primaryReview.mode, "read-only");
  assert.equal(opencode.capabilities.sandbox.primaryReview.guard, "worktree-status");
  assert.equal(opencode.capabilities.network.dispatch.configurable, false);
  assert.equal(opencode.capabilities.network.primaryReview.enabledMode, "ambient");
  assert.equal(opencode.capabilities.readOnly.advisoryReview, true);
  assert.equal(opencode.capabilities.readOnly.primaryReview, true);
  assert.equal(opencode.capabilities.policy.primary_review.sandbox["read-only"].enforcement_level, "informational");
  assert.equal(opencode.capabilities.policy.primary_review.read_only.true.enforcement_level, "prompt-only");
  assert.equal(opencode.capabilities.transport.advisoryReview, "opencode-cli");
  assert.equal(opencode.capabilities.transport.primaryReview, "opencode-cli");
  assert.equal(opencode.capabilities.structuredOutput.primaryReview, "json-text");
  assert.equal(opencode.capabilities.structuredOutput.advisoryReview, "json-text");

  const pi = getAgentAdapterDescriptor("pi");
  assert.equal(pi.executor.cliBinary, "pi");
  assert.equal(pi.capabilities.appRegistration.supported, false);
  assert.equal(pi.capabilities.modelDefaults.provider, "pi");
  assert.deepEqual(pi.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(pi.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(pi.capabilities.network.dispatch.configurable, false);
  assert.equal(pi.capabilities.readOnly.primaryReview, true);
  assert.equal(pi.capabilities.readOnly.advisoryReview, true);
  assert.equal(pi.capabilities.transport.primaryReview, "pi-cli");
  assert.equal(pi.capabilities.transport.advisoryReview, "pi-cli");
  assert.equal(pi.capabilities.structuredOutput.primaryReview, "json-text");
  assert.equal(pi.capabilities.structuredOutput.advisoryReview, "json-text");
  assert.deepEqual(pi.capabilities.policy.primary_review.read_only.true.flags, ["--tools read,grep,find,ls"]);
  assert.deepEqual(pi.capabilities.policy.advisory_review.read_only.true.flags, ["--tools read,grep,find,ls"]);

  const antigravity = getAgentAdapterDescriptor("antigravity");
  assert.equal(antigravity.executor.cliBinary, "agy");
  assert.equal(antigravity.capabilities.appRegistration.supported, false);
  assert.equal(antigravity.capabilities.modelDefaults.provider, "google");
  assert.deepEqual(antigravity.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(antigravity.capabilities.sandbox.dispatch.enforced, true);
  assert.equal(antigravity.capabilities.network.dispatch.configurable, false);
  assert.equal(antigravity.capabilities.readOnly.primaryReview, true);
  assert.equal(antigravity.capabilities.readOnly.advisoryReview, true);
  assert.equal(antigravity.capabilities.transport.primaryReview, "agy-cli");
  assert.equal(antigravity.capabilities.transport.advisoryReview, "agy-cli");
  assert.equal(antigravity.capabilities.structuredOutput.dispatch, "stdout-copied-result-file");
  assert.equal(antigravity.capabilities.structuredOutput.primaryReview, "json-text");
  assert.equal(antigravity.capabilities.structuredOutput.advisoryReview, "json-text");
  assert.equal(antigravity.capabilities.liveSupport.status, "fail-safe-experimental");
  assert.match(antigravity.capabilities.liveSupport.until, /healthy live canary/i);
  assert.match(antigravity.capabilities.liveSupport.healthyCriteria.primaryReview, /strict verdict JSON/i);
  assert.match(antigravity.capabilities.liveSupport.healthyCriteria.dispatch, /recoverable\/reviewable state/i);
  assert.match(antigravity.capabilities.liveSupport.healthyCriteria.cliLimitation, /documented CLI limitation/i);
  assert.deepEqual(antigravity.capabilities.policy.dispatch.sandbox["workspace-write"].flags, ["--sandbox", "--add-dir <git-common-dir>"]);
  assert.deepEqual(antigravity.capabilities.policy.primary_review.read_only.true.flags, ["--sandbox", "prompt:do-not-modify-files", "git-status-before-after"]);
  assert.deepEqual(antigravity.capabilities.policy.advisory_review.read_only.true.flags, ["--sandbox", "prompt:do-not-modify-files", "git-status-before-after"]);

  const cursor = getAgentAdapterDescriptor("cursor");
  assert.equal(cursor.executor.cliBinary, "agent");
  assert.equal(cursor.capabilities.appRegistration.supported, true);
  assert.equal(cursor.capabilities.modelDefaults.provider, "cursor");
  assert.deepEqual(cursor.capabilities.sandbox.dispatch.modes, ["workspace-write"]);
  assert.equal(cursor.capabilities.sandbox.dispatch.enforced, false);
  assert.equal(cursor.phases[ADAPTER_PHASES.ADVISORY_REVIEW].supported, false);
  assert.equal(cursor.capabilities.readOnly.primaryReview, true);
  assert.equal(cursor.capabilities.readOnly.advisoryReview, false);
  assert.equal(cursor.capabilities.transport.primaryReview, "agent-cli");
  assert.equal(cursor.capabilities.structuredOutput.primaryReview, "json-wrapper-result-field");
  assert.equal(cursor.reviewer.primaryReviewScript, "invoke-reviewer-cursor.js");
  assert.equal(cursor.reviewer.advisoryReviewScript, null);
});

test("agent adapter registry fails closed for unknown adapters and phases", () => {
  assert.throws(
    () => getAgentAdapterDescriptor("nonexistent"),
    /unknown agent adapter 'nonexistent'\. Supported: claude, codex, opencode, pi, antigravity, cursor/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("nonexistent", ADAPTER_PHASES.DISPATCH),
    /unknown agent adapter 'nonexistent'\. Supported: claude, codex, opencode, pi, antigravity, cursor/
  );
  assert.throws(
    () => supportsAgentAdapterPhase("codex", "sidecar"),
    /unknown agent adapter phase 'sidecar'\. Supported: dispatch, primary_review, advisory_review/
  );
});
