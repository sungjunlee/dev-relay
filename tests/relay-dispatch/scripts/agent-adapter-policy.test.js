const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters");
const {
  assertPolicyRepresentable,
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

test("policy audit supports synthetic Antigravity native sandbox mapping", () => {
  const antigravityDescriptor = {
    name: "antigravity",
    capabilities: {
      policy: {
        dispatch: {
          sandbox: {
            "workspace-write": {
              enforcement_level: "native",
              mechanism: "antigravity-sandbox-profile",
              flags: ["--sandbox-profile workspace-write"],
            },
          },
          network: {
            disabled: {
              enforcement_level: "native",
              mechanism: "antigravity-network-policy",
              flags: ["--network disabled"],
            },
          },
          read_only: {
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
      },
    },
  };

  const audit = buildAgentPolicyAudit({
    descriptor: antigravityDescriptor,
    phase: ADAPTER_PHASES.DISPATCH,
    requested: {
      sandbox: "workspace-write",
      networkAccess: "disabled",
      readOnly: false,
    },
  });

  assert.equal(audit.safe, true);
  assert.equal(audit.sandbox.enforcement_level, "native");
  assert.equal(audit.sandbox.mechanism, "antigravity-sandbox-profile");
  assert.deepEqual(audit.sandbox.flags, ["--sandbox-profile workspace-write"]);
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
    /future-agent cannot represent read-only sandbox safely.*future-agent has no read-only execution mode/s
  );
});
