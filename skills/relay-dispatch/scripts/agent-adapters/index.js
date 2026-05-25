const codex = require("../executors/codex");
const claude = require("../executors/claude");
const opencode = require("../executors/opencode");
const pi = require("../executors/pi");
const antigravity = require("../executors/antigravity");
const bundledModels = require("../../references/executor-models.json");

const ADAPTER_PHASES = Object.freeze({
  DISPATCH: "dispatch",
  PRIMARY_REVIEW: "primary_review",
  ADVISORY_REVIEW: "advisory_review",
});

const PHASES = Object.freeze(Object.values(ADAPTER_PHASES));

function bundledDefaultModel(name) {
  const value = bundledModels.executors?.[name]?.default_model;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function freezeCapability(value) {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) {
    freezeCapability(child);
  }
  return Object.freeze(value);
}

function buildDescriptor({
  name,
  displayName,
  executor,
  phases,
  capabilities,
  reviewer,
}) {
  return Object.freeze({
    name,
    displayName,
    cliBinary: executor.cliBinary,
    executor,
    phases: freezeCapability(phases),
    capabilities: freezeCapability(capabilities),
    reviewer: reviewer ? freezeCapability(reviewer) : null,
  });
}

const DESCRIPTORS = Object.freeze({
  claude: buildDescriptor({
    name: "claude",
    displayName: "Claude Code",
    executor: claude,
    phases: {
      [ADAPTER_PHASES.DISPATCH]: {
        supported: true,
        trust: "executor",
      },
      [ADAPTER_PHASES.PRIMARY_REVIEW]: {
        supported: true,
        trust: "trusted",
      },
      [ADAPTER_PHASES.ADVISORY_REVIEW]: {
        supported: false,
        trust: "unsupported",
      },
    },
    capabilities: {
      sandbox: {
        dispatch: {
          modes: ["workspace-write"],
          enforced: false,
        },
        primaryReview: {
          mode: "read-only",
          enforced: true,
        },
        advisoryReview: null,
      },
      network: {
        dispatch: {
          configurable: false,
          enabledMode: "ambient",
        },
        primaryReview: {
          configurable: false,
          enabledMode: "ambient",
        },
        advisoryReview: null,
      },
      readOnly: {
        dispatch: false,
        primaryReview: true,
        advisoryReview: false,
      },
      policy: {
        dispatch: {
          sandbox: {
            "workspace-write": {
              enforcement_level: "permission-mode",
              mechanism: "claude-dangerously-skip-permissions",
              flags: ["--dangerously-skip-permissions"],
              warnings: ["Claude dispatch does not provide OS-level sandbox containment."],
            },
          },
          network: {
            ambient: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Claude dispatch does not gate network access at the executor level."],
            },
            disabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Claude dispatch does not gate network access at the executor level."],
            },
            enabled: {
              enforcement_level: "unsupported",
              mechanism: null,
              fail_closed_reason: "Claude dispatch cannot represent requested network-access=enabled safely.",
            },
          },
          read_only: {
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
        primary_review: {
          sandbox: {
            "read-only": {
              enforcement_level: "tool-allowlist",
              mechanism: "claude-allowed-tools",
              flags: ["--allowedTools=Read"],
              warnings: ["Claude reviewer read-only is a tool allowlist, not OS-level containment."],
            },
          },
          network: {
            ambient: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Claude reviewer does not gate network access at the CLI level."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "tool-allowlist",
              mechanism: "claude-allowed-tools",
              flags: ["--allowedTools=Read"],
              warnings: ["Claude reviewer read-only is a tool allowlist, not OS-level containment."],
            },
          },
        },
        advisory_review: null,
      },
      transport: {
        dispatch: "claude-cli",
        primaryReview: "claude-cli",
        advisoryReview: null,
      },
      structuredOutput: {
        dispatch: "stdout-copied-result-file",
        primaryReview: "json-schema-argv",
        advisoryReview: null,
      },
      appRegistration: {
        supported: true,
        transport: "claude-app",
      },
      modelDefaults: {
        provider: claude.providerDefault,
        dispatch: {
          configKey: "claude",
          defaultModel: null,
        },
        primaryReview: {
          configKey: "claude",
          defaultModel: null,
        },
        advisoryReview: null,
      },
    },
    reviewer: {
      primaryReviewScript: "invoke-reviewer-claude.js",
      advisoryReviewScript: null,
    },
  }),
  codex: buildDescriptor({
    name: "codex",
    displayName: "Codex CLI",
    executor: codex,
    phases: {
      [ADAPTER_PHASES.DISPATCH]: {
        supported: true,
        trust: "executor",
      },
      [ADAPTER_PHASES.PRIMARY_REVIEW]: {
        supported: true,
        trust: "trusted",
      },
      [ADAPTER_PHASES.ADVISORY_REVIEW]: {
        supported: false,
        trust: "unsupported",
      },
    },
    capabilities: {
      sandbox: {
        dispatch: {
          modes: ["read-only", "workspace-write"],
          enforced: true,
        },
        primaryReview: {
          mode: "read-only",
          enforced: true,
        },
        advisoryReview: null,
      },
      network: {
        dispatch: {
          configurable: true,
          default: "disabled",
        },
        primaryReview: {
          configurable: false,
          default: "disabled",
        },
        advisoryReview: null,
      },
      readOnly: {
        dispatch: false,
        primaryReview: true,
        advisoryReview: false,
      },
      policy: {
        dispatch: {
          sandbox: {
            "read-only": {
              enforcement_level: "native",
              mechanism: "codex-cli-sandbox",
              flags: ["--sandbox read-only"],
            },
            "workspace-write": {
              enforcement_level: "native",
              mechanism: "codex-cli-sandbox",
              flags: ["--sandbox workspace-write"],
            },
          },
          network: {
            disabled: {
              enforcement_level: "native",
              mechanism: "codex-default-network-disabled",
            },
            enabled: {
              enforcement_level: "native",
              mechanism: "codex-workspace-network-config",
              flags: ["-c sandbox_workspace_write.network_access=true"],
            },
          },
          read_only: {
            true: {
              enforcement_level: "native",
              mechanism: "codex-cli-sandbox",
              flags: ["--sandbox read-only"],
            },
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
        primary_review: {
          sandbox: {
            "read-only": {
              enforcement_level: "native",
              mechanism: "codex-cli-sandbox",
              flags: ["--sandbox read-only"],
            },
          },
          network: {
            disabled: {
              enforcement_level: "native",
              mechanism: "codex-default-network-disabled",
            },
          },
          read_only: {
            true: {
              enforcement_level: "native",
              mechanism: "codex-cli-sandbox",
              flags: ["--sandbox read-only"],
            },
          },
        },
        advisory_review: null,
      },
      transport: {
        dispatch: "codex-cli",
        primaryReview: "codex-cli",
        advisoryReview: null,
      },
      structuredOutput: {
        dispatch: "result-file",
        primaryReview: "json-schema-file",
        advisoryReview: null,
      },
      appRegistration: {
        supported: true,
        transport: "codex-app",
      },
      modelDefaults: {
        provider: codex.providerDefault,
        dispatch: {
          configKey: "codex",
          defaultModel: null,
        },
        primaryReview: {
          configKey: "codex",
          defaultModel: null,
        },
        advisoryReview: null,
      },
    },
    reviewer: {
      primaryReviewScript: "invoke-reviewer-codex.js",
      advisoryReviewScript: null,
    },
  }),
  opencode: buildDescriptor({
    name: "opencode",
    displayName: "OpenCode",
    executor: opencode,
    phases: {
      [ADAPTER_PHASES.DISPATCH]: {
        supported: true,
        trust: "executor",
      },
      [ADAPTER_PHASES.PRIMARY_REVIEW]: {
        supported: false,
        trust: "unsupported",
      },
      [ADAPTER_PHASES.ADVISORY_REVIEW]: {
        supported: true,
        trust: "advisory",
      },
    },
    capabilities: {
      sandbox: {
        dispatch: {
          modes: ["workspace-write"],
          enforced: false,
        },
        primaryReview: null,
        advisoryReview: {
          mode: "read-only",
          enforced: false,
          guard: "worktree-status",
        },
      },
      network: {
        dispatch: {
          configurable: false,
          enabledMode: "ambient",
        },
        primaryReview: null,
        advisoryReview: {
          configurable: false,
          enabledMode: "ambient",
        },
      },
      readOnly: {
        dispatch: false,
        primaryReview: false,
        advisoryReview: true,
      },
      policy: {
        dispatch: {
          sandbox: {
            "workspace-write": {
              enforcement_level: "informational",
              mechanism: "opencode-cli",
              warnings: ["OpenCode does not provide native sandbox containment."],
            },
            "read-only": {
              enforcement_level: "informational",
              mechanism: "opencode-cli",
              warnings: ["OpenCode does not provide native sandbox containment; read-only is not enforced for dispatch."],
            },
          },
          network: {
            disabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["OpenCode does not gate network access at the executor level."],
            },
            enabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["OpenCode does not gate network access at the executor level."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "informational",
              mechanism: "opencode-cli",
              warnings: ["OpenCode dispatch read-only intent is informational only and does not prevent writes."],
            },
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
        primary_review: null,
        advisory_review: {
          sandbox: {
            "read-only": {
              enforcement_level: "informational",
              mechanism: "detached-worktree-status-guard",
              warnings: ["OpenCode advisory review runs in a detached worktree with post-run status checks; this is not OS-level containment."],
            },
          },
          network: {
            ambient: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["OpenCode advisory review does not gate network access at the CLI level."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "prompt-only",
              mechanism: "prompt-instruction-with-worktree-status-guard",
              flags: ["prompt:do-not-modify-files", "git-status-before-after"],
              warnings: ["OpenCode advisory read-only instructions do not prevent writes; relay records post-run worktree mutation as a policy violation."],
            },
          },
        },
      },
      transport: {
        dispatch: "opencode-cli",
        primaryReview: null,
        advisoryReview: "opencode-cli",
      },
      structuredOutput: {
        dispatch: "stdout-copied-result-file",
        primaryReview: null,
        advisoryReview: "json-text",
      },
      appRegistration: {
        supported: false,
        transport: null,
      },
      modelDefaults: {
        provider: opencode.providerDefault || "opencode-go",
        dispatch: {
          configKey: "opencode",
          defaultModel: bundledDefaultModel("opencode"),
        },
        primaryReview: null,
        advisoryReview: {
          configKey: "opencode",
          defaultModel: bundledDefaultModel("opencode"),
        },
      },
    },
    reviewer: {
      primaryReviewScript: null,
      advisoryReviewScript: "invoke-reviewer-opencode.js",
    },
  }),
  pi: buildDescriptor({
    name: "pi",
    displayName: "Pi CLI",
    executor: pi,
    phases: {
      [ADAPTER_PHASES.DISPATCH]: {
        supported: true,
        trust: "executor",
      },
      [ADAPTER_PHASES.PRIMARY_REVIEW]: {
        supported: true,
        trust: "trusted",
      },
      [ADAPTER_PHASES.ADVISORY_REVIEW]: {
        supported: false,
        trust: "unsupported",
      },
    },
    capabilities: {
      sandbox: {
        dispatch: {
          modes: ["workspace-write"],
          enforced: false,
        },
        primaryReview: {
          mode: "read-only",
          enforced: false,
          guard: "worktree-status",
        },
        advisoryReview: null,
      },
      network: {
        dispatch: {
          configurable: false,
          enabledMode: "ambient",
        },
        primaryReview: {
          configurable: false,
          default: "disabled",
        },
        advisoryReview: null,
      },
      readOnly: {
        dispatch: false,
        primaryReview: true,
        advisoryReview: false,
      },
      policy: {
        dispatch: {
          sandbox: {
            "workspace-write": {
              enforcement_level: "informational",
              mechanism: "pi-cli",
              warnings: ["Pi dispatch does not provide native sandbox containment."],
            },
            "read-only": {
              enforcement_level: "informational",
              mechanism: "pi-cli",
              warnings: ["Pi dispatch read-only intent is informational only and does not prevent writes."],
            },
          },
          network: {
            disabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Pi dispatch does not gate network access at the executor level."],
            },
            enabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Pi dispatch does not gate network access at the executor level."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "informational",
              mechanism: "pi-cli",
              warnings: ["Pi dispatch read-only intent is informational only and does not prevent writes."],
            },
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
        primary_review: {
          sandbox: {
            "read-only": {
              enforcement_level: "tool-allowlist",
              mechanism: "pi-tools-allowlist",
              flags: ["--tools read,grep,find,ls"],
              warnings: ["Pi reviewer read-only is a tool allowlist, not OS-level containment; relay still checks dirty worktree status after invocation."],
            },
          },
          network: {
            disabled: {
              enforcement_level: "tool-allowlist",
              mechanism: "pi-tools-allowlist",
              flags: ["--tools read,grep,find,ls"],
              warnings: ["Pi reviewer has no network tool in the relay allowlist; dirty worktree detection remains active."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "tool-allowlist",
              mechanism: "pi-tools-allowlist",
              flags: ["--tools read,grep,find,ls"],
              warnings: ["Pi reviewer read-only is a tool allowlist, not OS-level containment; dirty worktree detection remains active."],
            },
          },
        },
        advisory_review: null,
      },
      transport: {
        dispatch: "pi-cli",
        primaryReview: "pi-cli",
        advisoryReview: null,
      },
      structuredOutput: {
        dispatch: "stdout-copied-result-file",
        primaryReview: "json-text",
        advisoryReview: null,
      },
      appRegistration: {
        supported: false,
        transport: null,
      },
      modelDefaults: {
        provider: pi.providerDefault,
        dispatch: {
          configKey: "pi",
          defaultModel: bundledDefaultModel("pi"),
        },
        primaryReview: {
          configKey: "pi",
          defaultModel: bundledDefaultModel("pi"),
        },
        advisoryReview: null,
      },
    },
    reviewer: {
      primaryReviewScript: "invoke-reviewer-pi.js",
      advisoryReviewScript: null,
    },
  }),
  antigravity: buildDescriptor({
    name: "antigravity",
    displayName: "Google Antigravity CLI",
    executor: antigravity,
    phases: {
      [ADAPTER_PHASES.DISPATCH]: {
        supported: true,
        trust: "executor",
      },
      [ADAPTER_PHASES.PRIMARY_REVIEW]: {
        supported: true,
        trust: "trusted",
      },
      [ADAPTER_PHASES.ADVISORY_REVIEW]: {
        supported: false,
        trust: "unsupported",
      },
    },
    capabilities: {
      sandbox: {
        dispatch: {
          modes: ["workspace-write"],
          enforced: true,
        },
        primaryReview: {
          mode: "read-only",
          enforced: false,
          guard: "worktree-status",
        },
        advisoryReview: null,
      },
      network: {
        dispatch: {
          configurable: false,
          enabledMode: "ambient",
        },
        primaryReview: {
          configurable: false,
          default: "disabled",
        },
        advisoryReview: null,
      },
      readOnly: {
        dispatch: false,
        primaryReview: true,
        advisoryReview: false,
      },
      policy: {
        dispatch: {
          sandbox: {
            "workspace-write": {
              enforcement_level: "native",
              mechanism: "agy-sandbox-flag",
              flags: ["--sandbox", "--add-dir <git-common-dir>"],
              warnings: ["Antigravity dispatch uses agy CLI sandboxing; relay records the exact CLI version from agy --version at dispatch time."],
            },
          },
          network: {
            disabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Antigravity dispatch does not expose relay network gating."],
            },
            enabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Antigravity dispatch does not expose relay network gating."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "unsupported",
              mechanism: null,
              fail_closed_reason: "antigravity dispatch does not expose a relay read-only execution mode",
            },
            false: {
              enforcement_level: "unsupported",
              mechanism: "write-capable-dispatch",
            },
          },
        },
        primary_review: {
          sandbox: {
            "read-only": {
              enforcement_level: "native",
              mechanism: "agy-sandbox-flag",
              flags: ["--sandbox"],
              warnings: ["Antigravity reviewer sandboxing is not treated as read-only proof; relay still checks dirty worktree status after invocation."],
            },
          },
          network: {
            disabled: {
              enforcement_level: "informational",
              mechanism: "ambient-network",
              warnings: ["Antigravity reviewer does not expose relay network gating."],
            },
          },
          read_only: {
            true: {
              enforcement_level: "prompt-only",
              mechanism: "prompt-instruction-with-worktree-status-guard",
              flags: ["--sandbox", "prompt:do-not-modify-files", "git-status-before-after"],
              warnings: ["Antigravity reviewer read-only intent relies on prompt instructions plus review-runner dirty-worktree detection."],
            },
          },
        },
        advisory_review: null,
      },
      transport: {
        dispatch: "agy-cli",
        primaryReview: "agy-cli",
        advisoryReview: null,
      },
      structuredOutput: {
        dispatch: "stdout-copied-result-file",
        primaryReview: "json-text",
        advisoryReview: null,
      },
      appRegistration: {
        supported: false,
        transport: null,
      },
      modelDefaults: {
        provider: antigravity.providerDefault,
        dispatch: {
          configKey: "antigravity",
          defaultModel: bundledDefaultModel("antigravity"),
        },
        primaryReview: {
          configKey: "antigravity",
          defaultModel: bundledDefaultModel("antigravity"),
        },
        advisoryReview: null,
      },
    },
    reviewer: {
      primaryReviewScript: "invoke-reviewer-antigravity.js",
      advisoryReviewScript: null,
    },
  }),
});

function listAgentAdapterNames() {
  return Object.keys(DESCRIPTORS);
}

function supportedNamesMessage() {
  return listAgentAdapterNames().join(", ");
}

function getAgentAdapterDescriptor(name) {
  if (!Object.prototype.hasOwnProperty.call(DESCRIPTORS, name)) {
    throw new Error(`unknown agent adapter '${name}'. Supported: ${supportedNamesMessage()}`);
  }
  return DESCRIPTORS[name];
}

function listAgentAdapters() {
  return listAgentAdapterNames().map((name) => getAgentAdapterDescriptor(name));
}

function assertKnownPhase(phase) {
  if (!PHASES.includes(phase)) {
    throw new Error(`unknown agent adapter phase '${phase}'. Supported: ${PHASES.join(", ")}`);
  }
}

function supportsAgentAdapterPhase(name, phase) {
  assertKnownPhase(phase);
  return getAgentAdapterDescriptor(name).phases[phase]?.supported === true;
}

function assertAgentAdapterSupportsPhase(name, phase) {
  assertKnownPhase(phase);
  if (!supportsAgentAdapterPhase(name, phase)) {
    throw new Error(
      `agent adapter '${name}' does not support phase '${phase}'. Supported phases: ${
        PHASES.filter((candidate) => supportsAgentAdapterPhase(name, candidate)).join(", ") || "(none)"
      }`
    );
  }
  return getAgentAdapterDescriptor(name);
}

module.exports = {
  ADAPTER_PHASES,
  assertAgentAdapterSupportsPhase,
  getAgentAdapterDescriptor,
  listAgentAdapterNames,
  listAgentAdapters,
  supportsAgentAdapterPhase,
};
