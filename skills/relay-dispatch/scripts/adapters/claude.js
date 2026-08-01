const path = require("path");
const legacy = require("../executors/claude");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("../../../relay-review/scripts/review-schema");
const { claudeReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "claude",
  legacy,
  outputProtocol: "text_stdout",
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-claude.js"),
  buildReviewControlInvocation: ({ cwd, model }) => ({
    command: process.env.RELAY_CLAUDE_BIN || legacy.cliBinary,
    args: claudeReviewArgs({ schema: REVIEWER_VERDICT_JSON_SCHEMA, model }),
    cwd,
  }),
  metadata: { providerDefault: "anthropic", providerFromModel: true },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
});
