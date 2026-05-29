const fs = require("fs");

function formatAdapterPhase({ adapter, phase } = {}) {
  const adapterName = String(adapter || "").trim() || "unknown";
  const phaseName = String(phase || "").trim() || "unknown";
  return `adapter=${adapterName} phase=${phaseName}`;
}

function copyStdoutToResultFile({ stdoutLog, resultFile, adapter, phase }) {
  const context = formatAdapterPhase({ adapter, phase });
  if (!stdoutLog) throw new Error(`${context} stdoutLog is required`);
  if (!resultFile) throw new Error(`${context} resultFile is required`);
  if (!fs.existsSync(stdoutLog)) {
    return { copied: false, status: "missing", bytes: 0 };
  }

  const bytes = fs.statSync(stdoutLog).size;
  fs.copyFileSync(stdoutLog, resultFile);
  return {
    copied: true,
    status: bytes === 0 ? "empty" : "copied",
    bytes,
  };
}

function recoverExecStdout(error) {
  const stdout = String(error?.stdout || "").trim();
  return stdout || null;
}

function parseJsonObject(text, { adapter, phase, description = "result" } = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} ${description} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${context} ${description} must be a JSON object`);
  }
  return parsed;
}

function summarizeSpawnResult(result, { adapter, phase, timeoutSeconds } = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  if (result?.error) {
    if (result.error.code === "ETIMEDOUT") {
      return `probe timed out after ${timeoutSeconds}s (${context})`;
    }
    return `${result.error.message} (${context})`;
  }
  if (result?.status !== 0) {
    return `executor exited with code ${result.status} (${context})`;
  }
  return null;
}

module.exports = {
  copyStdoutToResultFile,
  formatAdapterPhase,
  parseJsonObject,
  recoverExecStdout,
  summarizeSpawnResult,
};
