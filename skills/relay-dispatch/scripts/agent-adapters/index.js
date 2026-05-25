const codex = require("../executors/codex");
const claude = require("../executors/claude");
const opencode = require("../executors/opencode");
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
