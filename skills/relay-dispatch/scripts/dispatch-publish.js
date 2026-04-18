const { execFileSync } = require("child_process");

function formatExecError(error) {
  const candidates = [
    error?.stderr,
    error?.stdout,
    error?.message,
    error,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (text) return text.split("\n")[0];
  }
  return "unknown command failure";
}

function parsePrNumber(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const urlMatches = [...text.matchAll(/\/pull\/(\d+)(?:[/?#\s]|$)/g)];
  if (urlMatches.length) {
    return Number(urlMatches[urlMatches.length - 1][1]);
  }

  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  return null;
}

function buildPrBody({ resultPreview, runId, executor, branch }) {
  const preview = String(resultPreview || "").trim().slice(0, 500);
  const summary = preview || "Dispatch completed successfully.";
  const scoreLog = [
    `- Run: ${String(runId || "").trim() || "unknown"}`,
    `- Executor: ${String(executor || "").trim() || "unknown"}`,
    `- Branch: ${String(branch || "").trim() || "unknown"}`,
  ];
  return [
    "## Dispatch Summary",
    "",
    "```text",
    summary,
    "```",
    "",
    "## Score Log",
    "",
    ...scoreLog,
  ].join("\n");
}

async function pushAndOpenPR({
  repoRoot,
  wtPath,
  branch,
  baseBranch,
  resultPreview,
  runId,
  executor,
  execFile = execFileSync,
}) {
  const ghOpts = { cwd: wtPath, encoding: "utf-8", stdio: "pipe" };
  const gitOpts = { encoding: "utf-8", stdio: "pipe" };
  let existingPrNumber = null;

  try {
    const existing = execFile("gh", [
      "pr", "list",
      "--head", branch,
      "--json", "number",
      "--jq", ".[0].number",
    ], ghOpts).trim();
    existingPrNumber = parsePrNumber(existing);
  } catch (error) {
    throw new Error(`gh_pr_list_failed: ${formatExecError(error)}`);
  }

  try {
    execFile("git", ["-C", wtPath, "push", "-u", "origin", branch], gitOpts);
  } catch (error) {
    throw new Error(`git_push_failed: ${formatExecError(error)}`);
  }

  if (existingPrNumber !== null) {
    return { prNumber: existingPrNumber, createdByUs: false };
  }

  let title;
  try {
    title = execFile("git", ["-C", wtPath, "log", "-1", "--format=%s", "HEAD"], gitOpts).trim();
  } catch (error) {
    throw new Error(`git_log_failed: ${formatExecError(error)}`);
  }
  if (!title) title = `Dispatch ${branch}`;

  const body = buildPrBody({ resultPreview, runId, executor, branch });

  let prCreateOutput;
  try {
    prCreateOutput = execFile("gh", [
      "pr", "create",
      "--base", baseBranch,
      "--head", branch,
      "--title", title,
      "--body", body,
    ], ghOpts);
  } catch (error) {
    throw new Error(`gh_pr_create_failed: ${formatExecError(error)}`);
  }

  const prNumber = parsePrNumber(prCreateOutput);
  if (prNumber === null) {
    throw new Error(`gh_pr_create_parse_failed: ${String(prCreateOutput || "").trim().split("\n")[0] || "missing PR number"}`);
  }

  return { prNumber, createdByUs: true };
}

module.exports = {
  buildPrBody,
  formatExecError,
  parsePrNumber,
  pushAndOpenPR,
};
