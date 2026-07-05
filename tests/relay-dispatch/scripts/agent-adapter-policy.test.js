const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters");
const {
  AdapterCapabilityError,
  assertPolicyRepresentable,
  buildAdapterCapabilityFailureEnvelope,
  buildAgentPolicyAudit,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters/policy");

test("policy audit records Codex native sandbox and network enforcement", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("codex"),
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "workspace-write",
      networkAccess: "enabled",
      readOnly: false,
    },
  });

  assert.equal(audit.safe, true);
  assert.deepEqual(audit.requested, {
    sandbox: "workspace-write",
    network: "enabled",
    read_only: false,
  });
  assert.equal(audit.sandbox.enforcement_level, "native");
  assert.equal(audit.sandbox.mechanism, "codex-cli-sandbox");
  assert.deepEqual(audit.sandbox.flags, ["--sandbox workspace-write"]);
  assert.equal(audit.network.enforcement_level, "native");
  assert.equal(audit.network.mechanism, "codex-workspace-network-config");
  assert.deepEqual(audit.network.flags, ["-c sandbox_workspace_write.network_access=true"]);
  assert.equal(audit.read_only.enforcement_level, "unsupported");
  assert.deepEqual(audit.fail_closed_reasons, []);
});

test("policy audit keeps OpenCode sandbox and network informational", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("opencode"),
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "read-only",
      networkAccess: "enabled",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "informational");
  assert.equal(audit.network.enforcement_level, "informational");
  assert.match(audit.sandbox.warnings.join("\n"), /does not provide native sandbox containment/i);
  assert.match(audit.network.warnings.join("\n"), /does not gate network access/i);
  assert.deepEqual(audit.fail_closed_reasons, []);
});

test("policy audit records OpenCode primary review prompt-only read-only guards", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("opencode"),
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess: "ambient",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "informational");
  assert.equal(audit.network.enforcement_level, "informational");
  assert.equal(audit.read_only.enforcement_level, "prompt-only");
  assert.deepEqual(audit.read_only.flags, [
    "prompt:do-not-modify-files",
    "git-status-before-after",
  ]);
  assert.match(audit.warnings.join("\n"), /post-run worktree mutation/i);
  assert.match(audit.warnings.join("\n"), /does not gate network access/i);
  assert.deepEqual(audit.fail_closed_reasons, []);
  assert.doesNotThrow(() => assertPolicyRepresentable(audit));
});

test("policy audit records Pi primary review read-only tool allowlist metadata", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("pi"),
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess: "disabled",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "tool-allowlist");
  assert.equal(audit.network.enforcement_level, "tool-allowlist");
  assert.equal(audit.read_only.enforcement_level, "tool-allowlist");
  assert.deepEqual(audit.read_only.flags, ["--tools read,grep,find,ls"]);
  assert.match(audit.warnings.join("\n"), /dirty worktree/i);
});

test("policy audit keeps Cline dispatch sandbox and network informational", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("cline"),
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "read-only",
      networkAccess: "enabled",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "informational");
  assert.equal(audit.network.enforcement_level, "informational");
  assert.equal(audit.read_only.enforcement_level, "informational");
  assert.match(audit.warnings.join("\n"), /does not prevent writes/i);
  assert.match(audit.warnings.join("\n"), /does not gate network access/i);
  assert.deepEqual(audit.fail_closed_reasons, []);
});

test("policy audit records Cline advisory review prompt-only read-only guard", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("cline"),
    phase: ADAPTER_PHASES.ADVISORY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess: "ambient",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "informational");
  assert.equal(audit.network.enforcement_level, "informational");
  assert.equal(audit.read_only.enforcement_level, "prompt-only");
  assert.deepEqual(audit.read_only.flags, [
    "prompt:do-not-modify-files",
    "git-status-before-after",
  ]);
  assert.match(audit.warnings.join("\n"), /worktree mutation/i);
});

test("policy audit records Antigravity dispatch sandbox and add-dir metadata", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("antigravity"),
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "workspace-write",
      networkAccess: "disabled",
      readOnly: false,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "native");
  assert.equal(audit.sandbox.mechanism, "agy-sandbox-flag");
  assert.deepEqual(audit.sandbox.flags, ["--sandbox", "--add-dir <git-common-dir>"]);
  assert.match(audit.warnings.join("\n"), /agy --version|network gating/i);
});

test("policy audit records Antigravity primary review dirty-worktree read-only guard", () => {
  const audit = buildAgentPolicyAudit({
    descriptor: getAgentAdapterDescriptor("antigravity"),
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess: "disabled",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "native");
  assert.equal(audit.read_only.enforcement_level, "prompt-only");
  assert.deepEqual(audit.sandbox.flags, ["--sandbox"]);
  assert.deepEqual(audit.read_only.flags, ["--sandbox", "prompt:do-not-modify-files", "git-status-before-after"]);
  assert.match(audit.warnings.join("\n"), /dirty-worktree|dirty worktree/i);
});

test("policy audit fails closed when a requested policy cannot be represented safely", () => {
  const unsupportedDescriptor = {
    name: "future-agent",
    capabilities: {
      policy: {
        dispatch: {
          sandbox: {
            "read-only": {
              enforcement_level: "unsupported",
              mechanism: null,
              fail_closed_reason: "future-agent cannot represent read-only sandbox safely",
            },
          },
          network: {
            disabled: {
              enforcement_level: "native",
              mechanism: "future-agent-network",
            },
          },
          read_only: {
            true: {
              enforcement_level: "unsupported",
              mechanism: null,
              fail_closed_reason: "future-agent has no read-only execution mode",
            },
          },
        },
      },
    },
  };

  const audit = buildAgentPolicyAudit({
    descriptor: unsupportedDescriptor,
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "read-only",
      networkAccess: "disabled",
      readOnly: true,
    },
  });

  assert.equal(audit.safe, false);
  assert.deepEqual(audit.fail_closed_reasons, [
    "future-agent cannot represent read-only sandbox safely",
    "future-agent has no read-only execution mode",
  ]);
  assert.throws(
    () => assertPolicyRepresentable(audit),
    (error) => {
      assert.ok(error instanceof AdapterCapabilityError);
      assert.equal(error.audit.adapter, "future-agent");
      assert.equal(error.audit.phase, ADAPTER_PHASES.DISPATCH);
      assert.match(error.message, /future-agent cannot represent read-only sandbox safely.*future-agent has no read-only execution mode/s);
      const envelope = buildAdapterCapabilityFailureEnvelope(error, { executor: "future-agent" });
      assert.equal(envelope.status, "failed");
      assert.equal(envelope.executor, "future-agent");
      assert.equal(envelope.adapter_capability.adapter, "future-agent");
      assert.equal(envelope.adapter_capability.safe, false);
      return true;
    }
  );
});
