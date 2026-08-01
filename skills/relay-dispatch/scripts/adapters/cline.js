const legacy = require("../executors/cline");
const { makeLegacyCliAdapter } = require("../adapter-contract");

module.exports = makeLegacyCliAdapter({
  name: "cline",
  legacy,
  outputProtocol: (phase) => phase === "dispatch" ? "jsonl_run_result" : "json_result",
  reviewScript: null,
  metadata: {
    cliBinaryEnv: "RELAY_CLINE_BIN",
    providerDefault: "cline-pass",
    providerFromModel: true,
    resultErrorLabel: "Cline JSONL",
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "jsonl" },
    primary_review: { supported: false, reason: "Cline primary review remains blocked pending a strict live canary" },
  },
});
