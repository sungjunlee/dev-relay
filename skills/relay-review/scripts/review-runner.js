#!/usr/bin/env node
/**
 * Script-managed relay review runner.
 *
 * Prepares a review prompt bundle for an isolated reviewer and applies a
 * structured verdict back into the relay manifest and PR audit trail.
 *
 * Usage:
 *   ./review-runner.js --repo <path> --run-id <id> [options]
 *   ./review-runner.js --repo <path> --branch <name> [options]
 *   ./review-runner.js --repo <path> --pr <number> [options]
 *
 * Options:
 *   --repo <path>                Repository root (default: .)
 *   --run-id <id>                Relay run identifier
 *   --branch <name>              Working branch
 *   --pr <number>                PR number
 *   --manifest <path>            Explicit manifest path
 *   --done-criteria-file <path>  Use fixture file instead of gh issue fetch
 *   --diff-file <path>           Use fixture file instead of gh pr diff
 *   --review-file <path>         Structured reviewer JSON verdict to apply
 *   --reviewer <name>            Reviewer adapter to invoke (codex|claude|...)
 *   --reviewer-script <path>     Override adapter script path
 *   --reviewer-model <name>      Reviewer model override
 *   --prepare-only               Emit prompt bundle only; do not apply verdict
 *   --no-comment                 Do not post a PR comment
 *   --json                       Output JSON
 *   --help, -h                   Show usage
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { REVIEW_VERDICT_JSON_SCHEMA } = require("./review-schema");
const {
  STATES,
  ensureRunLayout,
  getRunDir,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { appendRunEvent } = require("../../relay-dispatch/scripts/relay-events");

const REVIEWER_PROMPT_PATH = path.join(__dirname, "..", "references", "reviewer-prompt.md");
const REVIEW_MARKER = "<!-- relay-review -->";
const REVIEW_ROUND_MARKER = "<!-- relay-review-round -->";
const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_STATUSES = new Set(["pass", "fail", "not_run"]);

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--run-id", "--branch", "--pr", "--manifest", "--done-criteria-file",
  "--diff-file", "--review-file", "--reviewer", "--reviewer-script",
  "--reviewer-model", "--prepare-only", "--no-comment",
  "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: review-runner.js --repo <path> (--run-id <id> | --branch <name> | --pr <number>) [options]");
  console.log("\nPrepare or apply a structured relay review round.");
  console.log("\nOptions:");
  console.log("  --repo <path>                Repository root (default: .)");
  console.log("  --run-id <id>                Relay run identifier");
  console.log("  --branch <name>              Working branch");
  console.log("  --pr <number>                PR number");
  console.log("  --manifest <path>            Explicit manifest path");
  console.log("  --done-criteria-file <path>  Use fixture file instead of gh issue fetch");
  console.log("  --diff-file <path>           Use fixture file instead of gh pr diff");
  console.log("  --review-file <path>         Structured reviewer JSON verdict to apply");
  console.log("  --reviewer <name>            Reviewer adapter to invoke (codex|claude|...)");
  console.log("  --reviewer-script <path>     Override adapter script path");
  console.log("  --reviewer-model <name>      Reviewer model override");
  console.log("  --prepare-only               Emit prompt bundle only; do not apply verdict");
  console.log("  --no-comment                 Do not post a PR comment");
  console.log("  --json                       Output JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function getArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return KNOWN_FLAGS.includes(value) ? undefined : value;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function gh(repoPath, ...ghArgs) {
  return execFileSync("gh", ghArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function git(repoPath, ...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function parsePositiveInt(value, label) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

function resolvePrForBranch(repoPath, branch) {
  const raw = gh(repoPath, "pr", "list", "--head", branch, "--json", "number");
  const parsed = JSON.parse(raw);
  const match = parsed[0];
  return match ? Number(match.number) : null;
}

function resolveBranchForPr(repoPath, prNumber) {
  const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "headRefName");
  return JSON.parse(raw).headRefName;
}

function resolveIssueNumber(repoPath, prNumber, branch, manifestData) {
  if (manifestData?.issue?.number) {
    return Number(manifestData.issue.number);
  }

  if (!prNumber) return null;

  const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "closingIssuesReferences,body,headRefName");
  const parsed = JSON.parse(raw);
  const closingIssue = (parsed.closingIssuesReferences || [])[0];
  if (closingIssue?.number) return Number(closingIssue.number);

  const bodyMatch = String(parsed.body || "").match(/(?:closes|fixes|resolves|refs|related to)\s+#(\d+)/i);
  if (bodyMatch) return Number(bodyMatch[1]);

  const branchSource = branch || parsed.headRefName || "";
  const issueMatch = branchSource.match(/issue-(\d+)/);
  return issueMatch ? Number(issueMatch[1]) : null;
}

function loadDoneCriteria(repoPath, issueNumber, prNumber, doneCriteriaFile) {
  if (doneCriteriaFile) return readText(doneCriteriaFile).trim();

  const errors = [];

  // Fallback 1: GitHub issue body
  if (issueNumber) {
    try {
      const raw = gh(repoPath, "issue", "view", String(issueNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const text = `# Issue #${parsed.number}: ${parsed.title}\n\n${String(parsed.body || "").trim()}`.trim();
      if (text) return text;
    } catch (e) {
      errors.push(`issue #${issueNumber}: ${e.message.split("\n")[0]}`);
    }
  }

  // Fallback 2: PR description (executors often paste AC into the PR body)
  if (prNumber) {
    try {
      const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const body = String(parsed.body || "").trim();
      if (body) return `# PR #${parsed.number}: ${parsed.title}\n\n${body}`.trim();
    } catch (e) {
      errors.push(`PR #${prNumber}: ${e.message.split("\n")[0]}`);
    }
  }

  const detail = errors.length ? ` Attempted: ${errors.join("; ")}` : "";
  throw new Error(
    `Cannot resolve Done Criteria: no issue, no PR description.${detail} ` +
    "Provide --done-criteria-file for tasks without a GitHub issue."
  );
}

function loadDiff(repoPath, prNumber, diffFile) {
  if (diffFile) return readText(diffFile).trim();
  if (!prNumber) {
    throw new Error("PR number is required to fetch a diff. Provide --diff-file for fixture-based runs.");
  }
  return gh(repoPath, "pr", "diff", String(prNumber)).trim();
}

function formatPriorRoundContext(runDir, round) {
  if (!runDir || round <= 1) return "";
  const verdicts = readPriorVerdicts(runDir, round);
  if (!verdicts.length) return "";

  const lines = verdicts.map((v, i) => {
    const roundNum = verdicts.length - i;
    const parts = [`### Round ${roundNum}: ${v.verdict}`, v.summary];
    if (Array.isArray(v.issues) && v.issues.length) {
      parts.push("Issues flagged:", formatIssueList(v.issues));
    }
    return parts.join("\n");
  });

  return ["## Prior Round Context", "", "Verify whether prior issues were resolved.", "", ...lines].join("\n");
}

function buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, diffText, runDir }) {
  const template = readText(REVIEWER_PROMPT_PATH)
    .replace("[PASTE DONE CRITERIA HERE]", doneCriteria)
    .replace("[PASTE PR DIFF OR FILE PATH HERE]", diffText);

  const sections = [
    `# Relay Review Round ${round}`,
    "",
    `PR: #${prNumber || "unknown"}`,
    `Branch: ${branch || "unknown"}`,
    `Issue: ${issueNumber || "unknown"}`,
    "",
    template,
  ];

  const priorContext = formatPriorRoundContext(runDir, round);
  if (priorContext) {
    sections.push("", priorContext);
  }

  sections.push(
    "",
    "## Structured Output",
    "Return ONLY valid JSON. Do not wrap it in markdown fences.",
    "",
    JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA, null, 2),
    "",
    "Validation rules:",
    '- If `verdict` is `pass`, then `issues` must be `[]` and `next_action` must be `ready_to_merge`.',
    '- If `verdict` is `pass`, set both `contract_status` and `quality_status` to `pass`.',
    '- If `verdict` is `changes_requested`, include actionable issues with `file` and `line`, and set `next_action` to `changes_requested`.',
    '- If `verdict` is `escalated`, include the blocking issues or reason that automation should stop, and set `next_action` to `escalated`.',
    '- If no Score Log is available, set `rubric_scores` to `[]`.',
    '- When `rubric_scores` is not empty, each entry must include `factor`, `target`, `observed`, `status`, and `notes`.',
    '- `scope_drift` is always required. Set `scope_drift.creep` to `[]` if no out-of-scope changes. Set `scope_drift.missing` to list each Done Criteria item with status `verified`, `partial`, `not_done`, or `changed`.',
    '- If `scope_drift.missing` contains any `not_done` or `changed` entries, verdict cannot be `pass`.',
  );

  return sections.join("\n");
}

function parseReviewVerdict(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Review verdict must be valid JSON: ${error.message}`);
  }
  return validateReviewVerdict(parsed);
}

function validateIssue(issue, index) {
  const location = `issues[${index}]`;
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error(`${location} must be an object`);
  }
  for (const key of ["title", "body", "file", "category", "severity"]) {
    if (!String(issue[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!Number.isInteger(issue.line) || issue.line <= 0) {
    throw new Error(`${location}.line must be a positive integer`);
  }
}

function validateRubricScore(score, index) {
  const location = `rubric_scores[${index}]`;
  if (!score || typeof score !== "object" || Array.isArray(score)) {
    throw new Error(`${location} must be an object`);
  }
  for (const key of ["factor", "target", "observed", "notes"]) {
    if (!String(score[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!ALLOWED_STATUSES.has(score.status)) {
    throw new Error(`${location}.status must be one of: ${Array.from(ALLOWED_STATUSES).join(", ")}`);
  }
}

const ALLOWED_DRIFT_STATUSES = new Set(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.missing.items.properties.status.enum
);

function validateScopeDrift(scopeDrift) {
  if (!scopeDrift || typeof scopeDrift !== "object" || Array.isArray(scopeDrift)) {
    throw new Error("scope_drift must be an object with creep and missing arrays");
  }
  if (!Array.isArray(scopeDrift.creep)) {
    throw new Error("scope_drift.creep must be an array");
  }
  if (!Array.isArray(scopeDrift.missing)) {
    throw new Error("scope_drift.missing must be an array");
  }
  scopeDrift.creep.forEach((entry, i) => {
    if (!String(entry.file || "").trim()) throw new Error(`scope_drift.creep[${i}].file is required`);
    if (!String(entry.reason || "").trim()) throw new Error(`scope_drift.creep[${i}].reason is required`);
  });
  scopeDrift.missing.forEach((entry, i) => {
    if (!String(entry.criteria || "").trim()) throw new Error(`scope_drift.missing[${i}].criteria is required`);
    if (!ALLOWED_DRIFT_STATUSES.has(entry.status)) {
      throw new Error(`scope_drift.missing[${i}].status must be one of: ${Array.from(ALLOWED_DRIFT_STATUSES).join(", ")}`);
    }
  });
}

function validateReviewVerdict(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Review verdict must be a JSON object");
  }

  if (!ALLOWED_VERDICTS.has(data.verdict)) {
    throw new Error(`Invalid review verdict: ${data.verdict}`);
  }
  if (!String(data.summary || "").trim()) {
    throw new Error("Review verdict summary is required");
  }
  if (!ALLOWED_STATUSES.has(data.contract_status)) {
    throw new Error(`Invalid contract_status: ${data.contract_status}`);
  }
  if (!ALLOWED_STATUSES.has(data.quality_status)) {
    throw new Error(`Invalid quality_status: ${data.quality_status}`);
  }
  if (!ALLOWED_NEXT_ACTIONS.has(data.next_action)) {
    throw new Error(`Invalid next_action: ${data.next_action}`);
  }
  if (!Array.isArray(data.issues)) {
    throw new Error("Review verdict issues must be an array");
  }
  if (!Array.isArray(data.rubric_scores)) {
    throw new Error("Review verdict rubric_scores must be an array");
  }
  data.issues.forEach(validateIssue);
  data.rubric_scores.forEach(validateRubricScore);
  validateScopeDrift(data.scope_drift);

  if (data.verdict === "pass") {
    if (data.next_action !== "ready_to_merge") {
      throw new Error("PASS verdict must set next_action=ready_to_merge");
    }
    if (data.contract_status !== "pass" || data.quality_status !== "pass") {
      throw new Error("PASS verdict requires contract_status=pass and quality_status=pass");
    }
    if (data.issues.length !== 0) {
      throw new Error("PASS verdict must not include issues");
    }
    const blockingDrift = (data.scope_drift?.missing || []).filter(
      (m) => m.status === "not_done" || m.status === "changed"
    );
    if (blockingDrift.length > 0) {
      throw new Error(
        `PASS verdict cannot have scope_drift.missing entries with status not_done or changed: ${blockingDrift.map((m) => m.criteria).join(", ")}`
      );
    }
  } else if (data.verdict === "changes_requested") {
    if (data.next_action !== "changes_requested") {
      throw new Error("changes_requested verdict must set next_action=changes_requested");
    }
    if (data.issues.length === 0) {
      throw new Error("changes_requested verdict must include at least one issue");
    }
  } else if (data.verdict === "escalated") {
    if (data.next_action !== "escalated") {
      throw new Error("escalated verdict must set next_action=escalated");
    }
    if (data.issues.length === 0) {
      throw new Error("escalated verdict must include at least one issue");
    }
  }

  return data;
}

function formatIssueList(issues) {
  return issues.map((issue) => `- ${issue.file}:${issue.line} — ${issue.title}: ${issue.body}`).join("\n");
}

function buildCommentBody(verdict, round) {
  if (verdict.verdict === "pass") {
    return [
      REVIEW_MARKER,
      "## Relay Review",
      "Verdict: LGTM",
      `Summary: ${verdict.summary}`,
      `Contract: ${verdict.contract_status.toUpperCase()}`,
      `Quality: ${verdict.quality_status.toUpperCase()}`,
      `Rounds: ${round}`,
    ].join("\n");
  }

  if (verdict.verdict === "changes_requested") {
    return [
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${verdict.summary}`,
      "Issues:",
      formatIssueList(verdict.issues),
    ].join("\n");
  }

  return [
    REVIEW_MARKER,
    "## Relay Review",
    "Verdict: ESCALATED",
    `Summary: ${verdict.summary}`,
    `Rounds: ${round}`,
    "Issues:",
    formatIssueList(verdict.issues),
  ].join("\n");
}

function formatPriorVerdictSummary(verdicts) {
  if (!verdicts.length) return "";
  const lines = verdicts.map((v, i) => {
    const roundNum = verdicts.length - i;
    const issueCount = Array.isArray(v.issues) ? v.issues.length : 0;
    const rubricSummary = Array.isArray(v.rubric_scores) && v.rubric_scores.length
      ? v.rubric_scores.map((s) => `${s.factor}: ${s.observed} (target ${s.target}, ${s.status})`).join("; ")
      : "no rubric scores";
    return `- Round ${roundNum}: ${v.verdict} — ${v.summary} [${issueCount} issue(s), ${rubricSummary}]`;
  });
  return ["Prior review rounds:", ...lines].join("\n");
}

function formatScopeDrift(scopeDrift) {
  if (!scopeDrift) return "";
  const parts = [];
  if (scopeDrift.creep && scopeDrift.creep.length) {
    parts.push("Scope creep (revert these out-of-scope changes):");
    parts.push(...scopeDrift.creep.map((c) => `- ${c.file}: ${c.reason}`));
  }
  if (scopeDrift.missing && scopeDrift.missing.length) {
    const actionable = scopeDrift.missing.filter((m) => m.status !== "verified");
    if (actionable.length) {
      parts.push("Missing/incomplete requirements:");
      parts.push(...actionable.map((m) => `- [${m.status.toUpperCase()}] ${m.criteria}`));
    }
  }
  return parts.join("\n");
}

function buildRedispatchPrompt(verdict, doneCriteria, runDir, round) {
  const sections = [
    `This is round ${round + 1}. Fix these review issues in the PR. Do not change anything else. Push to the same branch.`,
    "",
    "Issues to fix:",
    formatIssueList(verdict.issues),
  ];

  const driftText = formatScopeDrift(verdict.scope_drift);
  if (driftText) {
    sections.push("", driftText);
  }

  if (runDir && round > 1) {
    const priorVerdicts = readPriorVerdicts(runDir, round);
    const priorSummary = formatPriorVerdictSummary(priorVerdicts);
    if (priorSummary) {
      sections.push("", priorSummary);
    }
  }

  sections.push(
    "",
    "Original Done Criteria (scope anchor):",
    doneCriteria,
  );

  return sections.join("\n");
}

function normalizeFingerprintPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function fingerprintIssue(issue) {
  return [
    normalizeFingerprintPart(issue.file),
    String(issue.line),
    normalizeFingerprintPart(issue.category),
    normalizeFingerprintPart(issue.title),
  ].join("|");
}

function readPriorVerdicts(runDir, currentRound) {
  const verdicts = [];
  for (let round = currentRound - 1; round >= 1; round -= 1) {
    const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
    if (!fs.existsSync(verdictPath)) continue;
    verdicts.push(JSON.parse(fs.readFileSync(verdictPath, "utf-8")));
  }
  return verdicts;
}

function computeRepeatedIssueCount(runDir, round, issues) {
  if (!issues.length) return 0;

  let repeating = new Set(issues.map(fingerprintIssue));
  let count = 1;
  for (const verdict of readPriorVerdicts(runDir, round)) {
    if (verdict.verdict !== "changes_requested" || !Array.isArray(verdict.issues) || verdict.issues.length === 0) {
      break;
    }
    const prior = new Set(verdict.issues.map(fingerprintIssue));
    repeating = new Set([...repeating].filter((entry) => prior.has(entry)));
    if (repeating.size === 0) break;
    count += 1;
  }
  return count;
}

function toEscalatedVerdict(baseVerdict, summary) {
  return {
    ...baseVerdict,
    verdict: "escalated",
    next_action: "escalated",
    summary,
  };
}

function applyVerdictToManifest(data, verdict, round, prNumber, reviewedHeadSha, repeatedIssueCount) {
  let nextState;
  let nextAction;
  let latestVerdict;

  if (verdict.verdict === "pass") {
    nextState = STATES.READY_TO_MERGE;
    nextAction = "await_explicit_merge";
    latestVerdict = "lgtm";
  } else if (verdict.verdict === "changes_requested") {
    nextState = STATES.CHANGES_REQUESTED;
    nextAction = "re_dispatch_requested_changes";
    latestVerdict = "changes_requested";
  } else {
    nextState = STATES.ESCALATED;
    nextAction = "inspect_review_failure";
    latestVerdict = "escalated";
  }

  const updated = updateManifestState(data, nextState, nextAction);
  return {
    ...updated,
    git: {
      ...(updated.git || {}),
      ...(prNumber ? { pr_number: prNumber } : {}),
      head_sha: reviewedHeadSha || updated.git?.head_sha || null,
    },
    review: {
      ...(updated.review || {}),
      rounds: round,
      latest_verdict: latestVerdict,
      repeated_issue_count: verdict.verdict === "changes_requested" ? repeatedIssueCount : 0,
      last_reviewed_sha: reviewedHeadSha || null,
    },
  };
}

function resolveContext(repoPath, manifestPathArg, runIdArg, branchArg, prArg) {
  let branch = branchArg;
  let prNumber = parsePositiveInt(prArg, "--pr");

  if (!branch && !prNumber && !manifestPathArg && !runIdArg) {
    throw new Error("Provide --run-id, --branch, --pr, or --manifest");
  }

  if (!branch && prNumber && !manifestPathArg && !runIdArg) {
    branch = resolveBranchForPr(repoPath, prNumber);
  }

  const manifest = resolveManifestRecord({
    repoRoot: repoPath,
    manifestPath: manifestPathArg,
    runId: runIdArg,
    branch,
    prNumber,
  });
  branch = branch || manifest.data?.git?.working_branch || null;
  prNumber = prNumber || manifest.data?.git?.pr_number || null;
  if (!prNumber && branch) {
    prNumber = resolvePrForBranch(repoPath, branch);
  }
  const issueNumber = resolveIssueNumber(repoPath, prNumber, branch, manifest.data);
  const reviewRepoPath = path.resolve(manifest.data?.paths?.worktree || repoPath);

  return { branch, prNumber, issueNumber, manifest, reviewRepoPath };
}

function postComment(repoPath, prNumber, commentBody) {
  if (!prNumber) {
    throw new Error("PR number is required to post a review comment");
  }
  gh(repoPath, "pr", "comment", String(prNumber), "--body", commentBody);
}

function captureGitStatus(repoPath) {
  return git(repoPath, "status", "--short", "--untracked-files=all").trim();
}

function applyPolicyViolationToManifest(data, round, prNumber, reviewedHeadSha, reason) {
  const updated = updateManifestState(data, STATES.ESCALATED, "inspect_review_failure");
  return {
    ...updated,
    git: {
      ...(updated.git || {}),
      ...(prNumber ? { pr_number: prNumber } : {}),
      head_sha: reviewedHeadSha || updated.git?.head_sha || null,
    },
    review: {
      ...(updated.review || {}),
      rounds: round,
      latest_verdict: reason || "policy_violation",
      repeated_issue_count: 0,
      last_reviewed_sha: reviewedHeadSha || null,
    },
  };
}

function resolveReviewerName(data, reviewerArg) {
  return reviewerArg || data.roles?.reviewer || process.env.RELAY_REVIEWER || "codex";
}

function resolveReviewerScript(reviewerName, reviewerScriptArg) {
  if (reviewerScriptArg) {
    return path.resolve(reviewerScriptArg);
  }

  const candidate = path.join(__dirname, `invoke-reviewer-${reviewerName}.js`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`No reviewer adapter found for '${reviewerName}'. Provide --reviewer-script or --review-file.`);
  }
  return candidate;
}

function invokeReviewer({
  repoPath,
  promptPath,
  reviewerName,
  reviewerScript,
  reviewerModel,
}) {
  const execArgs = [
    reviewerScript,
    "--repo", repoPath,
    "--prompt-file", promptPath,
    "--json",
  ];
  if (reviewerModel) {
    execArgs.push("--model", reviewerModel);
  }

  const rawText = execFileSync("node", execArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return {
    reviewerName,
    reviewerScript,
    rawText,
  };
}

function run() {
  const repoPath = path.resolve(getArg("--repo") || ".");
  const manifestPathArg = getArg("--manifest");
  const runIdArg = getArg("--run-id");
  const branchArg = getArg("--branch");
  const prArg = getArg("--pr");
  const doneCriteriaFile = getArg("--done-criteria-file");
  const diffFile = getArg("--diff-file");
  const reviewFile = getArg("--review-file");
  const reviewerArg = getArg("--reviewer");
  const reviewerScriptArg = getArg("--reviewer-script");
  const reviewerModel = getArg("--reviewer-model");
  const prepareOnly = hasFlag("--prepare-only");
  const noComment = hasFlag("--no-comment");
  const jsonOut = hasFlag("--json");

  const { branch, prNumber, issueNumber, manifest, reviewRepoPath } = resolveContext(
    repoPath,
    manifestPathArg,
    runIdArg,
    branchArg,
    prArg
  );
  const { data, body, manifestPath } = manifest;

  if (data.state !== STATES.REVIEW_PENDING) {
    throw new Error(`Review runner requires state=review_pending, got '${data.state}'`);
  }
  if (!fs.existsSync(reviewRepoPath)) {
    throw new Error(`Retained review checkout does not exist: ${reviewRepoPath}`);
  }

  const round = Number(data.review?.rounds || 0) + 1;
  const maxRounds = Number(data.review?.max_rounds || 20);
  const runDir = getRunDir(repoPath, data.run_id);
  ensureRunLayout(repoPath, data.run_id);
  let reviewedHeadSha = null;
  try {
    reviewedHeadSha = git(reviewRepoPath, "rev-parse", "HEAD").trim();
  } catch {}

  if (round > maxRounds) {
    const escalatedManifest = applyPolicyViolationToManifest(
      data,
      Number(data.review?.rounds || 0),
      prNumber,
      reviewedHeadSha,
      "max_rounds_exceeded"
    );
    writeManifest(manifestPath, escalatedManifest, body);
    appendRunEvent(repoPath, data.run_id, {
      event: "review_apply",
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: reviewedHeadSha,
      round: Number(data.review?.rounds || 0),
      reason: "max_rounds_exceeded",
    });
    throw new Error(`Review round cap exceeded: next round ${round} would exceed max_rounds=${maxRounds}`);
  }

  const doneCriteria = loadDoneCriteria(repoPath, issueNumber, prNumber, doneCriteriaFile);
  const diffText = loadDiff(repoPath, prNumber, diffFile);
  const promptText = buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, diffText, runDir });

  const doneCriteriaPath = path.join(runDir, `review-round-${round}-done-criteria.md`);
  const diffPath = path.join(runDir, `review-round-${round}-diff.patch`);
  const promptPath = path.join(runDir, `review-round-${round}-prompt.md`);
  writeText(doneCriteriaPath, `${doneCriteria}\n`);
  writeText(diffPath, `${diffText}\n`);
  writeText(promptPath, `${promptText}\n`);

  // Churn detection: compare diff sizes across rounds (after writing current diff).
  // Uses countLines on saved files consistently to avoid off-by-one from trailing newline.
  if (round >= 3) {
    const countLines = (p) => { let n = 0; const b = fs.readFileSync(p); for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n++; return n; };
    try {
      const curLines = countLines(diffPath);
      const prevLines = countLines(path.join(runDir, `review-round-${round - 1}-diff.patch`));
      const prevPrevLines = countLines(path.join(runDir, `review-round-${round - 2}-diff.patch`));
      if (curLines > prevLines && prevLines > prevPrevLines && prevPrevLines > 0) {
        const growth = Math.round(((curLines - prevPrevLines) / prevPrevLines) * 100);
        if (!jsonOut) {
          console.log(`  Warning: diff growing without convergence (${prevPrevLines} → ${prevLines} → ${curLines} lines, +${growth}%)`);
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  const reviewerName = resolveReviewerName(data, reviewerArg);
  const reviewerScript = reviewFile ? null : resolveReviewerScript(reviewerName, reviewerScriptArg);

  const result = {
    manifestPath,
    runId: data.run_id,
    round,
    branch,
    prNumber,
    issueNumber,
    reviewRepoPath,
    reviewHeadSha: reviewedHeadSha,
    promptPath,
    doneCriteriaPath,
    diffPath,
    state: data.state,
    nextState: null,
    commentPosted: false,
    reviewer: reviewerName,
    reviewerScript,
    reviewFile: reviewFile || null,
    rawResponsePath: null,
    verdictPath: null,
    redispatchPath: null,
    prepareOnly,
  };

  if (prepareOnly) {
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Prepared relay review round ${round}`);
      console.log(`  Manifest:      ${manifestPath}`);
      console.log(`  Prompt:        ${promptPath}`);
      console.log(`  Done criteria: ${doneCriteriaPath}`);
      console.log(`  Diff:          ${diffPath}`);
    }
    return;
  }

  let reviewText;
  if (reviewFile) {
    reviewText = readText(reviewFile);
  } else {
    const statusBeforeReviewer = captureGitStatus(reviewRepoPath);
    const invoked = invokeReviewer({
      repoPath: reviewRepoPath,
      promptPath,
      reviewerName,
      reviewerScript,
      reviewerModel,
    });
    const statusAfterReviewer = captureGitStatus(reviewRepoPath);
    if (statusBeforeReviewer !== statusAfterReviewer) {
      const violationPath = path.join(runDir, `review-round-${round}-policy-violation.txt`);
      const violationText = [
        "Reviewer write policy violation detected.",
        "",
        `Reviewer: ${reviewerName}`,
        `Script: ${reviewerScript}`,
        "",
        "Status before reviewer:",
        statusBeforeReviewer || "(clean)",
        "",
        "Status after reviewer:",
        statusAfterReviewer || "(clean)",
      ].join("\n");
      writeText(violationPath, `${violationText}\n`);

      const escalatedManifest = applyPolicyViolationToManifest(
        data,
        round,
        prNumber,
        reviewedHeadSha,
        "policy_violation"
      );
      writeManifest(manifestPath, escalatedManifest, body);
      appendRunEvent(repoPath, data.run_id, {
        event: "review_apply",
        state_from: data.state,
        state_to: STATES.ESCALATED,
        head_sha: reviewedHeadSha,
        round,
        reason: "policy_violation",
      });
      throw new Error(`Reviewer write policy violation detected; manifest escalated and details saved to ${violationPath}`);
    }
    const rawResponsePath = path.join(runDir, `review-round-${round}-raw-response.txt`);
    writeText(rawResponsePath, `${invoked.rawText}\n`);
    result.rawResponsePath = rawResponsePath;
    reviewText = invoked.rawText;
  }

  let verdict = parseReviewVerdict(reviewText);
  const repeatedIssueCount = verdict.verdict === "changes_requested"
    ? computeRepeatedIssueCount(runDir, round, verdict.issues)
    : 0;
  if (verdict.verdict === "changes_requested" && repeatedIssueCount >= 3) {
    verdict = toEscalatedVerdict(
      verdict,
      `Repeated identical review issues hit ${repeatedIssueCount} consecutive rounds.`
    );
  }
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  writeText(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);

  let redispatchPath = null;
  if (verdict.verdict === "changes_requested") {
    redispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
    writeText(redispatchPath, `${buildRedispatchPrompt(verdict, doneCriteria, runDir, round)}\n`);
  }

  const commentBody = buildCommentBody(verdict, round);
  if (!noComment) {
    postComment(repoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  const updatedManifest = applyVerdictToManifest(
    data,
    verdict,
    round,
    prNumber,
    reviewedHeadSha,
    repeatedIssueCount
  );
  writeManifest(manifestPath, updatedManifest, body);
  appendRunEvent(repoPath, data.run_id, {
    event: "review_apply",
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reason: verdict.verdict,
  });

  result.nextState = updatedManifest.state;
  result.state = updatedManifest.state;
  result.verdictPath = verdictPath;
  result.redispatchPath = redispatchPath;
  result.repeatedIssueCount = repeatedIssueCount;

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Applied relay review round ${round}`);
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`  State:    ${data.state} -> ${updatedManifest.state}`);
    console.log(`  Prompt:   ${promptPath}`);
    console.log(`  Verdict:  ${verdictPath}`);
    if (redispatchPath) console.log(`  Re-dispatch: ${redispatchPath}`);
    if (result.commentPosted) console.log(`  PR comment posted to #${prNumber}`);
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  applyVerdictToManifest,
  buildCommentBody,
  buildPrompt,
  buildRedispatchPrompt,
  formatIssueList,
  formatPriorVerdictSummary,
  formatScopeDrift,
  parseReviewVerdict,
  resolveIssueNumber,
  validateReviewVerdict,
  validateScopeDrift,
};
