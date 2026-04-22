const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EXECUTION_EVIDENCE_FILENAME = "execution-evidence.json";
const EXECUTION_EVIDENCE_SCHEMA_VERSION = 1;

function hashFileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildExecutionEvidence({ headSha, testCommand, resultFilePath, executor, recordedAt }) {
  if (!headSha) {
    throw new Error("post-dispatch HEAD SHA is required for execution evidence");
  }

  const resultHash = hashFileSha256(resultFilePath);
  return {
    schema_version: EXECUTION_EVIDENCE_SCHEMA_VERSION,
    head_sha: headSha,
    test_command: testCommand === undefined || testCommand === null ? "unspecified" : testCommand,
    test_result_hash: resultHash || "unspecified",
    test_result_summary: resultHash ? `${executor || "executor"} result.txt hashed` : "unspecified",
    recorded_at: recordedAt || new Date().toISOString(),
    recorded_by: "dispatch-orchestrator-v1",
  };
}

function writeExecutionEvidence(runDir, evidence, options = {}) {
  const finalPath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  const tmpPath = options.tmpPath || path.join(
    runDir,
    `${EXECUTION_EVIDENCE_FILENAME}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return finalPath;
}

module.exports = {
  EXECUTION_EVIDENCE_FILENAME,
  EXECUTION_EVIDENCE_SCHEMA_VERSION,
  buildExecutionEvidence,
  hashFileSha256,
  writeExecutionEvidence,
};
