const path = require("path");
const legacy = require("../executors/opencode");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { opencodeReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "opencode",
  legacy,
  outputProtocol: "text_stdout",
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-opencode.js"),
  buildReviewControlInvocation: ({ cwd, model }) => ({
    command: process.env.RELAY_OPENCODE_BIN || legacy.cliBinary,
    args: opencodeReviewArgs({ model }),
    cwd,
  }),
  metadata: {
    providerDefault: "opencode",
    providerFromModel: true,
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
});
