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
const VERIFICATION_HASH_FIELDS = ["output_hash", "stdout_hash", "stderr_hash"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function buildMissingExecutionEvidenceReason() {
  return `execution-evidence.json missing; if this is a pre-261 run, use ${FORCE_FINALIZE_GUIDANCE}`;
}

function validateVerificationHash(value, fieldName) {
  if (value !== undefined && (!isNonEmptyString(value) || !SHA256_PATTERN.test(value))) {
    throw new Error(`execution evidence verification_runs[].${fieldName} must be a sha256 hex digest when present`);
  }
}

function validateVerificationRun(run, index) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`execution evidence verification_runs[${index}] must be a JSON object`);
  }
  if (!isNonEmptyString(run.command)) {
    throw new Error(`execution evidence verification_runs[${index}].command must be a non-empty string`);
  }
  if (!isNonEmptyString(run.cwd)) {
    throw new Error(`execution evidence verification_runs[${index}].cwd must be a non-empty string`);
  }
  if (!isNonEmptyString(run.head_sha) || !SHA40_PATTERN.test(run.head_sha)) {
    throw new Error(`execution evidence verification_runs[${index}].head_sha must be a 40-character hex SHA`);
  }
  if (!Number.isInteger(run.exit_code) || run.exit_code < 0) {
    throw new Error(`execution evidence verification_runs[${index}].exit_code must be a non-negative integer`);
  }
  if (!isNonEmptyString(run.recorded_by)) {
    throw new Error(`execution evidence verification_runs[${index}].recorded_by must be a non-empty string`);
  }
  if (!isNonEmptyString(run.recorded_at) || Number.isNaN(Date.parse(run.recorded_at))) {
    throw new Error(`execution evidence verification_runs[${index}].recorded_at must be a valid ISO timestamp`);
  }
  for (const fieldName of VERIFICATION_HASH_FIELDS) {
    validateVerificationHash(run[fieldName], fieldName);
  }
  if (!VERIFICATION_HASH_FIELDS.some((fieldName) => isNonEmptyString(run[fieldName]))) {
    throw new Error(
      `execution evidence verification_runs[${index}] requires at least one of ${VERIFICATION_HASH_FIELDS.join(", ")}`
    );
  }
}

function buildMissingExecutionEvidenceVerdict(verdict) {
  return buildExecutionEvidenceFailureVerdict({
    ...verdict,
    quality_execution_status: "missing",
    quality_execution_reason: verdict.quality_execution_reason || buildMissingExecutionEvidenceReason(),
  });
}

function buildExecutionEvidenceFailureVerdict(verdict) {
  const reason = String(verdict.quality_execution_reason || "").trim()
    || buildMissingExecutionEvidenceReason();
  const status = verdict.quality_execution_status || "missing";
  return {
    ...verdict,
    verdict: "changes_requested",
    summary: status === "missing"
      ? "review-runner fail-closed reviewer PASS because execution-evidence.json is missing for the reviewed HEAD."
      : `review-runner fail-closed reviewer PASS because execution-evidence.json reported quality_execution_status=${status} for the reviewed HEAD.`,
    next_action: "changes_requested",
    issues: [{
      title: status === "missing"
        ? "Missing execution evidence for reviewed HEAD"
        : "Execution evidence failed validation for reviewed HEAD",
      body: `${reason} Reviewer PASS cannot be applied without SHA-bound execution evidence for this commit.`,
      file: EXECUTION_EVIDENCE_FILENAME,
      line: 1,
      category: "quality",
      severity: "high",
    }],
  };
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
    if (artifact[field] === undefined || artifact[field] === null) {
      throw new Error(`execution evidence missing required field '${field}'`);
    }
  }

  if (artifact.schema_version !== 1) {
    throw new Error(`unsupported execution evidence schema_version=${artifact.schema_version}`);
  }
  if (!isNonEmptyString(artifact.head_sha) || !SHA40_PATTERN.test(artifact.head_sha)) {
    throw new Error("execution evidence head_sha must be a 40-character hex SHA");
  }
  if (typeof artifact.test_command !== "string") {
    throw new Error("execution evidence test_command must be a string");
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
  if (
    artifact.test_exit_code !== undefined &&
    (!Number.isInteger(artifact.test_exit_code) || artifact.test_exit_code < 0)
  ) {
    throw new Error("execution evidence test_exit_code must be a non-negative integer when present");
  }
  if (artifact.verification_runs !== undefined) {
    if (!Array.isArray(artifact.verification_runs)) {
      throw new Error("execution evidence verification_runs must be an array when present");
    }
    if (artifact.verification_runs.length === 0) {
      throw new Error("execution evidence verification_runs must not be empty when present");
    }
    artifact.verification_runs.forEach(validateVerificationRun);
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
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("execution evidence must be a regular file inside the run directory");
    }
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

function computeQualityExecutionStatus({ runDir, reviewedHead, strict = false }) {
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
  if (strict) {
    if (artifactLoad.artifact.verification_runs !== undefined) {
      const staleRun = artifactLoad.artifact.verification_runs.find((run) => run.head_sha !== reviewedHead);
      if (staleRun) {
        return {
          status: "fail",
          reason: `strict verification_runs evidence is stale: recorded at ${staleRun.head_sha}, reviewed at ${reviewedHead}`,
        };
      }
      const failedRun = artifactLoad.artifact.verification_runs.find((run) => run.exit_code !== 0);
      if (failedRun) {
        return {
          status: "fail",
          reason: `strict verification_runs evidence recorded nonzero exit_code=${failedRun.exit_code} for '${failedRun.command}'`,
        };
      }
      return {
        status: "pass",
        reason: null,
      };
    }
    if (!isNonEmptyString(artifactLoad.artifact.test_command) || artifactLoad.artifact.test_command === "unspecified") {
      return {
        status: "fail",
        reason: "strict execution evidence requires a non-empty test_command",
      };
    }
    if (artifactLoad.artifact.test_result_hash === "unspecified") {
      return {
        status: "fail",
        reason: "strict execution evidence requires a sha256 test_result_hash",
      };
    }
    if (artifactLoad.artifact.test_exit_code === undefined) {
      return {
        status: "fail",
        reason: "strict execution evidence requires test_exit_code=0",
      };
    }
    if (artifactLoad.artifact.test_exit_code !== 0) {
      return {
        status: "fail",
        reason: `strict execution evidence recorded nonzero test_exit_code=${artifactLoad.artifact.test_exit_code}`,
      };
    }
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
  buildExecutionEvidenceFailureVerdict,
  buildMissingExecutionEvidenceVerdict,
  buildMissingExecutionEvidenceReason,
  computeQualityExecutionStatus,
  parseExecutionEvidenceArtifact,
  readExecutionEvidenceArtifact,
};
