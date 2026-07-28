const fs = require("fs");
const path = require("path");
const { hashFileSha256 } = require("../../relay-dispatch/scripts/execution-evidence");
const { getRubricAnchorStatus } = require("../../relay-dispatch/scripts/manifest/rubric");
const { isHardenedReviewAssurance } = require("../../relay-dispatch/scripts/manifest/review-assurance");
const { parseAdvisoryReview } = require("../../relay-review/scripts/advisory-review-schema");
const {
  createAdvisoryConfigSnapshot,
  resolveAdvisoryConfig,
} = require("../../relay-review/scripts/review-runner/advisory-orchestration");
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

function extractLatestCommit(commits, headRefOid) {
  const commitList = commits || [];

  if (headRefOid) {
    const headCommit = commitList.find((commit) => commit.oid === headRefOid);
    if (headCommit) {
      return {
        latestCommit: headCommit.oid,
        latestCommitAt: toIsoOrNull(headCommit.committedDate || headCommit.authoredDate),
      };
    }
  }

  // Fallback scan: use >= so that on committedDate ties (e.g. after a rebase
  // collapses timestamps to the same second) the later array entry wins,
  // which for `gh pr view --json commits` is the entry closer to HEAD.
  let latestCommit = null;
  let latestCommitAt = null;
  for (const commit of commitList) {
    const committedAt = toIsoOrNull(commit.committedDate || commit.authoredDate);
    if (committedAt && (!latestCommitAt || committedAt >= latestCommitAt)) {
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

function advisoryLaneKey(event) {
  const reviewer = typeof event?.reviewer === "string" ? event.reviewer.trim() : "";
  const laneIndex = Number.isInteger(event?.lane_index) && event.lane_index > 0
    ? event.lane_index
    : "legacy";
  return `${reviewer}\u0000${laneIndex}`;
}

function readRunRoutePlan(runDir) {
  const routePlanPath = path.join(runDir, "route-plan.json");
  try {
    const stat = fs.lstatSync(routePlanPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("route-plan.json must be a regular file inside the run directory");
    }
    return JSON.parse(fs.readFileSync(routePlanPath, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function findAdvisoryConfigSnapshot(events, round, reviewedHead) {
  const snapshotEvents = events.filter((event) => (
    event.event === "advisory_review" &&
    Number(event.round) === round &&
    (
      event.advisory_lanes !== undefined ||
      event.advisory_config_hash !== undefined
    )
  ));
  if (snapshotEvents.length === 0) return null;
  const event = snapshotEvents.at(-1);
  if (event.head_sha !== reviewedHead) {
    throw new Error(`latest advisory lane configuration is not bound to reviewed HEAD ${reviewedHead}`);
  }
  if (!Array.isArray(event.advisory_lanes) || typeof event.advisory_config_hash !== "string") {
    throw new Error("latest advisory lane configuration is incomplete");
  }
  const snapshot = createAdvisoryConfigSnapshot({
    headSha: event.head_sha,
    lanes: event.advisory_lanes,
    round: event.round,
  });
  if (snapshot.advisory_config_hash !== event.advisory_config_hash) {
    throw new Error("latest advisory lane configuration hash does not match its round/HEAD-bound snapshot");
  }
  return snapshot;
}

function findExpectedAdvisoryLanes(manifestData, routePlan, snapshot = null) {
  if (snapshot) {
    return snapshot.lanes.map((lane) => ({
      gating: lane.gating,
      lane_index: lane.lane_index,
      profile: lane.profile,
      reviewer: lane.reviewer,
    }));
  }
  const { lanes } = resolveAdvisoryConfig({
    data: manifestData,
    routePlan,
  });
  return lanes.map((lane) => ({
    gating: lane.gating,
    lane_index: lane.index,
    profile: lane.profile,
    reviewer: lane.reviewer,
  }));
}

function findLatestRequiredAdvisoryEvents(events, round, reviewedHead, manifestData, routePlan) {
  const latestByLane = new Map();
  const gatingLanes = new Set();
  for (const event of events) {
    if (event.event !== "advisory_review" || Number(event.round) !== round) continue;
    const laneKey = advisoryLaneKey(event);
    latestByLane.set(laneKey, event);
    if (event.gating === true) gatingLanes.add(laneKey);
  }
  const snapshot = findAdvisoryConfigSnapshot(events, round, reviewedHead);
  const expectedLanes = findExpectedAdvisoryLanes(manifestData, routePlan, snapshot);
  if (expectedLanes.length > 0) {
    return expectedLanes.map((expectedLane) => ({
      event: latestByLane.get(advisoryLaneKey(expectedLane)) || null,
      expectedLane,
      expectedConfigHash: snapshot?.advisory_config_hash || null,
    }));
  }
  if (gatingLanes.size > 0) {
    return [...gatingLanes].map((laneKey) => ({
      event: latestByLane.get(laneKey),
      expectedLane: null,
      expectedConfigHash: null,
    }));
  }
  // Events written before advisory lanes were configured represent a single
  // implicit hardened lane. Preserve that historical contract by validating
  // every latest legacy lane when no configured lane exists.
  return [...latestByLane.values()].map((event) => ({
    event,
    expectedLane: null,
    expectedConfigHash: null,
  }));
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
    ) ||
    (
      event.event === "operator_execution_evidence" &&
      event.head_sha === reviewedHead &&
      samePath(event.execution_evidence_path, evidencePath) &&
      event.execution_evidence_hash === evidenceHash
    )
  ));
}

function isPathContained(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function readHardenedAdvisoryArtifact(runDir, artifactPath, profile) {
  if (!runDir || !artifactPath) {
    throw new Error("advisory event must bind an artifact path inside the run directory");
  }
  const resolvedRunDir = path.resolve(runDir);
  const resolvedArtifactPath = path.resolve(artifactPath);
  if (!isPathContained(resolvedRunDir, resolvedArtifactPath)) {
    throw new Error("advisory artifact path must be contained in the run directory");
  }
  const stat = fs.lstatSync(resolvedArtifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("advisory artifact must be a regular file inside the run directory");
  }
  const realRunDir = fs.realpathSync(resolvedRunDir);
  const realArtifactPath = fs.realpathSync(resolvedArtifactPath);
  if (!isPathContained(realRunDir, realArtifactPath)) {
    throw new Error("advisory artifact must not resolve outside the run directory");
  }
  return {
    advisory: parseAdvisoryReview(fs.readFileSync(resolvedArtifactPath, "utf-8"), {
      profile,
      requireExplicitProfile: true,
    }),
    artifactPath: resolvedArtifactPath,
  };
}

function buildReviewAssuranceGateFailure({ prNumber, manifestData, runDir }) {
  if (!manifestData || !isHardenedReviewAssurance(manifestData)) return null;
  const round = Number(manifestData.review?.rounds || 0);
  const reviewedHead = manifestData.review?.last_reviewed_sha || null;
  let events;
  let routePlan;
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
  try {
    routePlan = readRunRoutePlan(runDir);
  } catch (error) {
    return {
      status: "invalid_hardened_advisory",
      pr: prNumber,
      readyToMerge: false,
      reason: `route-plan.json is not readable hardened configuration: ${error.message}`,
    };
  }
  let advisoryEvents;
  try {
    advisoryEvents = findLatestRequiredAdvisoryEvents(
      events,
      round,
      reviewedHead,
      manifestData,
      routePlan,
    );
  } catch (error) {
    return {
      status: "invalid_hardened_advisory",
      pr: prNumber,
      readyToMerge: false,
      reason: `hardened advisory lane configuration is invalid: ${error.message}`,
    };
  }
  if (advisoryEvents.length === 0) {
    return {
      status: "missing_hardened_advisory",
      pr: prNumber,
      readyToMerge: false,
      reason: "policy.review_assurance=hardened requires a durable advisory_review event for the latest round.",
    };
  }
  for (const { event, expectedLane, expectedConfigHash } of advisoryEvents) {
    if (!event) {
      const expectedReviewer = expectedLane.reviewer || "unknown reviewer";
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Required hardened advisory lane ${expectedReviewer} lane ${expectedLane.lane_index} has no advisory_review event for round ${round}.`,
      };
    }
    const reviewer = typeof event?.reviewer === "string" && event.reviewer.trim()
      ? event.reviewer.trim()
      : "unknown reviewer";
    const lane = Number.isInteger(event?.lane_index) && event.lane_index > 0
      ? ` lane ${event.lane_index}`
      : "";
    const eventLabel = `${reviewer}${lane}`;
    if (expectedConfigHash && event.advisory_config_hash !== expectedConfigHash) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for required hardened lane ${eventLabel} is not bound to the round's effective advisory configuration.`,
      };
    }
    if (expectedLane?.gating === true && event.gating !== true) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for configured gating lane ${eventLabel} is not marked as gating.`,
      };
    }
    if (event.gating === true && (reviewer === "unknown reviewer" || !lane)) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Gating advisory event ${eventLabel} does not have a stable reviewer and lane identity.`,
      };
    }
    if (event.status !== "success" || event.head_sha !== reviewedHead || Number(event.round) !== round) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for ${eventLabel} is not a successful review of round ${round} at ${reviewedHead}.`,
      };
    }
    if (event.required_count !== 0) {
      if (Number.isInteger(event.required_count) && event.required_count > 0) {
        return {
          status: "hardened_advisory_required_findings",
          pr: prNumber,
          readyToMerge: false,
          reason: `Latest advisory event for ${eventLabel} reports ${event.required_count} required finding(s).`,
        };
      }
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for ${eventLabel} does not record a zero required finding count.`,
      };
    }
    if (typeof event.profile !== "string" || !event.profile.trim()) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for ${eventLabel} does not bind an advisory profile.`,
      };
    }
    if (expectedLane && (!expectedLane.profile || event.profile !== expectedLane.profile)) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Latest advisory event for required hardened lane ${eventLabel} binds profile '${event.profile}' instead of configured profile '${expectedLane.profile || "missing"}'.`,
      };
    }
    try {
      const { advisory, artifactPath } = readHardenedAdvisoryArtifact(
        runDir,
        event.artifact_path,
        event.profile,
      );
      if (!samePath(event.artifact_path, artifactPath)) {
        throw new Error("advisory artifact path does not match its advisory_review event");
      }
      if (advisory.profile !== event.profile) {
        throw new Error(`advisory artifact profile '${advisory.profile}' does not match event profile '${event.profile}'`);
      }
      if (advisory.required_findings.length > 0) {
        return {
          status: "hardened_advisory_required_findings",
          pr: prNumber,
          readyToMerge: false,
          reason: `${path.basename(artifactPath)} contains ${advisory.required_findings.length} required finding(s).`,
        };
      }
      const artifactHash = hashFileSha256(artifactPath);
      if (!artifactHash || event.advisory_artifact_hash !== artifactHash) {
        return {
          status: "invalid_hardened_advisory",
          pr: prNumber,
          readyToMerge: false,
          reason: `${path.basename(artifactPath)} does not match the SHA-256 hash bound by its advisory_review event.`,
        };
      }
    } catch (error) {
      return {
        status: "invalid_hardened_advisory",
        pr: prNumber,
        readyToMerge: false,
        reason: `Advisory artifact for ${eventLabel} is not valid bound evidence: ${error.message}`,
      };
    }
  }

  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead,
    strict: true,
    manifestData,
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
      reason: "strict execution evidence is not bound to a dispatch_result, execution_evidence_rebranded, or operator_execution_evidence event for the reviewed HEAD.",
    };
  }
  return null;
}

function evaluateReviewGate({ prNumber, comments, commits, manifestData, expectedReviewerLogin, runDir, headRefOid }) {
  const commentRecords = normalizeCommentRecords(comments);
  const { latestCommit, latestCommitAt } = extractLatestCommit(commits, headRefOid);
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
