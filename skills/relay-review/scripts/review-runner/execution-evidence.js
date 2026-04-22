const fs = require("fs");
const path = require("path");

const EXECUTION_EVIDENCE_FILENAME = "execution-evidence.json";
const REQUIRED_EXECUTION_EVIDENCE_FIELDS = [
  "schema_version",
  "head_sha",
  "test_command",
  "test_result_hash",
  "test_result_summary",
  "recorded_at",
  "recorded_by",
];
const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const FORCE_FINALIZE_GUIDANCE = 'finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"';

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function buildMissingExecutionEvidenceReason() {
  return `execution-evidence.json missing; if this is a pre-261 run, use ${FORCE_FINALIZE_GUIDANCE}`;
}

function parseExecutionEvidenceArtifact(text) {
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (error) {
    throw new Error(`execution evidence must be valid JSON: ${error.message}`);
  }

  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("execution evidence must be a JSON object");
  }

  for (const field of REQUIRED_EXECUTION_EVIDENCE_FIELDS) {
    if (artifact[field] === undefined || artifact[field] === null || artifact[field] === "") {
      throw new Error(`execution evidence missing required field '${field}'`);
    }
  }

  if (artifact.schema_version !== 1) {
    throw new Error(`unsupported execution evidence schema_version=${artifact.schema_version}`);
  }
  if (!isNonEmptyString(artifact.head_sha) || !SHA40_PATTERN.test(artifact.head_sha)) {
    throw new Error("execution evidence head_sha must be a 40-character hex SHA");
  }
  if (!isNonEmptyString(artifact.test_command)) {
    throw new Error("execution evidence test_command must be a non-empty string");
  }
  if (!isNonEmptyString(artifact.test_result_summary)) {
    throw new Error("execution evidence test_result_summary must be a non-empty string");
  }
  if (!isNonEmptyString(artifact.recorded_by)) {
    throw new Error("execution evidence recorded_by must be a non-empty string");
  }
  if (!isNonEmptyString(artifact.recorded_at) || Number.isNaN(Date.parse(artifact.recorded_at))) {
    throw new Error("execution evidence recorded_at must be a valid ISO timestamp");
  }
  if (artifact.test_result_hash !== "unspecified" && !SHA256_PATTERN.test(artifact.test_result_hash)) {
    throw new Error("execution evidence test_result_hash must be 'unspecified' or a sha256 hex digest");
  }

  return artifact;
}

function readExecutionEvidenceArtifact(runDir) {
  const artifactPath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (!fs.existsSync(artifactPath)) {
    return {
      state: "missing",
      artifactPath,
      artifact: null,
      error: null,
    };
  }

  try {
    return {
      state: "loaded",
      artifactPath,
      artifact: parseExecutionEvidenceArtifact(fs.readFileSync(artifactPath, "utf-8")),
      error: null,
    };
  } catch (error) {
    return {
      state: "invalid",
      artifactPath,
      artifact: null,
      error: error.message,
    };
  }
}

function computeQualityExecutionStatus({ runDir, reviewedHead }) {
  const artifactLoad = readExecutionEvidenceArtifact(runDir);
  if (artifactLoad.state === "missing") {
    return {
      status: "missing",
      reason: buildMissingExecutionEvidenceReason(),
    };
  }
  if (artifactLoad.state === "invalid") {
    return {
      status: "fail",
      reason: artifactLoad.error,
    };
  }
  if (!isNonEmptyString(reviewedHead) || !SHA40_PATTERN.test(reviewedHead)) {
    return {
      status: "fail",
      reason: `invalid reviewed HEAD '${reviewedHead || "(empty)"}'`,
    };
  }
  if (artifactLoad.artifact.head_sha !== reviewedHead) {
    return {
      status: "fail",
      reason: `stale artifact: recorded at ${artifactLoad.artifact.head_sha}, reviewed at ${reviewedHead}`,
    };
  }
  return {
    status: "pass",
    reason: null,
  };
}

function applyQualityExecutionStatus(verdict, executionStatus) {
  return {
    ...verdict,
    quality_execution_status: executionStatus.status,
    quality_execution_reason: executionStatus.reason || null,
  };
}

module.exports = {
  EXECUTION_EVIDENCE_FILENAME,
  FORCE_FINALIZE_GUIDANCE,
  REQUIRED_EXECUTION_EVIDENCE_FIELDS,
  applyQualityExecutionStatus,
  buildMissingExecutionEvidenceReason,
  computeQualityExecutionStatus,
  parseExecutionEvidenceArtifact,
  readExecutionEvidenceArtifact,
};
