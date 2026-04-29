const { summarizeFailure } = require("../../relay-dispatch/scripts/manifest/paths");

function ensureJsonText(text, label) {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

module.exports = { summarizeFailure, ensureJsonText };
