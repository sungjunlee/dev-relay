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
  getRubricAnchorStatus,
  getRunDir,
  readManifest,
  updateManifestState,
  validateManifestPaths,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const {
  appendIterationScore,
  appendRunEvent,
  appendScoreDivergence,
} = require("../../relay-dispatch/scripts/relay-events");

const REVIEWER_PROMPT_PATH = path.join(__dirname, "..", "references", "reviewer-prompt.md");
const REVIEW_MARKER = "<!-- relay-review -->";
const REVIEW_ROUND_MARKER = "<!-- relay-review-round -->";
const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const RUBRIC_PASS_THROUGH_STATES = new Set(["loaded", "grandfathered"]);

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

function getGhLogin() {
  try {
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!login) {
      console.error("Warning: gh api user returned empty login — reviewer_login will not be recorded, author verification will be skipped at merge time");
      return null;
    }
    return login;
  } catch (error) {
    console.error(
      `Warning: could not determine GitHub login for reviewer verification — ` +
      `reviewer_login will not be recorded, author verification will be skipped at merge time. ` +
      `Cause: ${error.message || error}`
    );
    return null;
  }
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

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
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

function loadDoneCriteria(repoPath, issueNumber, prNumber, doneCriteriaFile, manifestData) {
  if (doneCriteriaFile) return { text: readText(doneCriteriaFile).trim(), source: "file" };

  const manifestDoneCriteriaPath = manifestData?.anchor?.done_criteria_path;
  if (manifestDoneCriteriaPath) {
    if (!fs.existsSync(manifestDoneCriteriaPath)) {
      throw new Error(
        `Manifest anchor.done_criteria_path points to a missing file: ${manifestDoneCriteriaPath}`
      );
    }
    return {
      text: readText(manifestDoneCriteriaPath).trim(),
      source: manifestData?.anchor?.done_criteria_source || "request_snapshot",
    };
  }

  const errors = [];

  // Primary: GitHub issue body (authored by the task creator)
  if (issueNumber) {
    try {
      const raw = gh(repoPath, "issue", "view", String(issueNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const text = `# Issue #${parsed.number}: ${parsed.title}\n\n${String(parsed.body || "").trim()}`.trim();
      if (text) return { text, source: "github-issue" };
    } catch (e) {
      errors.push(`issue #${issueNumber}: ${e.message.split("\n")[0]}`);
    }
  }

  // Fallback: PR description — written by the executor, not the task creator.
  // Lower trust: a compromised executor could manipulate the reviewer's anchor.
  if (prNumber) {
    try {
      const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "title,body,number");
      const parsed = JSON.parse(raw);
      const body = String(parsed.body || "").trim();
      if (body) {
        process.stderr.write(
          `  [WARN] Done Criteria sourced from PR body (executor-authored), not GitHub issue.\n` +
          `  PR body has lower trust — the executor could have altered the acceptance criteria.\n`
        );
        return { text: `# PR #${parsed.number}: ${parsed.title}\n\n${body}`.trim(), source: "pr-body" };
      }
    } catch (e) {
      errors.push(`PR #${prNumber}: ${e.message.split("\n")[0]}`);
    }
  }

  const detail = errors.length ? ` Attempted: ${errors.join("; ")}` : "";
  throw new Error(
    `Cannot resolve Done Criteria: no issue, no PR description.${detail} ` +
    "Provide --done-criteria-file or persist anchor.done_criteria_path for tasks without a GitHub issue."
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

function formatRubricWarning(label, rubricAnchor) {
  const details = [];
  if (rubricAnchor.rubricPath) {
    details.push(`anchor.rubric_path=${JSON.stringify(rubricAnchor.rubricPath)}`);
  }
  if (rubricAnchor.resolvedPath) {
    details.push(`resolved_path=${JSON.stringify(rubricAnchor.resolvedPath)}`);
  }
  return [
    `WARNING: [${label}] ${rubricAnchor.error}`,
    details.length ? `Context: ${details.join(", ")}` : null,
    "Do NOT return PASS or ready_to_merge while this warning is present. Flag the invariant failure in the review output.",
  ].filter(Boolean).join("\n");
}

function createRubricLoad({ state, status, content, warning, rubricPath, resolvedPath, error }) {
  if (!RUBRIC_PASS_THROUGH_STATES.has(state) && warning === null) {
    throw new Error(`Rubric load state '${state}' must include a visible warning`);
  }
  return {
    state,
    status,
    content,
    warning,
    rubricPath,
    resolvedPath,
    error,
  };
}

function loadRubricFromRunDir(runDir, manifestData) {
  const rubricAnchor = getRubricAnchorStatus(manifestData, { runDir, includeContent: true });
  switch (rubricAnchor.status) {
    case "satisfied":
      return createRubricLoad({
        state: "loaded",
        status: rubricAnchor.status,
        content: rubricAnchor.content,
        warning: null,
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "grandfathered":
      return createRubricLoad({
        state: "grandfathered",
        status: rubricAnchor.status,
        content: null,
        warning: null,
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing_path":
      return createRubricLoad({
        state: "not_set",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path not set", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "missing":
      return createRubricLoad({
        state: "missing",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric missing", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "outside_run_dir":
      return createRubricLoad({
        state: "outside_run_dir",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric path outside run dir", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    case "empty":
      return createRubricLoad({
        state: "empty",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric empty", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
    default:
      return createRubricLoad({
        state: "invalid",
        status: rubricAnchor.status,
        content: null,
        warning: formatRubricWarning("rubric invalid", rubricAnchor),
        rubricPath: rubricAnchor.rubricPath,
        resolvedPath: rubricAnchor.resolvedPath,
        error: rubricAnchor.error,
      });
  }
}

function buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, doneCriteriaSource, diffText, runDir, rubricLoad }) {
  const template = readText(REVIEWER_PROMPT_PATH)
    .replace("source=\"done-criteria\"", `source="${doneCriteriaSource || "done-criteria"}"`)
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

  if (rubricLoad.warning) {
    sections.push(
      "",
      "## Scoring Rubric",
      rubricLoad.warning,
    );
  } else if (rubricLoad.content) {
    sections.push(
      "",
      "## Scoring Rubric",
      "A rubric was provided during planning. You MUST score EVERY factor below.",
      "For each factor, populate a `rubric_scores` entry with `factor`, `target`, `observed`, `status`, `tier`, and `notes`.",
      "Do NOT leave `rubric_scores` empty when a rubric is provided.",
      "",
      rubricLoad.content,
    );
  }

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
    rubricLoad.content
      ? '- `rubric_scores` is REQUIRED — score every factor from the rubric. Each entry must include `factor`, `target`, `observed`, `status`, `tier`, and `notes`.'
      : '- If no Score Log is available, set `rubric_scores` to `[]`.',
    '- When `rubric_scores` is not empty, each entry must include `factor`, `target`, `observed`, `status`, `tier`, and `notes`.',
    '- `scope_drift` is always required. Set `scope_drift.creep` to `[]` if no out-of-scope changes. Set `scope_drift.missing` to list each Done Criteria item with status `verified`, `partial`, `not_done`, or `changed`.',
    '- If `scope_drift.missing` contains any `not_done`, `changed`, or `partial` entries, verdict cannot be `pass`.',
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
  if (!String(score.tier || "").trim()) {
    throw new Error(`${location}.tier is required`);
  }
  if (!ALLOWED_STATUSES.has(score.status)) {
    throw new Error(`${location}.status must be one of: ${Array.from(ALLOWED_STATUSES).join(", ")}`);
  }
  if (!ALLOWED_SCORE_TIERS.has(score.tier)) {
    throw new Error(`${location}.tier must be one of: ${Array.from(ALLOWED_SCORE_TIERS).join(", ")}`);
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
      (m) => m.status === "not_done" || m.status === "changed" || m.status === "partial"
    );
    if (blockingDrift.length > 0) {
      throw new Error(
        `PASS verdict cannot have scope_drift.missing entries with status not_done, changed, or partial: ${blockingDrift.map((m) => m.criteria).join(", ")}`
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

function appendCommentWarnings(commentBody, warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) return commentBody;
  return [
    commentBody,
    "",
    "Score divergence warnings:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

function buildCommentBody(verdict, round, { warnings = [], gateFailure = null } = {}) {
  if (gateFailure) {
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${gateFailure.summary}`,
      `Reviewer verdict: ${String(verdict.verdict || "unknown").toUpperCase()} (next_action=${verdict.next_action || "unknown"})`,
      `Gate status: ${gateFailure.status}`,
      `Layer: ${gateFailure.layer}`,
      `Rubric state: ${gateFailure.rubricState} (anchor status: ${gateFailure.rubricStatus})`,
      `Recovery command: ${gateFailure.recoveryCommand}`,
      "Issues:",
      `- Rubric gate failed closed: ${gateFailure.reason}. ${gateFailure.recovery}`,
    ].join("\n"), warnings);
  }

  if (verdict.verdict === "pass") {
    return appendCommentWarnings([
      REVIEW_MARKER,
      "## Relay Review",
      "Verdict: LGTM",
      `Summary: ${verdict.summary}`,
      `Contract: ${verdict.contract_status.toUpperCase()}`,
      `Quality: ${verdict.quality_status.toUpperCase()}`,
      `Rounds: ${round}`,
    ].join("\n"), warnings);
  }

  if (verdict.verdict === "changes_requested") {
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${verdict.summary}`,
      "Issues:",
      formatIssueList(verdict.issues),
    ].join("\n"), warnings);
  }

  return appendCommentWarnings([
    REVIEW_MARKER,
    "## Relay Review",
    "Verdict: ESCALATED",
    `Summary: ${verdict.summary}`,
    `Rounds: ${round}`,
    "Issues:",
    formatIssueList(verdict.issues),
  ].join("\n"), warnings);
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const content = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return content.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMissingScoreCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "—" || normalized === "–" || normalized === "-" || normalized === "n/a" || normalized === "na";
}

function parseScoreLog(markdownText) {
  if (typeof markdownText !== "string" || !markdownText.trim()) {
    return [];
  }

  const lines = markdownText.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = splitMarkdownTableRow(lines[index]);
    if (!headerCells || headerCells.length < 2 || !isMarkdownTableDivider(lines[index + 1])) {
      continue;
    }

    const normalizedHeaders = headerCells.map((cell) => cell.toLowerCase());
    const factorIndex = normalizedHeaders.indexOf("factor");
    const statusIndex = normalizedHeaders.indexOf("status");
    const finalIndex = normalizedHeaders.indexOf("final");
    const iterIndexes = normalizedHeaders
      .map((cell, cellIndex) => (/^iter\s+\d+$/i.test(cell) ? cellIndex : -1))
      .filter((cellIndex) => cellIndex !== -1);
    if (factorIndex === -1 || statusIndex === -1 || (finalIndex === -1 && iterIndexes.length === 0)) {
      continue;
    }

    const parsedRows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = splitMarkdownTableRow(lines[rowIndex]);
      if (!rowCells) break;

      const factor = String(rowCells[factorIndex] || "").trim();
      if (!factor) continue;

      let score = finalIndex !== -1 ? String(rowCells[finalIndex] || "").trim() : "";
      if (isMissingScoreCell(score)) {
        const fallbackIndex = [...iterIndexes]
          .reverse()
          .find((candidateIndex) => !isMissingScoreCell(rowCells[candidateIndex]));
        score = fallbackIndex === undefined ? "" : String(rowCells[fallbackIndex] || "").trim();
      }
      if (isMissingScoreCell(score)) {
        continue;
      }
      parsedRows.push({ factor, score });
    }

    if (parsedRows.length > 0) {
      return parsedRows;
    }
  }

  return [];
}

function normalizeFactorKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseNumericScore(value) {
  const text = String(value || "").trim();
  if (isMissingScoreCell(text)) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)(?:\s*\/\s*10(?:\.0+)?)?$/);
  if (!match) return null;
  return Number(match[1]);
}

function loadPrBody(repoPath, prNumber) {
  if (!prNumber) return "";
  try {
    const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "body");
    return String(JSON.parse(raw).body || "");
  } catch {
    return "";
  }
}

function formatDelta(delta) {
  return `${delta > 0 ? "+" : ""}${delta}`;
}

function buildScoreDivergenceAnalysis(markdownText, rubricScores) {
  if (!Array.isArray(rubricScores) || rubricScores.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  const scoreLog = parseScoreLog(markdownText);
  if (scoreLog.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  const executorScores = new Map(scoreLog.map((entry) => [normalizeFactorKey(entry.factor), entry.score]));
  const numericMatches = [];
  for (const score of rubricScores) {
    const factorKey = normalizeFactorKey(score.factor);
    const executor = executorScores.get(factorKey);
    if (!executor) continue;

    const executorNumeric = parseNumericScore(executor);
    const reviewerNumeric = parseNumericScore(score.observed);
    if (executorNumeric === null || reviewerNumeric === null) continue;

    const delta = Number((executorNumeric - reviewerNumeric).toFixed(4));
    numericMatches.push({
      factor: score.factor,
      executor,
      reviewer: score.observed,
      delta,
      tier: ALLOWED_SCORE_TIERS.has(score.tier) ? score.tier : null,
    });
  }

  if (numericMatches.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  return {
    warnings: numericMatches
      .filter((entry) => Math.abs(entry.delta) >= 3)
      .map((entry) => `${entry.factor}: executor ${entry.executor}, reviewer ${entry.reviewer} (${formatDelta(entry.delta)})`),
    eventPayload: numericMatches.filter((entry) => entry.tier !== null),
  };
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

function detectChurnGrowth(runDir, round) {
  if (!runDir || round < 3) return null;
  const countLines = (p) => { let n = 0; const b = fs.readFileSync(p); for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) n++; return n; };
  // Current round's diff was just written by the caller — must exist; let errors propagate.
  const curLines = countLines(path.join(runDir, `review-round-${round}-diff.patch`));
  try {
    const prevLines = countLines(path.join(runDir, `review-round-${round - 1}-diff.patch`));
    const prevPrevLines = countLines(path.join(runDir, `review-round-${round - 2}-diff.patch`));
    if (curLines > prevLines && prevLines > prevPrevLines && prevPrevLines > 0) {
      return { prevPrevLines, prevLines, curLines };
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return null;
}

function buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource) {
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

  if (churnGrowth) {
    sections.push(
      "",
      `WARNING: Diff has grown for 3+ consecutive rounds (${churnGrowth.prevPrevLines} → ${churnGrowth.prevLines} → ${churnGrowth.curLines} lines).`,
      "Apply minimal, targeted fixes only. Do not refactor, reorganize, or add code beyond what the issues require.",
    );
  }

  sections.push(
    "",
    "Original Done Criteria (scope anchor):",
    `<task-content source="${doneCriteriaSource || "done-criteria"}">`,
    doneCriteria,
    "</task-content>",
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

function buildRubricRecoveryCommand(runId, redispatchPath) {
  return `node skills/relay-dispatch/scripts/dispatch.js . --run-id ${runId} --prompt-file ${redispatchPath} --rubric-file <fixed-rubric.yaml>`;
}

function buildRubricGateRedispatchPrompt(gateFailure, doneCriteria, doneCriteriaSource) {
  return [
    "Rubric recovery re-dispatch",
    "",
    "relay-review failed closed on the rubric anchor, not on the code diff.",
    "",
    `Gate status: ${gateFailure.status}`,
    `Rubric state: ${gateFailure.rubricState} (anchor status: ${gateFailure.rubricStatus})`,
    `Reason: ${gateFailure.reason}`,
    `Recovery command: ${gateFailure.recoveryCommand}`,
    "",
    "Instructions:",
    "- Fix the rubric anchor or supply a replacement rubric with --rubric-file.",
    "- Keep the accepted task scope unchanged while re-dispatching.",
    "- After the re-dispatch completes, rerun relay-review on the same run.",
    "",
    `Done Criteria source: ${doneCriteriaSource}`,
    "Done Criteria:",
    doneCriteria,
  ].join("\n");
}

/**
 * Rubric fail-closed moves the run into `changes_requested` so the documented
 * `dispatch --run-id` recovery command remains executable without widening
 * dispatcher resume rules for arbitrary `review_pending` runs.
 * `next_action=repair_rubric_and_redispatch` tells the operator to fix the
 * anchored rubric state, re-dispatch the run, then rerun relay-review, and
 * `review.latest_verdict="rubric_state_failed_closed"` records that the raw
 * reviewer PASS was blocked by review-runner rubric enforcement.
 */
function buildReviewRunnerRubricGateFailure(runId, redispatchPath, rubricLoad) {
  if (!rubricLoad || RUBRIC_PASS_THROUGH_STATES.has(rubricLoad.state)) {
    return null;
  }

  const recoveryCommand = buildRubricRecoveryCommand(runId, redispatchPath);
  const rerunReviewStep = "After the re-dispatch completes, rerun relay-review.";
  let recovery;
  switch (rubricLoad.state) {
    case "not_set":
      recovery = `Persist a rubric for this run, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "missing":
      recovery = `Restore or replace the missing rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "outside_run_dir":
      recovery = `Replace the escaped rubric anchor with a contained rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "empty":
      recovery = `Regenerate the empty rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    default:
      recovery = `Fix or replace the rubric anchor, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
  }

  return {
    status: "rubric_state_failed_closed",
    layer: "review-runner",
    rubricState: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    reason: rubricLoad.error || "Rubric is not loaded.",
    recoveryCommand,
    recovery,
    summary: `review-runner fail-closed: rubricLoad.state='${rubricLoad.state}' blocked ready_to_merge despite reviewer PASS. ${recovery}`,
  };
}

function refreshManifestWithoutStateChange(data, nextAction) {
  return {
    ...data,
    next_action: nextAction,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: new Date().toISOString(),
    },
  };
}

function applyVerdictToManifest(data, verdict, round, prNumber, reviewedHeadSha, repeatedIssueCount, options = {}) {
  const rubricGateFailure = options.rubricGateFailure || null;
  let nextState;
  let nextAction;
  let latestVerdict;

  if (verdict.verdict === "pass") {
    if (rubricGateFailure) {
      nextState = STATES.CHANGES_REQUESTED;
      nextAction = "repair_rubric_and_redispatch";
      latestVerdict = rubricGateFailure.status;
    } else {
      nextState = STATES.READY_TO_MERGE;
      nextAction = "await_explicit_merge";
      latestVerdict = "lgtm";
    }
  } else if (verdict.verdict === "changes_requested") {
    nextState = STATES.CHANGES_REQUESTED;
    nextAction = "re_dispatch_requested_changes";
    latestVerdict = "changes_requested";
  } else {
    nextState = STATES.ESCALATED;
    nextAction = "inspect_review_failure";
    latestVerdict = "escalated";
  }

  const updated = nextState === data.state
    ? refreshManifestWithoutStateChange(data, nextAction)
    : updateManifestState(data, nextState, nextAction);
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
      last_gate: rubricGateFailure ? {
        status: rubricGateFailure.status,
        layer: rubricGateFailure.layer,
        rubric_state: rubricGateFailure.rubricState,
        rubric_status: rubricGateFailure.rubricStatus,
        recovery_command: rubricGateFailure.recoveryCommand,
        recovery: rubricGateFailure.recovery,
        reason: rubricGateFailure.reason,
      } : null,
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
  const validatedPaths = validateManifestPaths(manifest.data?.paths, {
    expectedRepoRoot: manifestPathArg ? undefined : (looksLikeGitRepo(repoPath) ? repoPath : undefined),
    manifestPath: manifest.manifestPath,
    runId: manifest.data?.run_id,
    requireWorktree: true,
    caller: "review-runner",
  });
  branch = branch || manifest.data?.git?.working_branch || null;
  prNumber = prNumber || manifest.data?.git?.pr_number || null;
  const runRepoPath = validatedPaths.repoRoot;
  if (!prNumber && branch) {
    prNumber = resolvePrForBranch(runRepoPath, branch);
  }
  const issueNumber = resolveIssueNumber(runRepoPath, prNumber, branch, manifest.data);
  const reviewRepoPath = validatedPaths.worktree;
  const normalizedManifest = {
    ...manifest,
    data: {
      ...(manifest.data || {}),
      paths: {
        ...(manifest.data?.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    },
  };

  return { branch, prNumber, issueNumber, manifest: normalizedManifest, reviewRepoPath, runRepoPath };
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
  const manifestReviewer = data.roles?.reviewer;
  if (reviewerArg) return reviewerArg;
  if (manifestReviewer && manifestReviewer !== "unknown") return manifestReviewer;
  return process.env.RELAY_REVIEWER || "codex";
}

function resolveReviewerScript(reviewerName, reviewerScriptArg) {
  if (reviewerScriptArg) {
    return path.resolve(reviewerScriptArg);
  }

  if (!/^[a-z0-9-]+$/.test(reviewerName)) {
    throw new Error(`Invalid reviewer name '${reviewerName}': must be lowercase alphanumeric/hyphens only. Use --reviewer-script for custom paths.`);
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

  const { branch, prNumber, issueNumber, manifest, reviewRepoPath, runRepoPath } = resolveContext(
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
  const runDir = getRunDir(runRepoPath, data.run_id);
  ensureRunLayout(runRepoPath, data.run_id);
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
    appendRunEvent(runRepoPath, data.run_id, {
      event: "review_apply",
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: reviewedHeadSha,
      round: Number(data.review?.rounds || 0),
      reason: "max_rounds_exceeded",
    });
    throw new Error(`Review round cap exceeded: next round ${round} would exceed max_rounds=${maxRounds}`);
  }

  const { text: doneCriteria, source: doneCriteriaSource } = loadDoneCriteria(
    runRepoPath,
    issueNumber,
    prNumber,
    doneCriteriaFile,
    data
  );
  const diffText = loadDiff(runRepoPath, prNumber, diffFile);
  const rubricLoad = loadRubricFromRunDir(runDir, data);
  const promptText = buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, doneCriteriaSource, diffText, runDir, rubricLoad });

  const doneCriteriaPath = path.join(runDir, `review-round-${round}-done-criteria.md`);
  const diffPath = path.join(runDir, `review-round-${round}-diff.patch`);
  const promptPath = path.join(runDir, `review-round-${round}-prompt.md`);
  writeText(doneCriteriaPath, `${doneCriteria}\n`);
  writeText(diffPath, `${diffText}\n`);
  writeText(promptPath, `${promptText}\n`);

  // Churn detection: compare diff sizes across rounds (after writing current diff).
  const churnGrowth = detectChurnGrowth(runDir, round);
  if (churnGrowth && !jsonOut) {
    const growth = Math.round(((churnGrowth.curLines - churnGrowth.prevPrevLines) / churnGrowth.prevPrevLines) * 100);
    console.log(`  Warning: diff growing without convergence (${churnGrowth.prevPrevLines} → ${churnGrowth.prevLines} → ${churnGrowth.curLines} lines, +${growth}%)`);
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
    rubricLoaded: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    rubricWarning: rubricLoad.warning || null,
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
      appendRunEvent(runRepoPath, data.run_id, {
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
  if (rubricLoad.state === "loaded" && (!Array.isArray(verdict.rubric_scores) || verdict.rubric_scores.length === 0)) {
    throw new Error(
      "Review verdict has empty rubric_scores but a rubric was provided. " +
      "The reviewer must score every rubric factor."
    );
  }
  const repeatedIssueCount = verdict.verdict === "changes_requested"
    ? computeRepeatedIssueCount(runDir, round, verdict.issues)
    : 0;
  if (verdict.verdict === "changes_requested" && repeatedIssueCount >= 3) {
    verdict = toEscalatedVerdict(
      verdict,
      `Repeated identical review issues hit ${repeatedIssueCount} consecutive rounds.`
    );
  }
  const rubricGateRedispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
  const rubricGateFailure = verdict.verdict === "pass"
    ? buildReviewRunnerRubricGateFailure(data.run_id, rubricGateRedispatchPath, rubricLoad)
    : null;
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  const verdictRecord = rubricGateFailure
    ? {
      ...verdict,
      relay_gate: {
        status: rubricGateFailure.status,
        layer: rubricGateFailure.layer,
        rubric_state: rubricGateFailure.rubricState,
        rubric_status: rubricGateFailure.rubricStatus,
        reason: rubricGateFailure.reason,
        recovery_command: rubricGateFailure.recoveryCommand,
        recovery: rubricGateFailure.recovery,
      },
    }
    : verdict;
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if (verdict.verdict === "changes_requested" || rubricGateFailure) {
    redispatchPath = rubricGateFailure
      ? rubricGateRedispatchPath
      : path.join(runDir, `review-round-${round}-redispatch.md`);
    const redispatchPrompt = rubricGateFailure
      ? buildRubricGateRedispatchPrompt(rubricGateFailure, doneCriteria, doneCriteriaSource)
      : buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource);
    writeText(redispatchPath, `${redispatchPrompt}\n`);
  }

  const { warnings: divergenceWarnings, eventPayload: divergencePayload } = buildScoreDivergenceAnalysis(
    loadPrBody(runRepoPath, prNumber),
    verdict.rubric_scores
  );
  const commentBody = buildCommentBody(verdict, round, {
    warnings: divergenceWarnings,
    gateFailure: rubricGateFailure,
  });
  if (!noComment) {
    postComment(runRepoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  const updatedManifest = applyVerdictToManifest(
    data,
    verdict,
    round,
    prNumber,
    reviewedHeadSha,
    repeatedIssueCount,
    { rubricGateFailure }
  );
  if (!noComment) {
    const reviewerLogin = getGhLogin();
    if (reviewerLogin) {
      updatedManifest.review = {
        ...(updatedManifest.review || {}),
        reviewer_login: reviewerLogin,
      };
    }
  }
  writeManifest(manifestPath, updatedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, {
    event: "review_apply",
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reason: rubricGateFailure ? rubricGateFailure.status : verdict.verdict,
  });
  if (Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length > 0) {
    appendIterationScore(runRepoPath, data.run_id, {
      round,
      scores: verdict.rubric_scores.map((score) => ({
        factor: score.factor,
        target: score.target,
        observed: score.observed,
        met: score.status === "pass",
        status: score.status,
        ...(ALLOWED_SCORE_TIERS.has(score.tier) ? { tier: score.tier } : {}),
      })),
    });
  }
  if (divergencePayload.length > 0) {
    appendScoreDivergence(runRepoPath, data.run_id, {
      round,
      divergences: divergencePayload,
    });
  }

  result.nextState = updatedManifest.state;
  result.state = updatedManifest.state;
  result.verdictPath = verdictPath;
  result.redispatchPath = redispatchPath;
  result.repeatedIssueCount = repeatedIssueCount;
  result.appliedVerdict = rubricGateFailure ? "changes_requested" : verdict.verdict;
  result.reviewGate = rubricGateFailure ? {
    status: rubricGateFailure.status,
    layer: rubricGateFailure.layer,
    rubricState: rubricGateFailure.rubricState,
    rubricStatus: rubricGateFailure.rubricStatus,
    reason: rubricGateFailure.reason,
    recoveryCommand: rubricGateFailure.recoveryCommand,
    recovery: rubricGateFailure.recovery,
  } : null;

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
  buildReviewRunnerRubricGateFailure,
  buildPrompt,
  buildRedispatchPrompt,
  detectChurnGrowth,
  formatIssueList,
  formatPriorVerdictSummary,
  formatScopeDrift,
  parseScoreLog,
  parseReviewVerdict,
  resolveIssueNumber,
  validateReviewVerdict,
  validateScopeDrift,
};
