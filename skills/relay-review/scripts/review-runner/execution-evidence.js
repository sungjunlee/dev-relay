const fs = require("fs");
const path = require("path");
const {
  extractVerificationGates,
  hashFileSha256,
} = require("../../../relay-dispatch/scripts/execution-evidence");
const {
  getRubricAnchorStatus,
} = require("../../../relay-dispatch/scripts/manifest/rubric");

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

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildMissingExecutionEvidenceReason() {
  return `execution-evidence.json missing; if this is a pre-261 run, use ${FORCE_FINALIZE_GUIDANCE}`;
}

function resolveVerificationRubricContent(runDir, manifestData) {
  const rubricPath = typeof manifestData?.anchor?.rubric_path === "string"
    ? manifestData.anchor.rubric_path.trim()
    : "";
  if (!rubricPath) {
    const fallbackPath = path.join(runDir, "rubric.yaml");
    return fs.existsSync(fallbackPath)
      ? fs.readFileSync(fallbackPath, "utf-8")
      : null;
  }

  const rubricAnchor = getRubricAnchorStatus(manifestData, {
    runDir,
    includeContent: true,
  });
  if (!rubricAnchor.satisfied) {
    throw new Error(
      `rubric anchor ${rubricAnchor.status}: ${rubricAnchor.error || "anchor validation failed"}`
    );
  }
  return rubricAnchor.content;
}

function strictMissingTestCommandReason(runDir, manifestData) {
  try {
    const rubricContent = resolveVerificationRubricContent(runDir, manifestData);
    if (rubricContent === null) {
      return "strict execution evidence requires a non-empty test_command";
    }
    const gates = extractVerificationGates(rubricContent);
    if (!gates.length) {
      return "strict execution evidence requires a non-empty test_command";
    }
    return (
      "strict execution evidence requires a non-empty test_command; " +
      `verification ${gates.length === 1 ? "gate" : "gates"} went unrecorded: ` +
      gates.map((gate) => `'${gate.name}'`).join(", ")
    );
  } catch (error) {
    return `strict execution evidence requires a non-empty test_command; ${error.message}`;
  }
}

function expectedVerificationGates(runDir, manifestData) {
  const rubricContent = resolveVerificationRubricContent(runDir, manifestData);
  return rubricContent === null ? [] : extractVerificationGates(rubricContent);
}

function missingVerificationGateReason(gates) {
  return (
    `strict execution evidence verification ${gates.length === 1 ? "gate" : "gates"} ` +
    `went unrecorded: ${gates.map((gate) => `'${gate.name}'`).join(", ")}`
  );
}

function rebrandVerificationGateReason(artifact, gates) {
  const audit = artifact.rebrand?.verification_runs;
  if (audit?.policy !== "removed_stale_after_rebrand") return null;
  return (
    `strict execution evidence rebrand removed ${audit.removed_count} stale ` +
    `${audit.removed_count === 1 ? "verification_run" : "verification_runs"} after HEAD changed ` +
    `from ${artifact.rebrand.previous_head_sha} to ${artifact.head_sha}; ` +
    "re-verify at the new HEAD or record audited operator evidence. " +
    `Required verification ${gates.length === 1 ? "gate" : "gates"}: ` +
    gates.map((gate) => `'${gate.name}'`).join(", ")
  );
}

function findMissingVerificationGates(gates, verificationRuns) {
  const unmatchedRuns = [...verificationRuns];
  return gates.filter((gate) => {
    const matchIndex = unmatchedRuns.findIndex((run) => run.command === gate.command);
    if (matchIndex === -1) return true;
    unmatchedRuns.splice(matchIndex, 1);
    return false;
  });
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
  if (run.output_path !== undefined && !isNonEmptyString(run.output_path)) {
    throw new Error(`execution evidence verification_runs[${index}].output_path must be a non-empty string when present`);
  }
  if (!VERIFICATION_HASH_FIELDS.some((fieldName) => isNonEmptyString(run[fieldName]))) {
    throw new Error(
      `execution evidence verification_runs[${index}] requires at least one of ${VERIFICATION_HASH_FIELDS.join(", ")}`
    );
  }
}

function validateVerificationRunOutputPaths(artifact, runDir) {
  (artifact.verification_runs || []).forEach((run, index) => {
    if (run.output_path === undefined) return;
    if (!pathStaysInsideRunDir(runDir, run.output_path)) {
      throw new Error(
        `execution evidence verification_runs[${index}].output_path must stay inside the run directory`
      );
    }
    const resolvedPath = path.resolve(runDir, run.output_path);
    const stat = fs.existsSync(resolvedPath) ? fs.lstatSync(resolvedPath) : null;
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `execution evidence verification_runs[${index}].output_path must resolve to an existing regular file`
      );
    }
    if (run.output_hash !== hashFileSha256(resolvedPath)) {
      throw new Error(
        `execution evidence verification_runs[${index}].output_hash does not match output_path`
      );
    }
  });
}

function validateStringArray(value, fieldName) {
  if (value !== undefined && (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry)))) {
    throw new Error(`execution evidence browser_evidence.${fieldName} must be an array of non-empty strings when present`);
  }
}

function validateBrowserEvidenceShape(browserEvidence) {
  if (browserEvidence === undefined) return;
  if (!isObject(browserEvidence)) {
    throw new Error("execution evidence browser_evidence must be a JSON object when present");
  }
  if (browserEvidence.command !== undefined && typeof browserEvidence.command !== "string") {
    throw new Error("execution evidence browser_evidence.command must be a string when present");
  }
  validateStringArray(browserEvidence.viewports, "viewports");
  validateStringArray(browserEvidence.inspected_states, "inspected_states");
  if (
    browserEvidence.console_errors !== undefined &&
    (!Number.isInteger(browserEvidence.console_errors) || browserEvidence.console_errors < 0)
  ) {
    throw new Error("execution evidence browser_evidence.console_errors must be a non-negative integer when present");
  }
  if (browserEvidence.screenshots !== undefined) {
    if (!Array.isArray(browserEvidence.screenshots)) {
      throw new Error("execution evidence browser_evidence.screenshots must be an array when present");
    }
    browserEvidence.screenshots.forEach((entry, index) => {
      if (isNonEmptyString(entry)) return;
      if (
        isObject(entry) &&
        isNonEmptyString(entry.path) &&
        isNonEmptyString(entry.sha256) &&
        SHA256_PATTERN.test(entry.sha256)
      ) {
        return;
      }
      throw new Error(
        `execution evidence browser_evidence.screenshots[${index}] must be a path string or { path, sha256 }`
      );
    });
  }
}

function pathStaysInsideRunDir(runDir, filePath) {
  const resolvedRunDir = path.resolve(runDir);
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedRunDir, filePath);
  const relative = path.relative(resolvedRunDir, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateBrowserEvidencePaths(artifact, runDir) {
  const screenshots = artifact.browser_evidence?.screenshots || [];
  screenshots.forEach((entry, index) => {
    const screenshotPath = typeof entry === "string" ? entry : entry.path;
    const hasHash = isObject(entry) && isNonEmptyString(entry.sha256) && SHA256_PATTERN.test(entry.sha256);
    // Plain paths prove a persisted run artifact; hash-backed entries may reference external storage.
    if (!hasHash && !pathStaysInsideRunDir(runDir, screenshotPath)) {
      throw new Error(
        `execution evidence browser_evidence screenshots[${index}] path must stay inside the run directory or include sha256`
      );
    }
    if (!hasHash) {
      const resolvedPath = path.isAbsolute(screenshotPath)
        ? path.resolve(screenshotPath)
        : path.resolve(runDir, screenshotPath);
      const stat = fs.existsSync(resolvedPath) ? fs.lstatSync(resolvedPath) : null;
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(
          `execution evidence browser_evidence screenshots[${index}] path must resolve to an existing regular file`
        );
      }
    }
  });
}

function summarizeBrowserEvidence(artifact) {
  const browserEvidence = artifact?.browser_evidence;
  if (!browserEvidence) return { present: false };
  return {
    present: true,
    ...(browserEvidence.command !== undefined ? { command: browserEvidence.command } : {}),
    viewportCount: Array.isArray(browserEvidence.viewports) ? browserEvidence.viewports.length : 0,
    screenshotCount: Array.isArray(browserEvidence.screenshots) ? browserEvidence.screenshots.length : 0,
    ...(browserEvidence.console_errors !== undefined ? { consoleErrors: browserEvidence.console_errors } : {}),
    inspectedStateCount: Array.isArray(browserEvidence.inspected_states) ? browserEvidence.inspected_states.length : 0,
  };
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
      confidence: "high",
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
  validateBrowserEvidenceShape(artifact.browser_evidence);

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
    const artifact = parseExecutionEvidenceArtifact(fs.readFileSync(artifactPath, "utf-8"));
    validateVerificationRunOutputPaths(artifact, runDir);
    validateBrowserEvidencePaths(artifact, runDir);
    return {
      state: "loaded",
      artifactPath,
      artifact,
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

function computeQualityExecutionStatus({ runDir, reviewedHead, strict = false, manifestData = null }) {
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
    let verificationGates;
    try {
      verificationGates = expectedVerificationGates(runDir, manifestData);
    } catch (error) {
      return {
        status: "fail",
        reason: `strict execution evidence could not resolve verification gates: ${error.message}`,
      };
    }
    if (verificationGates.length > 0) {
      if (artifactLoad.artifact.verification_runs === undefined) {
        return {
          status: "fail",
          reason: rebrandVerificationGateReason(artifactLoad.artifact, verificationGates)
            || missingVerificationGateReason(verificationGates),
        };
      }
      const missingGates = findMissingVerificationGates(
        verificationGates,
        artifactLoad.artifact.verification_runs
      );
      if (missingGates.length > 0) {
        return {
          status: "fail",
          reason: missingVerificationGateReason(missingGates),
        };
      }
    }
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
        reason: strictMissingTestCommandReason(runDir, manifestData),
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

function buildExecutionEvidencePreflight({ runDir, reviewedHead, strict = false, manifestData = null }) {
  const artifactLoad = readExecutionEvidenceArtifact(runDir);
  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead,
    strict,
    manifestData,
  });
  const status = executionStatus.status === "pass" ? "pass" : "blocked";
  return {
    status,
    qualityExecutionStatus: executionStatus.status,
    reason: executionStatus.reason || null,
    reviewedHeadSha: reviewedHead || null,
    evidenceHeadSha: artifactLoad.state === "loaded" ? artifactLoad.artifact.head_sha : null,
    artifactPath: artifactLoad.artifactPath,
    browserEvidence: artifactLoad.state === "loaded"
      ? summarizeBrowserEvidence(artifactLoad.artifact)
      : { present: false },
    nextAction: status === "pass" ? "invoke_primary_reviewer" : "repair_execution_evidence",
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
  buildExecutionEvidencePreflight,
  buildMissingExecutionEvidenceVerdict,
  buildMissingExecutionEvidenceReason,
  computeQualityExecutionStatus,
  parseExecutionEvidenceArtifact,
  readExecutionEvidenceArtifact,
};
