#!/usr/bin/env node
/**
 * Script-managed relay review runner.
 *
 * Prepares a review prompt bundle for an isolated reviewer and applies a
 * structured verdict back into the relay manifest and PR audit trail.
 *
 * Usage:
 *   ./review-runner.js --repo <path> --branch <name> [options]
 *   ./review-runner.js --repo <path> --pr <number> [options]
 *
 * Options:
 *   --repo <path>                Repository root (default: .)
 *   --branch <name>              Working branch
 *   --pr <number>                PR number
 *   --manifest <path>            Explicit manifest path
 *   --done-criteria-file <path>  Use fixture file instead of gh issue fetch
 *   --diff-file <path>           Use fixture file instead of gh pr diff
 *   --review-file <path>         Structured reviewer JSON verdict to apply
 *   --prepare-only               Emit prompt bundle only; do not apply verdict
 *   --no-comment                 Do not post a PR comment
 *   --json                       Output JSON
 *   --help, -h                   Show usage
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  STATES,
  ensureRunLayout,
  findLatestManifestForBranch,
  getRunDir,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

const REVIEWER_PROMPT_PATH = path.join(__dirname, "..", "references", "reviewer-prompt.md");
const REVIEW_MARKER = "<!-- relay-review -->";
const REVIEW_ROUND_MARKER = "<!-- relay-review-round -->";
const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_STATUSES = new Set(["pass", "fail", "not_run"]);

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--branch", "--pr", "--manifest", "--done-criteria-file",
  "--diff-file", "--review-file", "--prepare-only", "--no-comment",
  "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: review-runner.js --repo <path> (--branch <name> | --pr <number>) [options]");
  console.log("\nPrepare or apply a structured relay review round.");
  console.log("\nOptions:");
  console.log("  --repo <path>                Repository root (default: .)");
  console.log("  --branch <name>              Working branch");
  console.log("  --pr <number>                PR number");
  console.log("  --manifest <path>            Explicit manifest path");
  console.log("  --done-criteria-file <path>  Use fixture file instead of gh issue fetch");
  console.log("  --diff-file <path>           Use fixture file instead of gh pr diff");
  console.log("  --review-file <path>         Structured reviewer JSON verdict to apply");
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

function resolveManifest(repoPath, manifestPath, branch) {
  if (manifestPath) {
    const resolved = path.resolve(manifestPath);
    return { manifestPath: resolved, ...readManifest(resolved) };
  }

  if (!branch) {
    throw new Error("Branch is required when --manifest is not provided");
  }

  const match = findLatestManifestForBranch(repoPath, branch);
  if (!match) {
    throw new Error(`No relay manifest found for branch '${branch}'`);
  }
  return match;
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

function loadDoneCriteria(repoPath, issueNumber, doneCriteriaFile) {
  if (doneCriteriaFile) return readText(doneCriteriaFile).trim();
  if (!issueNumber) {
    throw new Error("Issue number is required to fetch done criteria. Provide --done-criteria-file if the issue cannot be resolved.");
  }

  const raw = gh(repoPath, "issue", "view", String(issueNumber), "--json", "title,body,number");
  const parsed = JSON.parse(raw);
  return `# Issue #${parsed.number}: ${parsed.title}\n\n${String(parsed.body || "").trim()}`.trim();
}

function loadDiff(repoPath, prNumber, diffFile) {
  if (diffFile) return readText(diffFile).trim();
  if (!prNumber) {
    throw new Error("PR number is required to fetch a diff. Provide --diff-file for fixture-based runs.");
  }
  return gh(repoPath, "pr", "diff", String(prNumber)).trim();
}

function buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, diffText }) {
  const template = readText(REVIEWER_PROMPT_PATH)
    .replace("[PASTE DONE CRITERIA HERE]", doneCriteria)
    .replace("[PASTE PR DIFF OR FILE PATH HERE]", diffText);

  const schema = [
    "{",
    '  "verdict": "pass | changes_requested | escalated",',
    '  "summary": "short summary",',
    '  "contract_status": "pass | fail",',
    '  "quality_status": "pass | fail | not_run",',
    '  "next_action": "ready_to_merge | changes_requested | escalated",',
    '  "issues": [',
    '    {',
    '      "title": "short title",',
    '      "body": "actionable explanation",',
    '      "file": "path/to/file",',
    '      "line": 123,',
    '      "category": "contract | quality | security | integration | scope",',
    '      "severity": "high | medium | low"',
    "    }",
    "  ],",
    '  "rubric_scores": []',
    "}",
  ].join("\n");

  return [
    `# Relay Review Round ${round}`,
    "",
    `PR: #${prNumber || "unknown"}`,
    `Branch: ${branch || "unknown"}`,
    `Issue: ${issueNumber || "unknown"}`,
    "",
    template,
    "",
    "## Structured Output",
    "Return ONLY valid JSON. Do not wrap it in markdown fences.",
    "",
    schema,
    "",
    "Validation rules:",
    '- If `verdict` is `pass`, then `issues` must be `[]` and `next_action` must be `ready_to_merge`.',
    '- If `verdict` is `changes_requested`, include actionable issues with `file` and `line`, and set `next_action` to `changes_requested`.',
    '- If `verdict` is `escalated`, include the blocking issues or reason that automation should stop, and set `next_action` to `escalated`.',
  ].join("\n");
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

function buildRedispatchPrompt(verdict, doneCriteria) {
  return [
    "Fix these review issues in the PR. Do not change anything else. Push to the same branch.",
    "",
    "Issues to fix:",
    formatIssueList(verdict.issues),
    "",
    "Original Done Criteria (scope anchor):",
    doneCriteria,
  ].join("\n");
}

function applyVerdictToManifest(data, verdict, round, prNumber) {
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
    },
    review: {
      ...(updated.review || {}),
      rounds: round,
      latest_verdict: latestVerdict,
      repeated_issue_count: verdict.verdict === "changes_requested"
        ? Number(updated.review?.repeated_issue_count || 0)
        : 0,
    },
  };
}

function resolveContext(repoPath, manifestPathArg, branchArg, prArg) {
  let branch = branchArg;
  let prNumber = parsePositiveInt(prArg, "--pr");

  if (!branch && !prNumber && !manifestPathArg) {
    throw new Error("Provide --branch, --pr, or --manifest");
  }

  if (!branch && prNumber) {
    branch = resolveBranchForPr(repoPath, prNumber);
  }
  if (!prNumber && branch) {
    prNumber = resolvePrForBranch(repoPath, branch);
  }

  const manifest = resolveManifest(repoPath, manifestPathArg, branch);
  branch = branch || manifest.data?.git?.working_branch || null;
  prNumber = prNumber || manifest.data?.git?.pr_number || null;
  const issueNumber = resolveIssueNumber(repoPath, prNumber, branch, manifest.data);

  return { branch, prNumber, issueNumber, manifest };
}

function postComment(repoPath, prNumber, commentBody) {
  if (!prNumber) {
    throw new Error("PR number is required to post a review comment");
  }
  gh(repoPath, "pr", "comment", String(prNumber), "--body", commentBody);
}

function run() {
  const repoPath = path.resolve(getArg("--repo") || ".");
  const manifestPathArg = getArg("--manifest");
  const branchArg = getArg("--branch");
  const prArg = getArg("--pr");
  const doneCriteriaFile = getArg("--done-criteria-file");
  const diffFile = getArg("--diff-file");
  const reviewFile = getArg("--review-file");
  const prepareOnly = hasFlag("--prepare-only");
  const noComment = hasFlag("--no-comment");
  const jsonOut = hasFlag("--json");

  const { branch, prNumber, issueNumber, manifest } = resolveContext(repoPath, manifestPathArg, branchArg, prArg);
  const { data, body, manifestPath } = manifest;

  if (data.state !== STATES.REVIEW_PENDING) {
    throw new Error(`Review runner requires state=review_pending, got '${data.state}'`);
  }

  const round = Number(data.review?.rounds || 0) + 1;
  const runDir = getRunDir(repoPath, data.run_id);
  ensureRunLayout(repoPath, data.run_id);

  const doneCriteria = loadDoneCriteria(repoPath, issueNumber, doneCriteriaFile);
  const diffText = loadDiff(repoPath, prNumber, diffFile);
  const promptText = buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, diffText });

  const doneCriteriaPath = path.join(runDir, `review-round-${round}-done-criteria.md`);
  const diffPath = path.join(runDir, `review-round-${round}-diff.patch`);
  const promptPath = path.join(runDir, `review-round-${round}-prompt.md`);
  writeText(doneCriteriaPath, `${doneCriteria}\n`);
  writeText(diffPath, `${diffText}\n`);
  writeText(promptPath, `${promptText}\n`);

  const result = {
    manifestPath,
    runId: data.run_id,
    round,
    branch,
    prNumber,
    issueNumber,
    promptPath,
    doneCriteriaPath,
    diffPath,
    state: data.state,
    nextState: null,
    commentPosted: false,
    reviewFile: reviewFile || null,
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

  if (!reviewFile) {
    throw new Error("--review-file is required unless --prepare-only is used");
  }

  const verdict = parseReviewVerdict(readText(reviewFile));
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  writeText(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);

  let redispatchPath = null;
  if (verdict.verdict === "changes_requested") {
    redispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
    writeText(redispatchPath, `${buildRedispatchPrompt(verdict, doneCriteria)}\n`);
  }

  const commentBody = buildCommentBody(verdict, round);
  if (!noComment) {
    postComment(repoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  const updatedManifest = applyVerdictToManifest(data, verdict, round, prNumber);
  writeManifest(manifestPath, updatedManifest, body);

  result.nextState = updatedManifest.state;
  result.state = updatedManifest.state;
  result.verdictPath = verdictPath;
  result.redispatchPath = redispatchPath;

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
  parseReviewVerdict,
  resolveIssueNumber,
  validateReviewVerdict,
};
