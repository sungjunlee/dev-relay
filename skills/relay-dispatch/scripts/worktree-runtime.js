const fs = require("fs");
const path = require("path");

const { copyWorktreeFiles, getWorktreeIncludeFiles } = require("./worktreeinclude");
const { execGit } = require("./exec");

function formatPlan({ worktreePath, branch, title, register, pin, includeFiles }) {
  const lines = [
    "Dry run:",
    `  Worktree: ${worktreePath}`,
    `  Branch:   ${branch}`,
    `  Title:    ${title}`,
    `  Register: ${register}`,
  ];
  if (pin) lines.push("  Pinned:   yes");
  if (includeFiles.length) lines.push(`  .worktreeinclude: ${includeFiles.join(", ")}`);
  return lines.join("\n");
}

function formatAdvisorySelection(value) {
  if (!value) return "(none)";
  const lanes = Array.isArray(value) ? value : [value];
  const formatted = lanes
    .filter((lane) => lane && typeof lane === "object")
    .map((lane) => {
      const reviewer = lane.reviewer || "(unknown)";
      const profile = lane.profile || "blindspot";
      const model = lane.model || lane.reviewer_model;
      const suffixes = [];
      if (model) suffixes.push(`model=${model}`);
      if (lane.trigger && lane.trigger !== "every_round") suffixes.push(`trigger=${lane.trigger}`);
      if (lane.gating === true) suffixes.push("gating=true");
      return `${reviewer}/${profile}${suffixes.length ? ` ${suffixes.join(" ")}` : ""}`;
    });
  return formatted.length ? formatted.join(", ") : "(none)";
}

function formatDispatchDryRun({
  runId,
  mode,
  executor,
  repoRoot,
  manifestPath,
  prompt,
  model,
  sandbox,
  networkAccess = "disabled",
  register,
  resultFile,
  cleanupPolicy,
  timeout,
  rubricFile = null,
  requestId = null,
  leafId = null,
  fleetId = null,
  doneCriteriaFile = null,
  reviewAssurance = null,
  policyDecision = null,
  routingDecision = null,
  worktreePlan,
}) {
  const lines = [
    `  Run:      ${runId}`,
    "Dry run:",
    `  Mode:     ${mode}`,
    `  Executor: ${executor}`,
    `  Repo:     ${repoRoot}`,
    `  Worktree: ${worktreePlan.worktree}`,
    `  Branch:   ${worktreePlan.branch}`,
    `  Manifest: ${manifestPath}`,
    `  Prompt:   ${prompt.slice(0, 80)}...`,
    `  Model:    ${model || "(default)"}`,
    `  Sandbox:  ${sandbox}`,
    `  Network:  ${networkAccess}`,
    `  Register: ${register}`,
    `  Result:   ${resultFile}`,
    `  Cleanup:  ${cleanupPolicy}`,
    `  Timeout:  ${timeout}s`,
  ];
  if (rubricFile) {
    lines.push(`  Rubric:   ${rubricFile}`);
  }
  if (requestId) {
    lines.push(`  Request:  ${requestId}`);
  }
  if (leafId) {
    lines.push(`  Leaf:     ${leafId}`);
  }
  if (fleetId) {
    lines.push(`  Fleet:    ${fleetId}`);
  }
  if (doneCriteriaFile) {
    lines.push(`  Done AC:  ${doneCriteriaFile}`);
  }
  if (reviewAssurance) {
    lines.push(`  Assurance: ${reviewAssurance}`);
  }
  if (policyDecision) {
    const actorField = policyDecision.actor_field || "actor";
    const actorValue = policyDecision[actorField] || policyDecision.actor || "(unset)";
    const route = policyDecision.matched_route ? ` matched=${policyDecision.matched_route}` : "";
    lines.push(
      `  Policy:   ${policyDecision.allowed ? "allowed" : "denied"} ` +
      `phase=${policyDecision.phase} ${actorField}=${actorValue} ` +
      `model=${policyDecision.model || "(none)"} reason=${policyDecision.reason}${route}`
    );
  }
  if (routingDecision) {
    const matched = routingDecision.matched_rule
      ? `matched ${routingDecision.matched_rule.name} (#${routingDecision.matched_rule.index})`
      : `no match${routingDecision.no_match_reason ? ` (${routingDecision.no_match_reason})` : ""}`;
    const sourceTags = routingDecision.source_tags || {};
    const sourceParts = Object.entries(sourceTags)
      .filter(([, tags]) => Array.isArray(tags) && tags.length)
      .map(([source, tags]) => `${source.replace(/_/g, "-")}=${tags.join(",")}`);
    const effective = (routingDecision.effective_tags || []).join(",") || "(none)";
    lines.push(`  Routing: ${matched}`);
    lines.push(`  Tags:    ${[...sourceParts, `effective=${effective}`].join(" ")}`);
    lines.push(`  Selected: advisory_review=${formatAdvisorySelection(routingDecision.selected?.advisory_review)}`);
    if (routingDecision.warnings?.length) {
      lines.push(`  Routing warnings: ${routingDecision.warnings.map((warning) => warning.code).join(", ")}`);
    }
  }
  if (worktreePlan.worktreeinclude.length) {
    lines.push(`  .worktreeinclude: ${worktreePlan.worktreeinclude.join(", ")}`);
  }
  return lines.join("\n");
}

function removeWorktree({ repoRoot, worktreePath, dependencies = {} }) {
  const gitRunner = dependencies.gitRunner || ((repoDir, ...gitArgs) => execGit(repoDir, gitArgs));
  try {
    gitRunner(repoRoot, "worktree", "remove", "--force", worktreePath);
  } catch {}
}

function createWorktree({
  repoRoot,
  worktreePath,
  branch,
  title,
  startPoint = null,
  includeFiles,
  copyFiles = [],
  register = false,
  registerFn = null,
  pin = false,
  dryRun = false,
  logger = null,
  assertWithin = null,
  dependencies = {},
}) {
  const gitRunner = dependencies.gitRunner || ((repoDir, ...gitArgs) => execGit(repoDir, gitArgs));
  const getWorktreeIncludeFilesImpl = dependencies.getWorktreeIncludeFilesImpl || getWorktreeIncludeFiles;
  const copyWorktreeFilesImpl = dependencies.copyWorktreeFilesImpl || copyWorktreeFiles;
  const removeWorktreeImpl = dependencies.removeWorktreeImpl || removeWorktree;
  const resolvedIncludeFiles = includeFiles || getWorktreeIncludeFilesImpl(repoRoot);
  const plan = {
    worktree: worktreePath,
    branch,
    title,
    register,
    pin,
    ...(startPoint ? { startPoint } : {}),
    worktreeinclude: resolvedIncludeFiles,
  };

  if (dryRun) {
    if (typeof logger === "function") {
      logger({ event: "dry_run", plan });
    }
    return plan;
  }

  let createdWorktree = false;
  let copiedFiles = [];
  let threadId = null;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  try {
    try {
      const createArgs = ["worktree", "add", worktreePath, "-b", branch];
      if (startPoint) createArgs.push(startPoint);
      gitRunner(repoRoot, ...createArgs);
    } catch {
      try {
        gitRunner(repoRoot, "worktree", "add", worktreePath, branch);
      } catch (error) {
        throw new Error(`failed to create worktree for branch '${branch}': ${error.message}`);
      }
    }
    createdWorktree = true;
    if (typeof logger === "function") {
      logger({ event: "create", worktreePath, branch });
    }

    const copied = copyWorktreeFilesImpl(repoRoot, worktreePath, {
      copyFiles,
      assertWithin,
    });
    copiedFiles = copied.copied;
    if (typeof logger === "function") {
      logger({ event: "copy", worktreePath, copiedFiles });
    }

    if (register && registerFn) {
      const registration = registerFn({
        wtPath: worktreePath,
        repoPath: repoRoot,
        branch,
        title,
        pin,
      });
      threadId = registration.threadId || registration.sessionId || null;
      if (typeof logger === "function") {
        logger({ event: "register", worktreePath, branch, title, pin, threadId });
      }
    }
  } catch (error) {
    if (createdWorktree) {
      removeWorktreeImpl({ repoRoot, worktreePath, dependencies });
    }
    throw error;
  }

  return {
    ...plan,
    copiedFiles,
    threadId,
  };
}

module.exports = {
  createWorktree,
  formatDispatchDryRun,
  formatPlan,
  removeWorktree,
};
