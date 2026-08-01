const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const {
  ADAPTER_PHASES,
  getAdapter,
  listAdapters,
} = require("../../../relay-dispatch/scripts/adapters");
const { AdapterCapabilityError, assertInvocationIdentity, validateCapabilities } = require("../../../relay-dispatch/scripts/adapter-contract");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { applyPolicyViolationToManifest } = require("./manifest-apply");
const { git, readText, writeText } = require("./common");
const {
  PROMPT_TRANSPORT_EVIDENCE_ENV,
  promptTransportPolicy,
} = require("../reviewer-prompt-transport");

function resolveReviewerName(data, reviewerArg) {
  const manifestReviewer = data.roles?.reviewer;
  if (reviewerArg && manifestReviewer && manifestReviewer !== "unknown" && reviewerArg !== manifestReviewer) {
    throw new Error(`--reviewer cannot replace immutable run binding '${manifestReviewer}'`);
  }
  if (reviewerArg) return reviewerArg;
  if (manifestReviewer && manifestReviewer !== "unknown") return manifestReviewer;
  return "codex";
}

function supportedAdapterPhases(reviewerName) {
  return Object.values(ADAPTER_PHASES)
    .filter((phase) => {
      try {
        return getAdapter(reviewerName).capabilities({ phase }).supported === true;
      } catch {
        return false;
      }
    });
}

function adaptersSupportingPhase(phase) {
  return listAdapters()
    .filter((name) => getAdapter(name).capabilities({ phase }).supported === true);
}

function formatUnsupportedReviewerPhaseError(reviewerName, phase) {
  const supported = supportedAdapterPhases(reviewerName);
  return (
    `Reviewer adapter '${reviewerName}' does not support ${phase}. ` +
    `Supported phases: ${supported.join(", ") || "(none)"}. ` +
    `Primary-review-capable adapters: ${adaptersSupportingPhase(ADAPTER_PHASES.PRIMARY_REVIEW).join(", ")}. ` +
    "Use --reviewer-script for an operator override."
  );
}

function preflightPrimaryReviewerCapability(reviewerName) {
  if (!listAdapters().includes(reviewerName)) return;
  if (getAdapter(reviewerName).capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported) return;
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
    descriptor = getAdapter(reviewerName);
  } catch {
    throw new Error(
      `Unknown reviewer adapter '${reviewerName}'. Supported adapters: ${listAdapters().join(", ")}. ` +
      "Use --reviewer-script for custom paths."
    );
  }
  if (!descriptor.capabilities({ phase }).supported) {
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

  const candidate = descriptor.metadata.reviewScript;
  if (!candidate) {
    throw new Error(`Reviewer adapter '${reviewerName}' supports ${phase} but has no registered reviewer script.`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`No reviewer adapter script found for '${reviewerName}' phase ${phase}. Provide --reviewer-script or --review-file.`);
  }
  return candidate;
}

function invokeReviewer({
  phase = ADAPTER_PHASES.PRIMARY_REVIEW,
  passPhase = false,
  promptTransportEvidencePath = null,
  repoPath,
  promptPath,
  reviewerName,
  reviewerScript,
  reviewerModel,
  invocation = null,
}) {
  let command = process.execPath;
  let execArgs;
  let cwd = repoPath;
  if (passPhase) {
    const builtInvocation = invocation || getAdapter(reviewerName).buildInvocation({
      phase,
      cwd: repoPath,
      promptPath,
      resultPath: path.join(path.dirname(promptPath), `${path.basename(promptPath)}.review-result.json`),
      model: reviewerModel,
      timeoutMs: 1800000,
      sandbox: "read-only",
      networkAccess: "disabled",
    });
    command = builtInvocation.command;
    execArgs = builtInvocation.args;
    cwd = builtInvocation.cwd;
    assertInvocationIdentity(builtInvocation);
  } else {
    execArgs = [
      reviewerScript,
      "--repo", repoPath,
      "--prompt-file", promptPath,
      "--json",
    ];
    if (reviewerModel) execArgs.push("--model", reviewerModel);
  }

  const rawText = execFileSync(command, execArgs, {
    cwd,
    encoding: "utf-8",
    ...(promptTransportEvidencePath
      ? {
        env: {
          ...process.env,
          [PROMPT_TRANSPORT_EVIDENCE_ENV]: promptTransportEvidencePath,
        },
      }
      : {}),
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return {
    reviewerName,
    reviewerScript,
    rawText,
  };
}

function resolveReviewerModel(data, reviewerModel) {
  const bound = data?.review?.model ?? data?.review?.last_model ?? null;
  if (bound && reviewerModel && reviewerModel !== bound) {
    throw new Error(`--reviewer-model cannot replace immutable run binding '${bound}'`);
  }
  if (bound) return { model: bound, source: "manifest_binding" };
  if (reviewerModel) return { model: reviewerModel, source: "cli" };
  return { model: null, source: "adapter_default" };
}

function buildPrimaryReviewerPolicy(reviewerName, invocation = null) {
  let adapter;
  try {
    adapter = getAdapter(reviewerName);
  } catch {
    return null;
  }
  const networkAccess = "disabled";
  const requestedPolicy = {
    sandbox: "read-only",
    networkAccess,
    readOnly: true,
  };
  const capability = validateCapabilities(adapter, ADAPTER_PHASES.PRIMARY_REVIEW, {
    readOnly: true,
    sandbox: "read-only",
    networkAccess,
  });
  const auditInvocation = invocation || adapter.buildInvocation({
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    cwd: process.cwd(),
    promptPath: path.join(process.cwd(), ".relay-capability-probe-prompt"),
    resultPath: path.join(process.cwd(), ".relay-capability-probe-result"),
    model: null,
    timeoutMs: 1800000,
    sandbox: "read-only",
    networkAccess,
  });
  return {
    adapter: reviewerName,
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    requested: requestedPolicy,
    capability,
    invocation: { command: auditInvocation.command, args: auditInvocation.args },
    safe: true,
    prompt_transport: promptTransportPolicy(reviewerName),
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
}) {
  const resolvedReviewerModel = resolveReviewerModel(data, reviewerModel);
  const effectiveReviewerModel = resolvedReviewerModel.model;
  const reviewerPolicy = buildReviewerPolicy({ reviewerName, reviewerScript });
  return {
    effectiveReviewerModel,
    modelSource: resolvedReviewerModel.source,
    reviewerPolicy,
  };
}

function captureGitStatus(repoPath) {
  return git(repoPath, "status", "--short", "--untracked-files=all").trim();
}

function loadReviewText({ body, data, manifestPath, prNumber, promptPath, reviewFile, reviewRepoPath, reviewedHeadSha, reviewerModel, reviewerName, reviewerScript, round, runDir, runRepoPath, reviewerPreflight = null }) {
  if (reviewFile) {
    return { rawResponsePath: null, reviewText: readText(reviewFile) };
  }

  const {
    effectiveReviewerModel,
    modelSource,
    reviewerPolicy,
  } = reviewerPreflight || buildPrimaryReviewerPreflight({
    data,
    reviewerModel,
    reviewerName,
    reviewerScript,
  });
  const adapterManaged = isAdapterManagedReviewerScript(
    reviewerName,
    reviewerScript,
    { phase: ADAPTER_PHASES.PRIMARY_REVIEW }
  );
  const reviewerInvocation = adapterManaged
    ? getAdapter(reviewerName).buildInvocation({
      phase: ADAPTER_PHASES.PRIMARY_REVIEW,
      cwd: reviewRepoPath,
      promptPath,
      resultPath: path.join(path.dirname(promptPath), `${path.basename(promptPath)}.review-result.json`),
      model: effectiveReviewerModel,
      timeoutMs: 1800000,
      sandbox: "read-only",
      networkAccess: "disabled",
    })
    : null;
  const auditedReviewerPolicy = adapterManaged
    ? {
      ...buildPrimaryReviewerPolicy(reviewerName, reviewerInvocation),
      prompt_transport: reviewerPolicy?.prompt_transport,
    }
    : reviewerPolicy;
  if (effectiveReviewerModel && !data?.review?.model && !data?.review?.last_model) {
    data = {
      ...data,
      review: {
        ...(data.review || {}),
        model: effectiveReviewerModel,
      },
    };
    writeManifest(manifestPath, data, body);
  }
  const promptTransportEvidencePath = adapterManaged
    ? path.join(runDir, `review-round-${round}-prompt-transport.json`)
    : null;
  const invocationReviewerPolicy = promptTransportEvidencePath
    ? {
      ...auditedReviewerPolicy,
      prompt_transport: {
        ...(auditedReviewerPolicy?.prompt_transport || promptTransportPolicy(reviewerName)),
        evidence_path: promptTransportEvidencePath,
      },
    }
    : auditedReviewerPolicy;
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_INVOKE,
    state_from: data.state,
    state_to: data.state,
    head_sha: reviewedHeadSha || null,
    round,
    reason: reviewerName,
    model: effectiveReviewerModel,
    model_source: modelSource,
    reviewer_policy: invocationReviewerPolicy,
  });

  const statusBeforeReviewer = captureGitStatus(reviewRepoPath);
  const invoked = invokeReviewer({
    phase: ADAPTER_PHASES.PRIMARY_REVIEW,
    passPhase: adapterManaged,
    promptTransportEvidencePath,
    repoPath: reviewRepoPath,
    promptPath,
    reviewerModel: effectiveReviewerModel,
    reviewerName,
    reviewerScript,
    invocation: reviewerInvocation,
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
  loadReviewText,
  buildPrimaryReviewerPolicy,
  buildPrimaryReviewerPreflight,
  buildReviewerPolicy,
  preflightPrimaryReviewerCapability,
  resolveReviewerName,
  resolveReviewerModel,
  resolveReviewerScript,
};
