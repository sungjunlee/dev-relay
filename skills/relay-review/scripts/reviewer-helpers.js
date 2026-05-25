const { summarizeFailure } = require("../../relay-dispatch/scripts/manifest/paths");
const {
  parseJsonObject,
  recoverExecStdout,
} = require("../../relay-dispatch/scripts/agent-adapters/transport");

function ensureJsonText(text, label) {
  if (label && typeof label === "object") {
    parseJsonObject(text, label);
    return;
  }
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function parseReviewerJsonObject(text, context) {
  return parseJsonObject(text, context);
}

module.exports = {
  ensureJsonText,
  parseReviewerJsonObject,
  recoverExecStdout,
  summarizeFailure,
};
