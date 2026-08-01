const path = require("path");
const legacy = require("../executors/cursor");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { cursorReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "cursor",
  legacy,
  outputProtocol: "text_stdout",
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-cursor.js"),
  buildReviewControlInvocation: ({ cwd, model }) => ({
    command: process.env.RELAY_CURSOR_AGENT_BIN || legacy.cliBinary,
    args: cursorReviewArgs({ repoPath: cwd, model }),
    cwd,
  }),
  metadata: {
    cliBinaryEnv: "RELAY_CURSOR_AGENT_BIN",
    providerDefault: "cursor",
    providerFromModel: true,
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
});
