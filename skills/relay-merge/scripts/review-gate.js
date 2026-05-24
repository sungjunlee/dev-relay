const fs = require("fs");
const path = require("path");
const { hashFileSha256 } = require("../../relay-dispatch/scripts/execution-evidence");
const { getRubricAnchorStatus } = require("../../relay-dispatch/scripts/manifest/rubric");
const { isHardenedReviewAssurance } = require("../../relay-dispatch/scripts/manifest/review-assurance");
const { parseAdvisoryReview } = require("../../relay-review/scripts/advisory-review-schema");
const { computeQualityExecutionStatus } = require("../../relay-review/scripts/review-runner/execution-evidence");

const REVIEW_MARKER_PATTERN = /^\s*<!-- relay-review(?:-round)? -->\s*$/m;
const SKIP_AUDIT_RUBRIC_STATUSES = Object.freeze([
  "persisted",
  "missing",
  "unresolved-manifest",
]);
const MISSING_SKIP_AUDIT_RUBRIC_STATUSES = new Set([
  "missing",
  "missing_path",
  "empty",
  "not_file",
  "outside_run_dir",
  "run_dir_unavailable",
  "symlink_escape",
  "follows_outside_run_dir",
  "unreadable",
]);

function toIsoOrNull(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function hasRelayReviewMarker(body) {
  return REVIEW_MARKER_PATTERN.test(String(body || ""));
}

function summarizeRubricStatusForSkip(manifestData, options = {}) {
  return summarizeRubricAuditForSkip(manifestData, options).rubricStatus;
}

function summarizeRubricAuditForSkip(manifestData, options = {}) {
  if (!manifestData) {
    return {
      rubricStatus: "unresolved-manifest",
      readyToMerge: true,
    };
  }

  const rubricAnchor = getRubricAnchorStatus(manifestData, options.runDir ? { runDir: options.runDir } : undefined);
  let rubricStatus = "missing";
  let readyToMerge = true;
  let status = null;
  let reason = null;
  if (rubricAnchor.status === "satisfied") {
    rubricStatus = "persisted";
  } else if (rubricAnchor.status === "legacy_grandfather_field") {
    rubricStatus = "legacy_grandfather_field";
    readyToMerge = false;
    status = "unsupported_grandfather_field";
    reason = rubricAnchor.error;
  } else if (MISSING_SKIP_AUDIT_RUBRIC_STATUSES.has(rubricAnchor.status)) {
    rubricStatus = "missing";
  }
  return {
    rubricStatus,
    readyToMerge,
    status,
    reason,
  };
}

function buildSkipReviewGateFailure(prNumber, rubricAudit) {
  if (!rubricAudit || rubricAudit.readyToMerge !== false) {
    return null;
  }
  return {
    status: rubricAudit.status || "invalid_rubric_file",
    pr: prNumber,
    readyToMerge: false,
    reason: rubricAudit.reason || null,
    rubricStatus: rubricAudit.rubricStatus || "unresolved-manifest",
  };
}

function buildSkipComment(reason, rubricAudit = "unresolved-manifest") {
  const normalizedAudit = typeof rubricAudit === "string"
    ? { rubricStatus: rubricAudit }
    : {
      rubricStatus: rubricAudit?.rubricStatus || "unresolved-manifest",
    };
  const lines = [
    "<!-- relay-review-skip -->",
    "## Relay Review — Skipped",
    `Reason: ${reason}`,
    `rubric_status: ${normalizedAudit.rubricStatus}`,
  ];
  return lines.join("\n");
}

function normalizeCommentRecords(comments) {
  return (comments || []).map((comment, index) => (
    typeof comment === "string"
      ? { body: comment, author: null, createdAt: null, index }
      : {
          body: comment.body,
          author: typeof comment.author === "string"
            ? comment.author
            : (comment.author?.login || null),
          createdAt: toIsoOrNull(comment.createdAt),
          index,
        }
  ));
}

function extractLatestCommit(commits) {
  let latestCommit = null;
  let latestCommitAt = null;
  for (const commit of commits || []) {
    const committedAt = toIsoOrNull(commit.committedDate || commit.authoredDate);
    if (committedAt && (!latestCommitAt || committedAt > latestCommitAt)) {
      latestCommitAt = committedAt;
      latestCommit = commit.oid || null;
    }
  }
  return { latestCommit, latestCommitAt };
}

function withRubricNote(result, rubricAnchor) {
  if (!rubricAnchor) return result;
  const next = {
    ...result,
    rubricStatus: rubricAnchor.status,
  };
  if (rubricAnchor.rubricPath) {
    next.rubricPath = rubricAnchor.rubricPath;
  }
  if (rubricAnchor.resolvedPath) {
    next.rubricResolvedPath = rubricAnchor.resolvedPath;
  }
  if (rubricAnchor.note) {
    next.note = rubricAnchor.note;
  }
  return next;
}

function buildRubricGateFailure(prNumber, rubricAnchor) {
  switch (rubricAnchor?.status) {
    case "legacy_grandfather_field":
      return withRubricNote({
        status: "unsupported_grandfather_field",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    case "missing_path":
      return withRubricNote({
        status: "missing_rubric_path",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor?.error || "anchor.rubric_path is required before merge",
      }, rubricAnchor);
    case "missing":
      return withRubricNote({
        status: "missing_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    case "empty":
      return withRubricNote({
        status: "empty_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    case "outside_run_dir":
    case "follows_outside_run_dir":
    case "symlink_escape":
    case "run_dir_unavailable":
      return withRubricNote({
        status: "invalid_rubric_path",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    default:
      return withRubricNote({
        status: "invalid_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor?.error || "anchor.rubric_path did not resolve to a readable rubric file",
      }, rubricAnchor);
  }
}

function findAdvisoryArtifacts(runDir, round) {
  if (!runDir || !round || !fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir)
    .filter((entry) => entry.startsWith(`review-round-${round}-advisory-`) && entry.endsWith(".json"))
    .map((entry) => path.join(runDir, entry));
}

function readRunDirEvents(runDir) {
  const eventsPath = path.join(runDir, "events.jsonl");
  try {
    const stat = fs.lstatSync(eventsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("events.jsonl must be a regular file inside the run directory");
    }
    return fs.readFileSync(eventsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function findSuccessfulAdvisoryEvent(events, { artifactHash, artifactPath, reviewedHead, round }) {
  if (!artifactHash) return null;
  return events.find((event) => (
    event.event === "advisory_review" &&
    event.status === "success" &&
    Number(event.round || 0) === Number(round || 0) &&
    event.head_sha === reviewedHead &&
    Number(event.required_count || 0) === 0 &&
    samePath(event.artifact_path, artifactPath) &&
    event.advisory_artifact_hash === artifactHash
  ));
}

function hasTrustedExecutionEvidenceEvent(events, { runDir, reviewedHead }) {
  const evidencePath = path.join(runDir, "execution-evidence.json");
  const evidenceHash = hashFileSha256(evidencePath);
  if (!evidenceHash) return false;
  return events.some((event) => (
    (
      event.event === "dispatch_result" &&
      event.head_sha === reviewedHead &&
      samePath(event.execution_evidence_path, evidencePath) &&
      event.execution_evidence_hash === evidenceHash
    ) ||
    (
      event.event === "execution_evidence_rebranded" &&
      event.new_head_sha === reviewedHead &&
      samePath(event.execution_evidence_path, evidencePath) &&
      event.execution_evidence_hash === evidenceHash
    )
  ));
}

function readHardenedAdvisoryArtifact(artifactPath) {
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("advisory artifact must be a regular file inside the run directory");
  }
  return parseAdvisoryReview(fs.readFileSync(artifactPath, "utf-8"), { profile: "blindspot" });
}

function buildReviewAssuranceGateFailure({ prNumber, manifestData, runDir }) {
  if (!manifestData || !isHardenedReviewAssurance(manifestData)) return null;
  const round = Number(manifestData.review?.rounds || 0);
  const reviewedHead = manifestData.review?.last_reviewed_sha || null;
  let events;
  try {
    events = readRunDirEvents(runDir);
  } catch (error) {
    return {
      status: "invalid_hardened_advisory",
      pr: prNumber,
      readyToMerge: false,
      reason: `events.jsonl is not readable hardened provenance: ${error.message}`,
    };
  }
  const advisoryArtifacts = findAdvisoryArtifacts(runDir, round);
  if (advisoryArtifacts.length === 0) {
    return {
      status: "missing_hardened_advisory",
      pr: prNumber,
      readyToMerge: false,
      reason: "policy.review_assurance=hardened requires a successful advisory review artifact for the latest round.",
    };
  }
  for (const artifactPath of advisoryArtifacts) {
    try {
      const advisory = readHardenedAdvisoryArtifact(artifactPath);
      if (advisory.required_findings.length > 0) {
        return {
          status: "hardened_advisory_required_findings",
          pr: prNumber,
          readyToMerge: false,
          reason: `${path.basename(artifactPath)} contains ${advisory.required_findings.length} required finding(s).`,
        };
      }
      const artifactHash = hashFileSha256(artifactPath);
      if (!findSuccessfulAdvisoryEvent(events, { artifactHash, artifactPath, reviewedHead, round })) {
        return {
          status: "invalid_hardened_advisory",
          pr: prNumber,
          readyToMerge: false,
          reason: `${path.basename(artifactPath)} is not bound to a successful advisory_review event and artifact hash for the reviewed HEAD.`,
        };
      }
    } catch (error) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `${path.basename(artifactPath)} is not a valid advisory artifact: ${error.message}`,
      };
    }
  }

  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead,
    strict: true,
  });
  if (executionStatus.status !== "pass") {
    return {
      status: "hardened_execution_evidence_failed",
      pr: prNumber,
      readyToMerge: false,
      reason: executionStatus.reason || "strict execution evidence did not pass",
    };
  }
  if (!hasTrustedExecutionEvidenceEvent(events, { runDir, reviewedHead })) {
    return {
      status: "hardened_execution_evidence_failed",
      pr: prNumber,
      readyToMerge: false,
      reason: "strict execution evidence is not bound to a dispatch_result or execution_evidence_rebranded event for the reviewed HEAD.",
    };
  }
  return null;
}

function evaluateReviewGate({ prNumber, comments, commits, manifestData, expectedReviewerLogin, runDir }) {
  const commentRecords = normalizeCommentRecords(comments);
  const { latestCommit, latestCommitAt } = extractLatestCommit(commits);
  const rubricAnchor = manifestData
    ? getRubricAnchorStatus(manifestData, runDir ? { runDir } : undefined)
    : null;

  if (manifestData && !rubricAnchor.satisfied) {
    return buildRubricGateFailure(prNumber, rubricAnchor);
  }

  let lastReviewComment = null;
  let hasUnauthorizedReview = false;
  for (const comment of commentRecords) {
    if (hasRelayReviewMarker(comment.body || "")) {
      if (expectedReviewerLogin && comment.author?.toLowerCase() !== expectedReviewerLogin.toLowerCase()) {
        hasUnauthorizedReview = true;
        continue;
      }
      lastReviewComment = comment;
    }
  }

  if (!lastReviewComment) {
    if (hasUnauthorizedReview) {
      return withRubricNote({
        status: "unauthorized_reviewer",
        pr: prNumber,
        expectedReviewerLogin,
        readyToMerge: false,
      }, rubricAnchor);
    }
    return withRubricNote({ status: "missing", pr: prNumber, readyToMerge: false }, rubricAnchor);
  }

  const verdictMatch = lastReviewComment.body.match(/Verdict:\s*(LGTM|PASS|CHANGES_REQUESTED|ESCALATED)/);
  if (!verdictMatch) {
    return withRubricNote({ status: "missing", pr: prNumber, readyToMerge: false }, rubricAnchor);
  }

  const verdict = verdictMatch[1];
  if (verdict === "CHANGES_REQUESTED") {
    const issuesMatch = lastReviewComment.body.match(/Issues:\s*([\s\S]+)/);
    return withRubricNote({
      status: "changes_requested",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1].trim() : null,
      readyToMerge: false,
    }, rubricAnchor);
  }

  if (verdict === "ESCALATED") {
    const issuesMatch = lastReviewComment.body.match(/Issues?:\s*(.+?)(?:\n|$)/);
    return withRubricNote({
      status: "escalated",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1] : null,
      readyToMerge: false,
    }, rubricAnchor);
  }

  const reviewedSha = manifestData?.review?.last_reviewed_sha || null;
  if (manifestData && !reviewedSha) {
    return withRubricNote({
      status: "missing",
      pr: prNumber,
      readyToMerge: false,
      latestCommit,
      latestCommitAt,
    }, rubricAnchor);
  }

  if (manifestData && latestCommit && reviewedSha && latestCommit !== reviewedSha) {
    return withRubricNote({
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      reviewedSha,
      readyToMerge: false,
    }, rubricAnchor);
  }

  if (
    !manifestData &&
    latestCommitAt &&
    lastReviewComment.createdAt &&
    lastReviewComment.createdAt < latestCommitAt
  ) {
    return withRubricNote({
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      readyToMerge: false,
    }, rubricAnchor);
  }

  const assuranceFailure = buildReviewAssuranceGateFailure({ prNumber, manifestData, runDir });
  if (assuranceFailure) {
    return withRubricNote(assuranceFailure, rubricAnchor);
  }

  const roundMatch = lastReviewComment.body.match(/Rounds?:\s*(\d+)/);
  return withRubricNote({
    status: "lgtm",
    pr: prNumber,
    round: roundMatch ? roundMatch[1] : null,
    readyToMerge: true,
    reviewedAt: lastReviewComment.createdAt,
    latestCommit,
    latestCommitAt,
    reviewedSha,
  }, rubricAnchor);
}

module.exports = {
  buildSkipReviewGateFailure,
  buildSkipComment,
  evaluateReviewGate,
  hasRelayReviewMarker,
  normalizeCommentRecords,
  SKIP_AUDIT_RUBRIC_STATUSES,
  summarizeRubricAuditForSkip,
  summarizeRubricStatusForSkip,
  toIsoOrNull,
};
