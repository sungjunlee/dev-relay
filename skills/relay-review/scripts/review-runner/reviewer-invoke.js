const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const {
  ADAPTER_PHASES,
  listAgentAdapterNames,
  getAgentAdapterDescriptor,
  supportsAgentAdapterPhase,
} = require("../../../relay-dispatch/scripts/agent-adapters");
const {
  AdapterCapabilityError,
  assertPolicyRepresentable,
  buildAgentPolicyAudit,
} = require("../../../relay-dispatch/scripts/agent-adapters/policy");
const { resolveExecutorDefaultModel } = require("../../../relay-dispatch/scripts/executor-model-config");
const { getRoutePlanPath } = require("../../../relay-dispatch/scripts/manifest/paths");
const { appendRunEvent, appendUnregisteredRouteUsedEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { assertRelayPolicyGate } = require("../../../relay-dispatch/scripts/relay-policy-gate");
const { applyPolicyViolationToManifest } = require("./manifest-apply");
const { git, readText, writeText } = require("./common");

function loadRunRoutePlan(repoRoot, runId) {
  if (!repoRoot || !runId) return { path: null, plan: null, status: "missing" };
  const routePlanPath = getRoutePlanPath(repoRoot, runId);
  if (!fs.existsSync(routePlanPath)) {
    return { path: routePlanPath, plan: null, status: "absent" };
  }
  try {
    return {
      path: routePlanPath,
      plan: JSON.parse(fs.readFileSync(routePlanPath, "utf-8")),
      status: "ok",
    };
  } catch (error) {
    throw new Error(`failed to read route plan at ${routePlanPath}: ${error.message}`);
  }
}

function routePlanReviewPhase(routePlan) {
  return routePlan?.phases?.review && typeof routePlan.phases.review === "object"
    ? routePlan.phases.review
    : null;
}

function resolveReviewerName(data, reviewerArg, { routePlan = null } = {}) {
  const manifestReviewer = data.roles?.reviewer;
  const envReviewer = typeof process.env.RELAY_REVIEWER === "string"
    ? process.env.RELAY_REVIEWER.trim()
    : "";
  if (reviewerArg) return reviewerArg;
  if (envReviewer) return envReviewer;
  const routeReviewer = routePlanReviewPhase(routePlan)?.reviewer;
  if (routeReviewer) return routeReviewer;
  if (manifestReviewer && manifestReviewer !== "unknown") return manifestReviewer;
  return "codex";
}

function supportedAdapterPhases(reviewerName) {
  return Object.values(ADAPTER_PHASES)
    .filter((phase) => supportsAgentAdapterPhase(reviewerName, phase));
}

function adaptersSupportingPhase(phase) {
  return listAgentAdapterNames()
    .filter((name) => supportsAgentAdapterPhase(name, phase));
}

function formatUnsupportedReviewerPhaseError(reviewerName, phase) {
  const supported = supportedAdapterPhases(reviewerName);
  if (
    phase === ADAPTER_PHASES.PRIMARY_REVIEW &&
    supported.includes(ADAPTER_PHASES.ADVISORY_REVIEW)
  ) {
    return (
      `Reviewer adapter '${reviewerName}' supports advisory_review but not primary_review; ` +
      `use --advisory-reviewer ${reviewerName} instead of --reviewer ${reviewerName} until primary review support is implemented. ` +
      `Use --reviewer-script for an operator override. Primary-review-capable adapters: ${adaptersSupportingPhase(phase).join(", ")}.`
    );
  }
  if (
    phase === ADAPTER_PHASES.ADVISORY_REVIEW &&
    supported.includes(ADAPTER_PHASES.PRIMARY_REVIEW)
  ) {
    return (
      `Reviewer adapter '${reviewerName}' supports primary_review but not advisory_review; ` +
      `use --reviewer ${reviewerName} instead of --advisory-reviewer ${reviewerName}.`
    );
  }
  return (
    `Reviewer adapter '${reviewerName}' does not support ${phase}. ` +
    `Supported phases: ${supported.join(", ") || "(none)"}. Use --reviewer-script for an operator override.`
  );
}

function preflightPrimaryReviewerCapability(reviewerName) {
  if (!listAgentAdapterNames().includes(reviewerName)) return;
  if (supportsAgentAdapterPhase(reviewerName, ADAPTER_PHASES.PRIMARY_REVIEW)) return;
  const message = formatUnsupportedReviewerPhaseError(reviewerName, ADAPTER_PHASES.PRIMARY_REVIEW);
  throw new AdapterCapabilityError({
    adapter: reviewerName,
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: { phase: ADAPTER_PHASES.PRIMARY_REVIEW },
    safe: false,
    supported_phases: supportedAdapterPhases(reviewerName),
    fail_closed_reasons: [message],
    warnings: [],
  }, message);
}

function resolveReviewerScript(reviewerName, reviewerScriptArg, { phase = ADAPTER_PHASES.PRIMARY_REVIEW } = {}) {
  if (reviewerScriptArg) {
    return path.resolve(reviewerScriptArg);
  }

  if (!/^[a-z0-9-]+$/.test(reviewerName)) {
    throw new Error(`Invalid reviewer name '${reviewerName}': must be lowercase alphanumeric/hyphens only. Use --reviewer-script for custom paths.`);
  }
  let descriptor;
  try {
    descriptor = getAgentAdapterDescriptor(reviewerName);
  } catch {
    throw new Error(
      `Unknown reviewer adapter '${reviewerName}'. Supported adapters: ${listAgentAdapterNames().join(", ")}. ` +
      "Use --reviewer-script for custom paths."
    );
  }
  if (!supportsAgentAdapterPhase(reviewerName, phase)) {
    const message = formatUnsupportedReviewerPhaseError(reviewerName, phase);
    throw new AdapterCapabilityError({
      adapter: reviewerName,
      phase,
      requested: { phase },
      safe: false,
      supported_phases: supportedAdapterPhases(reviewerName),
      fail_closed_reasons: [message],
      warnings: [],
    }, message);
  }

  const scriptName = phase === ADAPTER_PHASES.ADVISORY_REVIEW
    ? descriptor.reviewer?.advisoryReviewScript
    : descriptor.reviewer?.primaryReviewScript;
  if (!scriptName) {
    throw new Error(`Reviewer adapter '${reviewerName}' supports ${phase} but has no registered reviewer script.`);
  }
  const candidate = path.join(__dirname, "..", scriptName);
  if (!fs.existsSync(candidate)) {
    throw new Error(`No reviewer adapter script found for '${reviewerName}' phase ${phase}. Provide --reviewer-script or --review-file.`);
  }
  return candidate;
}

function invokeReviewer({
  phase = ADAPTER_PHASES.PRIMARY_REVIEW,
  passPhase = false,
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
  if (passPhase) {
    execArgs.push("--phase", phase);
  }
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

function resolveReviewerModel(data, reviewerModel, reviewerName = null, { routePlan = null, repoRoot = null } = {}) {
  if (reviewerModel) return { model: reviewerModel, source: "cli" };
  const routeReview = routePlanReviewPhase(routePlan);
  if (routeReview?.model && (!routeReview.reviewer || routeReview.reviewer === reviewerName)) {
    return { model: routeReview.model, source: "route_plan" };
  }
  const hintedModel = data?.model_hints?.review;
  if (typeof hintedModel === "string" && hintedModel.trim()) return { model: hintedModel.trim(), source: "model_hints" };
  if (["opencode", "pi", "antigravity", "cline"].includes(reviewerName)) {
    return {
      model: resolveExecutorDefaultModel(reviewerName, { relayHome: process.env.RELAY_HOME, repoRoot }),
      source: "executor_defaults",
    };
  }
  return { model: null, source: "unresolved" };
}

function buildPrimaryReviewerPolicy(reviewerName) {
  let descriptor;
  try {
    descriptor = getAgentAdapterDescriptor(reviewerName);
  } catch {
    return null;
  }
  const networkAccess = reviewerName === "claude" ? "ambient" : "disabled";
  const audit = assertPolicyRepresentable(buildAgentPolicyAudit({
    descriptor,
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess,
      readOnly: true,
    },
  }));
  if (reviewerName !== "antigravity") {
    return audit;
  }

  const cliBinary = process.env.RELAY_ANTIGRAVITY_BIN || descriptor.executor?.cliBinary || "agy";
  let version = null;
  let error = null;
  try {
    version = execFileSync(cliBinary, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch (caught) {
    error = String(caught?.message || caught).split("\n")[0];
  }
  return {
    ...audit,
    cli: {
      binary: cliBinary,
      version,
      version_probe: "agy --version",
      error,
    },
  };
}

function isAdapterManagedReviewerScript(reviewerName, reviewerScript, { phase = ADAPTER_PHASES.PRIMARY_REVIEW } = {}) {
  try {
    return path.resolve(reviewerScript) === path.resolve(resolveReviewerScript(reviewerName, null, { phase }));
  } catch {
    return false;
  }
}

function buildCustomReviewerScriptPolicy({ reviewerName, reviewerScript }) {
  const warning = "Custom reviewer scripts are invoked outside adapter-managed containment; read-only is checked after invocation with git status.";
  const informational = (requested) => ({
    requested,
    enforcement_level: "informational",
    mechanism: "git-status-after-invocation",
    flags: [],
    warnings: [warning],
    fail_closed_reason: null,
  });
  return {
    adapter: "custom-reviewer-script",
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    reviewer: reviewerName,
    script: reviewerScript,
    requested: {
      sandbox: "read-only",
      network: "disabled",
      read_only: true,
    },
    sandbox: informational("read-only"),
    network: informational("disabled"),
    read_only: informational(true),
    warnings: [warning],
    fail_closed_reasons: [],
    safe: true,
  };
}

function buildReviewerPolicy({ reviewerName, reviewerScript }) {
  if (isAdapterManagedReviewerScript(reviewerName, reviewerScript, { phase: ADAPTER_PHASES.PRIMARY_REVIEW })) {
    return buildPrimaryReviewerPolicy(reviewerName);
  }
  return buildCustomReviewerScriptPolicy({ reviewerName, reviewerScript });
}

function buildPrimaryReviewerPreflight({
  data,
  reviewerModel,
  reviewerName,
  reviewerScript,
  runRepoPath,
  routePlan = null,
}) {
  const resolvedReviewerModel = resolveReviewerModel(data, reviewerModel, reviewerName, { routePlan, repoRoot: runRepoPath });
  const effectiveReviewerModel = resolvedReviewerModel.model;
  const reviewPhase = routePlanReviewPhase(routePlan);
  const modelResolution = resolvedReviewerModel.source === "route_plan"
    ? reviewPhase?.model_resolution || null
    : null;
  const reviewerPolicy = buildReviewerPolicy({ reviewerName, reviewerScript });
  try {
    const policyDecision = assertRelayPolicyGate({
      repoRoot: runRepoPath,
      phase: "review",
      reviewer: reviewerName,
      model: effectiveReviewerModel,
    });
    return {
      effectiveReviewerModel,
      policyDecision,
      routeSource: resolvedReviewerModel.source,
      modelResolution,
      reviewerPolicy,
    };
  } catch (error) {
    error.adapterCapability = reviewerPolicy;
    throw error;
  }
}

function captureGitStatus(repoPath) {
  return git(repoPath, "status", "--short", "--untracked-files=all").trim();
}

function loadReviewText({ body, data, manifestPath, prNumber, promptPath, reviewFile, reviewRepoPath, reviewedHeadSha, reviewerModel, reviewerName, reviewerScript, round, runDir, runRepoPath, reviewerPreflight = null, routePlan = null }) {
  if (reviewFile) {
    return { rawResponsePath: null, reviewText: readText(reviewFile) };
  }

  const {
    effectiveReviewerModel,
    policyDecision,
    routeSource,
    modelResolution,
    reviewerPolicy,
  } = reviewerPreflight || buildPrimaryReviewerPreflight({
    data,
    reviewerModel,
    reviewerName,
    reviewerScript,
    runRepoPath,
    routePlan,
  });
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_INVOKE,
    state_from: data.state,
    state_to: data.state,
    head_sha: reviewedHeadSha || null,
    round,
    reason: reviewerName,
    model: effectiveReviewerModel,
    policy_decision: policyDecision,
    route_source: routeSource,
    reviewer_policy: reviewerPolicy,
  });
  appendUnregisteredRouteUsedEvent(runRepoPath, data.run_id, {
    state: data.state,
    headSha: reviewedHeadSha || null,
    round,
    policyDecision,
    modelResolution,
  });

  const statusBeforeReviewer = captureGitStatus(reviewRepoPath);
  const invoked = invokeReviewer({
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    passPhase: isAdapterManagedReviewerScript(reviewerName, reviewerScript, { phase: ADAPTER_PHASES.PRIMARY_REVIEW }),
    repoPath: reviewRepoPath,
    promptPath,
    reviewerModel: effectiveReviewerModel,
    reviewerName,
    reviewerScript,
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
    const reviewerStampedManifest = {
      ...escalatedManifest,
      review: {
        ...(escalatedManifest.review || {}),
        last_reviewer: reviewerName,
      },
    };
    writeManifest(manifestPath, reviewerStampedManifest, body);
    appendRunEvent(runRepoPath, data.run_id, {
      event: EVENTS.REVIEW_APPLY,
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: reviewedHeadSha,
      round,
      reviewer: reviewerName,
      reason: "policy_violation",
    });
    throw new Error(`Reviewer write policy violation detected; manifest escalated and details saved to ${violationPath}`);
  }

  const rawResponsePath = path.join(runDir, `review-round-${round}-raw-response.txt`);
  writeText(rawResponsePath, `${invoked.rawText}\n`);
  return { rawResponsePath, reviewText: invoked.rawText };
}

module.exports = {
  captureGitStatus,
  invokeReviewer,
  loadRunRoutePlan,
  loadReviewText,
  buildPrimaryReviewerPolicy,
  buildPrimaryReviewerPreflight,
  buildReviewerPolicy,
  preflightPrimaryReviewerCapability,
  resolveReviewerName,
  resolveReviewerModel,
  resolveReviewerScript,
};
