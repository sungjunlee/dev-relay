function summarizeFailure(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function ensureJsonText(text, label) {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

module.exports = { summarizeFailure, ensureJsonText };
