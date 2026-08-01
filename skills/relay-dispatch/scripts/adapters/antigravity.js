const path = require("path");
const legacy = require("../executors/antigravity");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { antigravityReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "antigravity",
  legacy,
  outputProtocol: "text_stdout",
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-antigravity.js"),
  buildReviewControlInvocation: ({ cwd, promptPath, timeoutMs }) => ({
    command: process.env.RELAY_ANTIGRAVITY_BIN || legacy.cliBinary,
    args: antigravityReviewArgs({
      promptDirectory: path.dirname(promptPath),
      promptReference: `@${promptPath}`,
      printTimeout: `${Math.max(1, Math.floor(timeoutMs / 1000))}s`,
    }),
    cwd,
  }),
  metadata: {
    cliBinaryEnv: "RELAY_ANTIGRAVITY_BIN",
    providerDefault: "google",
    providerFromModel: true,
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
});
