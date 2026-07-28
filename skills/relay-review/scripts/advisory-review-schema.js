const {
  formatAdapterPhase,
} = require("../../relay-dispatch/scripts/agent-adapters/transport");
const {
  parsePossiblyWrappedReviewerJsonObject,
} = require("./reviewer-helpers");

const ADVISORY_PROFILES = Object.freeze(["blindspot", "adversarial"]);
const ADVISORY_TERMINAL_STATUSES = new Set(["failed", "policy_violation", "success", "timeout"]);
const ADVISORY_SEVERITIES = new Set(["P1", "P2", "P3"]);
const ADVISORY_CATEGORIES = new Set([
  "test-gap",
  "bypass",
  "edge-case",
  "integration",
  "docs",
  "other",
]);

function requireString(value, location) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function requireFinding(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const severity = requireString(value.severity, `${location}.severity`);
  const category = requireString(value.category, `${location}.category`);
  const confidence = value.confidence;
  if (!ADVISORY_SEVERITIES.has(severity)) {
    throw new Error(`${location}.severity must be one of: P1, P2, P3`);
  }
  if (!ADVISORY_CATEGORIES.has(category)) {
    throw new Error(`${location}.category must be one of: ${[...ADVISORY_CATEGORIES].join(", ")}`);
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${location}.confidence must be a number from 0 to 1`);
  }
  let line = null;
  if (value.line !== undefined && value.line !== null) {
    if (!Number.isInteger(value.line) || value.line <= 0) {
      throw new Error(`${location}.line must be a positive integer or null`);
    }
    line = value.line;
  }
  return {
    title: requireString(value.title, `${location}.title`),
    body: requireString(value.body, `${location}.body`),
    file: requireString(value.file, `${location}.file`),
    line,
    severity,
    category,
    confidence,
  };
}

function normalizeFindingArray(value, location) {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  return value.map((finding, index) => requireFinding(finding, `${location}[${index}]`));
}

function validateAdvisoryProfile(profile) {
  const normalized = String(profile || "blindspot").trim();
  if (!ADVISORY_PROFILES.includes(normalized)) {
    throw new Error(`Unknown advisory profile '${profile}'. Supported profiles: ${ADVISORY_PROFILES.join(", ")}`);
  }
  return normalized;
}

function normalizeAdvisoryJsonText(text) {
  const raw = String(text);
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```[ \t]*json[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*$/i);
  return fenced ? fenced[1].trim() : raw;
}

function rethrowWithContext(error, context) {
  const message = error?.message || String(error);
  if (message.startsWith(`${context} `)) {
    throw error;
  }
  throw new Error(`${context} ${message}`);
}

function parseAdvisoryReview(text, {
  adapter = "advisory",
  phase = "advisory_review",
  profile = "blindspot",
  requireExplicitProfile = false,
} = {}) {
  const expectedProfile = validateAdvisoryProfile(profile);
  const context = formatAdapterPhase({ adapter, phase });
  try {
    const parsed = parsePossiblyWrappedReviewerJsonObject(normalizeAdvisoryJsonText(text), {
      adapter,
      phase,
      description: "advisory review",
    });
    const missingProfile = (
      parsed.profile === undefined ||
      parsed.profile === null ||
      (typeof parsed.profile === "string" && !parsed.profile.trim())
    );
    if (requireExplicitProfile && missingProfile) {
      throw new Error("profile must be explicitly provided");
    }
    const actualProfile = missingProfile
      ? expectedProfile
      : requireString(parsed.profile, "profile");
    if (actualProfile !== expectedProfile) {
      throw new Error(`profile must be '${expectedProfile}', got '${actualProfile}'`);
    }
    return {
      profile: actualProfile,
      summary: requireString(parsed.summary, "summary"),
      required_findings: normalizeFindingArray(parsed.required_findings, "required_findings"),
      advisory_findings: normalizeFindingArray(parsed.advisory_findings, "advisory_findings"),
      duplicate_or_low_confidence: normalizeFindingArray(parsed.duplicate_or_low_confidence, "duplicate_or_low_confidence"),
    };
  } catch (error) {
    rethrowWithContext(error, context);
  }
}

function nonNegativeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function advisoryLaneKey(value) {
  return [
    Number(value?.lane_index || value?.laneIndex || 0),
    value?.reviewer || "unknown-reviewer",
    value?.trigger || "every_round",
  ].join(":");
}

function advisoryOutcomeForStatus(status, counts) {
  if (status === "success") {
    return counts.required_count + counts.advisory_count + counts.duplicate_low_confidence_count > 0
      ? "findings"
      : "clean";
  }
  if (status === "timeout") return "timed_out";
  if (status === "failed") return "failed";
  if (status === "policy_violation") return "policy_violation";
  if (status === "deferred") return "deferred";
  if (status === "running") return "running";
  return "not_run";
}

function toAdvisoryLaneEvidence(value = {}) {
  const counts = {
    required_count: nonNegativeCount(value.required_count),
    advisory_count: nonNegativeCount(value.advisory_count),
    duplicate_low_confidence_count: nonNegativeCount(value.duplicate_low_confidence_count),
  };
  const status = typeof value.status === "string" && value.status.trim()
    ? value.status.trim()
    : "not_run";
  return {
    lane_index: nonNegativeCount(value.lane_index || value.laneIndex) || 1,
    reviewer: typeof value.reviewer === "string" && value.reviewer.trim()
      ? value.reviewer.trim()
      : "unknown",
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : null,
    profile: typeof value.profile === "string" && value.profile.trim()
      ? value.profile.trim()
      : "blindspot",
    trigger: typeof value.trigger === "string" && value.trigger.trim()
      ? value.trigger.trim()
      : "every_round",
    gating: value.gating === true,
    status,
    outcome: advisoryOutcomeForStatus(status, counts),
    ran: status === "success",
    failure_reason: typeof value.failureReason === "string" && value.failureReason.trim()
      ? value.failureReason.trim()
      : typeof value.failure_reason === "string" && value.failure_reason.trim()
        ? value.failure_reason.trim()
        : null,
    completed_at: typeof value.completed_at === "string" && value.completed_at.trim()
      ? value.completed_at.trim()
      : null,
    ...counts,
  };
}

function overallAdvisoryStatus(configuredCount, outcomes) {
  if (configuredCount === 0) return "not_configured";
  if (outcomes.length < configuredCount || outcomes.some((entry) => !ADVISORY_TERMINAL_STATUSES.has(entry.status))) {
    return "incomplete";
  }
  if (outcomes.every((entry) => entry.outcome === "clean")) return "clean";
  if (outcomes.every((entry) => entry.status === "success")) return "findings";
  if (outcomes.every((entry) => entry.status === "timeout")) return "timed_out";
  if (outcomes.every((entry) => entry.status !== "success")) return "failed";
  return "partial";
}

function buildAdvisoryRoundEvidence({
  configuredCount = 0,
  headSha = null,
  outcomes = [],
  round,
} = {}) {
  const normalizedOutcomes = (outcomes || []).filter(Boolean).map(toAdvisoryLaneEvidence);
  const normalizedConfiguredCount = Math.max(
    nonNegativeCount(configuredCount),
    normalizedOutcomes.length,
  );
  return {
    round: nonNegativeCount(round),
    head_sha: typeof headSha === "string" && headSha.trim() ? headSha.trim() : null,
    configured_count: normalizedConfiguredCount,
    status: overallAdvisoryStatus(normalizedConfiguredCount, normalizedOutcomes),
    outcomes: normalizedOutcomes,
  };
}

function evidenceRank(outcome) {
  if (ADVISORY_TERMINAL_STATUSES.has(outcome?.status)) return 3;
  if (outcome?.status === "deferred") return 2;
  if (outcome?.status === "running") return 1;
  return 0;
}

function preferAdvisoryOutcome(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftRank = evidenceRank(left);
  const rightRank = evidenceRank(right);
  if (rightRank !== leftRank) return rightRank > leftRank ? right : left;
  if (right.completed_at && (!left.completed_at || right.completed_at >= left.completed_at)) return right;
  return left;
}

function mergeAdvisoryRoundEvidence(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  const leftRound = nonNegativeCount(left.round);
  const rightRound = nonNegativeCount(right.round);
  if (leftRound !== rightRound) return rightRound > leftRound ? right : left;
  if (left.head_sha && right.head_sha && left.head_sha !== right.head_sha) return right;

  const merged = new Map();
  for (const outcome of left.outcomes || []) {
    const normalized = toAdvisoryLaneEvidence(outcome);
    merged.set(advisoryLaneKey(normalized), normalized);
  }
  for (const outcome of right.outcomes || []) {
    const normalized = toAdvisoryLaneEvidence(outcome);
    const key = advisoryLaneKey(normalized);
    merged.set(key, preferAdvisoryOutcome(merged.get(key), normalized));
  }
  return buildAdvisoryRoundEvidence({
    configuredCount: Math.max(
      nonNegativeCount(left.configured_count),
      nonNegativeCount(right.configured_count),
    ),
    headSha: right.head_sha || left.head_sha || null,
    outcomes: Array.from(merged.values()).sort((a, b) => a.lane_index - b.lane_index),
    round: rightRound || leftRound,
  });
}

function formatAdvisoryRoundSummary(evidence) {
  if (!evidence || evidence.configured_count === 0) {
    return ["- No advisory reviewer was configured; advisory did not run."];
  }
  const lines = (evidence.outcomes || []).map((entry) => {
    const label = `${entry.reviewer} (lane ${entry.lane_index}, ${entry.trigger})`;
    if (entry.outcome === "clean") return `- ${label}: advisory ran and found nothing.`;
    if (entry.outcome === "findings") {
      return (
        `- ${label}: advisory ran and reported required=${entry.required_count}, ` +
        `advisory=${entry.advisory_count}, duplicate/low-confidence=${entry.duplicate_low_confidence_count}.`
      );
    }
    if (entry.outcome === "timed_out") {
      return `- ${label}: advisory did not run to completion (timed out)${entry.failure_reason ? ` — ${entry.failure_reason}` : "."}`;
    }
    if (entry.outcome === "failed" || entry.outcome === "policy_violation") {
      return `- ${label}: advisory did not run to completion (${entry.outcome})${entry.failure_reason ? ` — ${entry.failure_reason}` : "."}`;
    }
    if (entry.outcome === "deferred") {
      return `- ${label}: advisory did not complete before this round summary (deferred).`;
    }
    if (entry.outcome === "running") return `- ${label}: advisory was still running when this round was summarized.`;
    return `- ${label}: advisory did not run.`;
  });
  while (lines.length < evidence.configured_count) {
    lines.push("- Configured advisory lane had no execution evidence; advisory did not run.");
  }
  return lines;
}

module.exports = {
  ADVISORY_PROFILES,
  buildAdvisoryRoundEvidence,
  formatAdvisoryRoundSummary,
  mergeAdvisoryRoundEvidence,
  normalizeAdvisoryJsonText,
  parseAdvisoryReview,
  toAdvisoryLaneEvidence,
  validateAdvisoryProfile,
};
