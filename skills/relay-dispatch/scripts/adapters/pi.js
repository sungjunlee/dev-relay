const path = require("path");
const legacy = require("../executors/pi");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { piReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "pi",
  legacy,
  outputProtocol: "text_stdout",
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-pi.js"),
  buildReviewControlInvocation: ({ cwd, model }) => ({
    command: process.env.RELAY_PI_BIN || legacy.cliBinary,
    args: piReviewArgs({
      providerExtension: process.env.RELAY_PI_REVIEW_PROVIDER_EXTENSION || null,
      model,
    }),
    cwd,
  }),
  metadata: { cliBinaryEnv: "RELAY_PI_BIN", providerDefault: "pi", providerFromModel: true },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
});
