const path = require("path");
const legacy = require("../executors/codex");
const { makeLegacyCliAdapter } = require("../adapter-contract");
const { codexReviewArgs } = require("../../../relay-review/scripts/reviewer-control-invocations");

module.exports = makeLegacyCliAdapter({
  name: "codex",
  legacy,
  outputProtocol: "text_stdout",
  omitImplicitReasoning: true,
  reviewScript: path.join(__dirname, "../../../relay-review/scripts/invoke-reviewer-codex.js"),
  buildReviewControlInvocation: ({ cwd, promptPath, resultPath, model }) => ({
    command: process.env.RELAY_CODEX_BIN || legacy.cliBinary,
    args: codexReviewArgs({ repoPath: cwd, schemaPath: promptPath, resultPath, model }),
    cwd,
  }),
  metadata: { providerDefault: "openai", providerFromModel: true },
  phases: {
    dispatch: { supported: true, write: true, readOnly: true, networkControl: "native", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "native", cancellation: "process", structuredOutput: "json" },
  },
});
