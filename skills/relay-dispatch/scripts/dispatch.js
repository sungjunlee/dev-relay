#!/usr/bin/env node
/**
 * Create a worktree and dispatch a task to an executor.
 *
 * Executor-agnostic orchestrator: worktree -> execute -> collect -> retain.
 * To add a new executor, add a branch in the "Execute task" section.
 *
 * Usage:
 *   ./dispatch.js <repo-path> --branch <name> --prompt <task>  [options]
 *   ./dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]
 *   ./dispatch.js <repo-path> --run-id <id> --prompt <task> [options]
 *   ./dispatch.js --manifest <path> --prompt-file <path> [options]
 *
 * Options:
 *   --branch, -b <name>    Branch name (required)
 *   --run-id <id>          Resume an existing run, or reserve id for new dispatch with --branch
 *   --manifest <path>      Resume an existing relay run from its manifest
 *   --prompt, -p <text>    Task prompt
 *   --prompt-file <path>   Read prompt from file (for large prompts)
 *   --executor, -e <name>  Executor to use (default: codex)
 *   --model, -m <name>     Model override (default: from executor config)
 *   --model-hints <spec>   Persist per-phase model hints (phase=model,...)
 *   --sandbox <mode>       workspace-write | read-only (default: workspace-write)
 *   --network-access <mode> disabled | enabled (default: disabled; codex workspace-write only)
 *   --copy <file,...>      Additional files to copy
 *   --timeout <seconds>    Exec timeout (default: 2400 for codex, 1800 for others)
 *   --reasoning <level>    Codex reasoning effort override (default by rubric size: S=medium, M=high, L/XL=xhigh)
 *   --rubric-file <path>   REQUIRED: copy rubric YAML to run dir (persists for review)
 *   --test-command <cmd>   Record the executor-side test command in execution evidence
 *   --publish-policy <mode> immediate | after-internal-review (default: immediate)
 *   --review-assurance <level> standard | hardened (default: standard)
 *   --tags <csv>          Explicit routing tags; override inferred routing tags
 *   --rubric-grandfathered Retired alias; dispatch rejects it
 *   --request-id <id>      Link the run back to a relay-ready request
 *   --leaf-id <id>         Link the run back to a relay-ready leaf handoff
 *   --done-criteria-file   Persist a frozen Done Criteria anchor path
 *   --register             Register session in executor's app (keeps worktree)
 *   --auto-recover-commit  Run recover-commit after completed-uncommitted (default: on for codex, off otherwise)
 *   --no-auto-recover-commit  Opt out of codex default auto recover-commit
 *   --detach               Launch detached supervisor and print a receipt
 *   --dry-run              Show plan without executing
 *   --json                 Output as JSON
 *
 * Examples:
 *   # Basic dispatch (default executor: codex)
 *   ./dispatch.js . -b feature-auth -p "Implement OAuth2 flow"
 *
 *   # With prompt file
 *   ./dispatch.js . -b fix-login --prompt-file TASK.md
 *
 *   # Explicit executor
 *   ./dispatch.js . -b feature-auth -e codex -p "Implement OAuth2 flow"
 *
 *   # Register session in executor app (keeps worktree for resumption)
 *   ./dispatch.js . -b feature-auth -p "..." --register
 *
 *   # Dry run
 *   ./dispatch.js . -b test --prompt "test" --dry-run --json
 */

const { execFileSync, spawn: nodeSpawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { pushAndOpenPR } = require("./dispatch-publish");
const {
  buildExecutionEvidence,
  hashFileSha256,
  writeExecutionEvidence,
} = require("./execution-evidence");
const {
  createWorktree,
  formatDispatchDryRun,
  removeWorktree,
} = require("./worktree-runtime");
const { getExecutor, listExecutors } = require("./executors");
const {
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
} = require("./manifest/environment");
const {
  createManifestSkeleton,
  readManifest,
  writeManifest,
} = require("./manifest/store");
const { parseModelHints } = require("./model-hints");
const { resolveExecutorDefaultModel } = require("./executor-model-config");
const { normalizeReviewAssurance } = require("./manifest/review-assurance");
const {
  createRunId,
  ensureRunLayout,
  getManifestPath,
  getRoutePlanPath,
  getRunDir,
  inferIssueNumber,
  looksLikeGitRepo,
  requireValidFleetId,
  sameFilesystemLocation,
  validateManifestPaths,
} = require("./manifest/paths");
const {
  acquireIssueLock,
  releaseIssueLock,
} = require("./manifest/fleet");
const {
  findInflightRunsForIssue,
  formatInflightCollisionError,
  inferIssueFromPromptOrBranch,
} = require("./manifest/inflight-runs");
const {
  getRubricAnchorStatus,
  hasRubricPath,
  rejectLegacyGrandfatherField,
  validateRubricPathContainment,
} = require("./manifest/rubric");
const { findUnknownFlags, getPositionals, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { formatAttemptsForPrompt, readPreviousAttempts } = require("./manifest/attempts");
const {
  buildGuidanceMetadata,
  extractGuidanceFromPrompt,
  extractReviewAssuranceFromPrompt,
  extractTaskProfileSummaryFromPrompt,
  GUIDANCE_METADATA_FILENAME,
  persistGuidanceMetadata,
} = require("./manifest/guidance");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, appendUnregisteredRouteUsedEvent, EVENTS } = require("./relay-events");
const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
} = require("./agent-adapters");
const {
  assertPolicyRepresentable,
  buildAdapterCapabilityFailureEnvelope,
  buildAgentPolicyAudit,
} = require("./agent-adapters/policy");
const { execGit } = require("./exec");
const { resolveReasoningEffort } = require("./rubric-size");
const {
  validateReadyLightRubric,
} = require("../../relay-plan/scripts/rubric-validation");
const {
  assertRelayPolicyGate,
  buildPolicyGateFailureEnvelope,
} = require("./relay-policy-gate");
const {
  hintForCliBinary,
  hintForPolicyDecision,
  withHint,
} = require("./route-failure-hints");
const { loadRelayPolicy } = require("./relay-policy");
const { loadProjectRoutes, resolveRouteIntent, resolveRoutingDecision } = require("./relay-routing");
const { classifyRepositoryDirt, formatRuntimeMetadataDirt } = require("./runtime-dirt");
const {
  dispatchManifestPathFields,
  getRunArtifactPaths,
  isProcessGroupAlive,
  latestRunEvent,
  removeRunLease,
  terminateProcessGroup,
  waitForProcessGroupExit,
  writeRunLease,
} = require("./run-runtime-state");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  "--branch", "-b", "--run-id", "--manifest", "--prompt", "-p", "--prompt-file", "--executor", "-e",
  "--model", "-m", "--model-hints", "--route-intent-file", "--sandbox", "--network-access", "--copy", "--timeout", "--reasoning", "--rubric-file", "--test-command", "--rubric-grandfathered",
  "--request-id", "--leaf-id", "--fleet-id", "--done-criteria-file", "--publish-policy", "--review-assurance", "--tags",
  "--register", "--auto-recover-commit", "--no-auto-recover-commit", "--allow-conflicting-run", "--detach", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "dispatch", reservedFlags: KNOWN_FLAGS };
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const JSON_OUT_REQUESTED = hasCliFlag("--json");

if (!args.length || hasCliFlag(["--help", "-h"])) {
  console.log("Usage: dispatch.js <repo-path> --branch <name> --prompt <task> [options]");
  console.log("       dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]");
  console.log("       dispatch.js <repo-path> --run-id <id> --prompt <task> [options]");
  console.log("       dispatch.js --manifest <path> --prompt-file <path> [options]");
  console.log("\nOptions:");
  console.log(`  --branch, -b       ${modeLabel("--branch")} Branch name (required)`);
  console.log(`  --run-id           ${modeLabel("--run-id")} Resume an existing run, or reserve id for new dispatch with --branch`);
  console.log(`  --manifest         ${modeLabel("--manifest")} Resume an existing relay run from its manifest`);
  console.log(`  --prompt, -p       ${modeLabel("--prompt")} Task prompt`);
  console.log(`  --prompt-file      ${modeLabel("--prompt-file")} Read prompt from file`);
  console.log(`  --executor, -e     ${modeLabel("--executor")} Executor: ${listExecutors().join(", ")} (default: codex)`);
  console.log(`  --model, -m        ${modeLabel("--model")} Model override`);
  console.log(`  --model-hints      ${modeLabel("--model-hints")} Persist per-phase model hints (phase=model,...)`);
  console.log(`  --route-intent-file ${modeLabel("--route-intent-file")} Read one-off run route intent JSON`);
  console.log(`  --sandbox          ${modeLabel("--sandbox")} workspace-write | read-only (default: workspace-write)`);
  console.log(`  --network-access   ${modeLabel("--network-access")} disabled | enabled (default: disabled; codex workspace-write only)`);
  console.log(`  --copy <files>     ${modeLabel("--copy")} Additional files to copy (comma-separated)`);
  console.log(`  --timeout          ${modeLabel("--timeout")} Exec timeout in seconds (default: 2400 for codex, 1800 for others)`);
  console.log(`  --reasoning        ${modeLabel("--reasoning")} Codex reasoning effort (default by rubric size: S=medium, M=high, L/XL=xhigh)`);
  console.log(`  --rubric-file      ${modeLabel("--rubric-file")} REQUIRED: copy rubric YAML to run dir (persists for review)`);
  console.log(`  --test-command     ${modeLabel("--test-command")} Record the executor-side test command in execution evidence`);
  console.log(`  --publish-policy   ${modeLabel("--publish-policy")} PR publication policy: immediate | after-internal-review (default: immediate)`);
  console.log(`  --review-assurance ${modeLabel("--review-assurance")} Review assurance: standard | hardened (default: standard)`);
  console.log(`  --tags             ${modeLabel("--tags")} Explicit routing tags; override inferred routing tags`);
  console.log(`  --rubric-grandfathered  ${modeLabel("--rubric-grandfathered")} Retired alias; remove anchor.rubric_grandfathered manually`);
  console.log(`  --request-id       ${modeLabel("--request-id")} Link the run back to a relay-ready request`);
  console.log(`  --leaf-id          ${modeLabel("--leaf-id")} Link the run back to a relay-ready leaf handoff`);
  console.log(`  --fleet-id         ${modeLabel("--fleet-id")} Link the run back to a relay fleet`);
  console.log(`  --done-criteria-file  ${modeLabel("--done-criteria-file")} Persist a frozen Done Criteria anchor path`);
  console.log(`  --register         ${modeLabel("--register")} Register session in executor's app (keeps worktree)`);
  console.log(`  --auto-recover-commit  ${modeLabel("--auto-recover-commit")} Run recover-commit after completed-uncommitted (default: on for codex, off otherwise)`);
  console.log(`  --no-auto-recover-commit  ${modeLabel("--no-auto-recover-commit")} Opt out of codex default auto recover-commit`);
  console.log(`  --allow-conflicting-run  ${modeLabel("--allow-conflicting-run")} Bypass the in-flight run check (logs conflicting_run_override event)`);
  console.log(`  --detach           ${modeLabel("--detach")} Launch detached supervisor and print a receipt`);
  console.log(`  --dry-run          ${modeLabel("--dry-run")} Show plan without executing`);
  console.log(`  --json             ${modeLabel("--json")} Output as JSON`);
  process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

const UNKNOWN_FLAGS = findUnknownFlags(args, "dispatch");
if (UNKNOWN_FLAGS.length) {
  console.error(`Error: unknown flags: ${UNKNOWN_FLAGS.join(", ")}`);
  process.exit(1);
}

// Positional arg: first arg that isn't a flag and isn't consumed as a flag's value.
const repoPathRaw = getPositionals(args, "dispatch")[0];
const REPO_PATH = path.resolve(repoPathRaw || ".");
const PROJECT_NAME = path.basename(REPO_PATH);
const BRANCH = readArg(args, ["--branch", "-b"], undefined, CLI_ARG_OPTIONS);
const RUN_ID = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
const MANIFEST_INPUT = readArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
const PROMPT = readArg(args, ["--prompt", "-p"], undefined, CLI_ARG_OPTIONS);
const PROMPT_FILE = readArg(args, "--prompt-file", undefined, CLI_ARG_OPTIONS);
const EXECUTOR_ARG = readArg(args, ["--executor", "-e"], undefined, CLI_ARG_OPTIONS);
const MODEL = readArg(args, ["--model", "-m"], undefined, CLI_ARG_OPTIONS);
const ROUTE_INTENT_FILE = readArg(args, "--route-intent-file", undefined, CLI_ARG_OPTIONS);
const RELAY_HOME_FOR_ROUTES = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");

function failEarly(message, extra = {}) {
  if (JSON_OUT_REQUESTED) {
    console.log(JSON.stringify({
      status: "failed",
      error: message,
      ...extra,
    }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

function readRouteIntentFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed;
  } catch (error) {
    failEarly(`failed to read route intent file at ${resolved}: ${error.message}`);
  }
}

function mergeDispatchCliIntoRunIntent(baseIntent, { executor, model }) {
  const dispatch = {
    ...(baseIntent.dispatch && typeof baseIntent.dispatch === "object" && !Array.isArray(baseIntent.dispatch)
      ? baseIntent.dispatch
      : {}),
  };
  if (executor) dispatch.executor = executor;
  if (model) dispatch.model = model;
  return {
    ...baseIntent,
    ...(Object.keys(dispatch).length ? { dispatch } : {}),
  };
}

function loadInitialRoutePlan(repoRoot) {
  const policyResult = loadRelayPolicy({ repoRoot, relayHome: RELAY_HOME_FOR_ROUTES });
  const projectRoutes = loadProjectRoutes({ repoRoot, relayHome: RELAY_HOME_FOR_ROUTES });
  if (!policyResult.ok) {
    failEarly(policyResult.errors?.[0]?.message || "failed to load relay policy", {
      policy: policyResult,
    });
  }
  if (!projectRoutes.ok) {
    failEarly(projectRoutes.error || "failed to load project routes", {
      project_routes: projectRoutes,
    });
  }
  const routeIntent = mergeDispatchCliIntoRunIntent(readRouteIntentFile(ROUTE_INTENT_FILE), {
    executor: EXECUTOR_ARG,
    model: MODEL,
  });
  return {
    routeIntent,
    projectRoutes,
    policyResult,
    routePlan: resolveRouteIntent({
      runIntent: routeIntent,
      projectRoutes: projectRoutes.routes,
      policy: policyResult.policy,
      relayHome: RELAY_HOME_FOR_ROUTES,
      repoRoot,
    }),
  };
}

const MODEL_HINTS_RAW = readArg(args, "--model-hints", undefined, CLI_ARG_OPTIONS);
const REASONING_OVERRIDE = readArg(args, "--reasoning", undefined, CLI_ARG_OPTIONS);
const SANDBOX = readArg(args, "--sandbox", "workspace-write", CLI_ARG_OPTIONS);
const NETWORK_ACCESS = readArg(args, "--network-access", "disabled", CLI_ARG_OPTIONS);
const COPY_FILES = readArg(args, "--copy", "", CLI_ARG_OPTIONS).split(",").filter(Boolean);
const RUBRIC_FILE = readArg(args, "--rubric-file", undefined, CLI_ARG_OPTIONS);
const TEST_COMMAND = readArg(args, "--test-command", undefined, CLI_ARG_OPTIONS);
const PUBLISH_POLICY_ARG = readArg(args, "--publish-policy", undefined, CLI_ARG_OPTIONS);
let PUBLISH_POLICY = PUBLISH_POLICY_ARG || "immediate";
const RUBRIC_GRANDFATHERED = hasCliFlag("--rubric-grandfathered");
const REQUEST_ID = readArg(args, "--request-id", undefined, CLI_ARG_OPTIONS);
const LEAF_ID = readArg(args, "--leaf-id", undefined, CLI_ARG_OPTIONS);
const FLEET_ID = readArg(args, "--fleet-id", undefined, CLI_ARG_OPTIONS);
const DONE_CRITERIA_FILE = readArg(args, "--done-criteria-file", undefined, CLI_ARG_OPTIONS);
const REVIEW_ASSURANCE_RAW = readArg(args, "--review-assurance", undefined, CLI_ARG_OPTIONS);
const ROUTING_TAGS = readArg(args, "--tags", "", CLI_ARG_OPTIONS);
let REVIEW_ASSURANCE;
try {
  REVIEW_ASSURANCE = normalizeReviewAssurance(REVIEW_ASSURANCE_RAW || "standard");
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
let EXECUTOR = null;
let adapter = null;
let adapterDescriptor = null;
let TIMEOUT = null;
let executorPolicy = null;
let executorNetworkPolicy = null;
let INITIAL_ROUTE_RESOLUTION = null;
let AUTO_RECOVER_COMMIT = null;

function resolveDispatchRuntime(repoRoot) {
  const routeResolution = loadInitialRoutePlan(repoRoot);
  const executor = EXECUTOR_ARG || routeResolution.routePlan.phases.dispatch?.executor || "codex";
  let resolvedAdapter;
  let resolvedAdapterDescriptor;
  try {
    resolvedAdapter = getExecutor(executor);
    resolvedAdapterDescriptor = getAgentAdapterDescriptor(executor);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const defaultTimeout = String(resolvedAdapter.defaultTimeout ?? 1800);
  const timeout = parseInt(readArg(args, "--timeout", defaultTimeout, CLI_ARG_OPTIONS), 10);
  if (isNaN(timeout) || timeout <= 0) {
    console.error("Error: --timeout must be a positive integer");
    process.exit(1);
  }
  if (!["disabled", "enabled"].includes(NETWORK_ACCESS)) {
    console.error("Error: --network-access must be disabled or enabled");
    process.exit(1);
  }
  const modeValidation = resolvedAdapter.validateExecutionMode({ sandbox: SANDBOX, networkAccess: NETWORK_ACCESS });
  if (!modeValidation.ok) {
    if (JSON_OUT_REQUESTED) {
      console.log(JSON.stringify(buildAdapterCapabilityFailureEnvelope({
        adapter: executor,
        phase: ADAPTER_PHASES.DISPATCH,
        requested: {
          sandbox: SANDBOX,
          network: NETWORK_ACCESS,
          read_only: SANDBOX === "read-only",
        },
        safe: false,
        warnings: modeValidation.warnings || [],
        fail_closed_reasons: [modeValidation.error],
      }, {
        executor,
        phase: "dispatch",
      }), null, 2));
    }
    console.error(`Error: ${modeValidation.error}`);
    process.exit(1);
  }
  for (const warn of (modeValidation.warnings || [])) {
    console.error(`Warning: ${warn}`);
  }

  let resolvedExecutorPolicy;
  try {
    resolvedExecutorPolicy = assertPolicyRepresentable(buildAgentPolicyAudit({
      descriptor: resolvedAdapterDescriptor,
      phase: ADAPTER_PHASES.DISPATCH,
      requested: {
        sandbox: SANDBOX,
        networkAccess: NETWORK_ACCESS,
        readOnly: SANDBOX === "read-only",
      },
    }));
  } catch (error) {
    if (JSON_OUT_REQUESTED) {
      console.log(JSON.stringify(buildAdapterCapabilityFailureEnvelope(error, {
        executor,
        phase: "dispatch",
      }), null, 2));
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  for (const warn of resolvedExecutorPolicy.warnings || []) {
    console.error(`Warning: ${warn}`);
  }

  return {
    adapter: resolvedAdapter,
    adapterDescriptor: resolvedAdapterDescriptor,
    autoRecoverCommit: AUTO_RECOVER_COMMIT_REQUESTED
      ? true
      : NO_AUTO_RECOVER_COMMIT
        ? false
        : executor === "codex",
    executor,
    executorNetworkPolicy: {
      access: NETWORK_ACCESS,
      mechanism: NETWORK_ACCESS === "enabled" ? "sandbox_workspace_write.network_access" : "default",
      domains: null,
    },
    executorPolicy: resolvedExecutorPolicy,
    routeResolution,
    timeout,
  };
}

function classifyNetworkFailure(text) {
  if (!text) return null;
  const patterns = [
    /CODEX_SANDBOX_NETWORK_DISABLED=1/i,
    /Could not resolve host/i,
    /error connecting to api\.github\.com/i,
    /network is unreachable/i,
    /Name or service not known/i,
    /Temporary failure in name resolution/i,
    /nodename nor servname provided/i,
    /failed to resolve .*domain/i,
  ];
  return patterns.some((pattern) => pattern.test(text)) ? "network_blocked_or_unavailable" : null;
}

let MODEL_HINTS;
try {
  MODEL_HINTS = parseModelHints(MODEL_HINTS_RAW);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

const REGISTER = hasCliFlag("--register");
const AUTO_RECOVER_COMMIT_REQUESTED = hasCliFlag("--auto-recover-commit");
const NO_AUTO_RECOVER_COMMIT = hasCliFlag("--no-auto-recover-commit");
const ALLOW_CONFLICTING_RUN = hasCliFlag("--allow-conflicting-run");
const DETACH = hasCliFlag("--detach");
const DRY_RUN = hasCliFlag("--dry-run");
const JSON_OUT = JSON_OUT_REQUESTED;
const RESUME_MODE = !!MANIFEST_INPUT || (!!RUN_ID && !BRANCH);

if (AUTO_RECOVER_COMMIT_REQUESTED && NO_AUTO_RECOVER_COMMIT) {
  console.error("Error: use either --auto-recover-commit or --no-auto-recover-commit, not both");
  process.exit(1);
}

if (DETACH && DRY_RUN) {
  console.error("Error: use either --detach or --dry-run, not both");
  process.exit(1);
}

if (FLEET_ID) {
  try {
    requireValidFleetId(FLEET_ID);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (RUN_ID && MANIFEST_INPUT) {
  console.error("Error: use either --run-id or --manifest, not both");
  process.exit(1);
}

if (!RESUME_MODE && !BRANCH) {
  console.error("Error: --branch is required for new dispatches");
  process.exit(1);
}

if (RUBRIC_FILE) {
  const rubricPath = path.resolve(RUBRIC_FILE);
  if (!fs.existsSync(rubricPath)) {
    console.error(`Error: rubric file not found: ${rubricPath}`);
    process.exit(1);
  }
}

if (RUBRIC_FILE && RUBRIC_GRANDFATHERED) {
  console.error("Error: use either --rubric-file or --rubric-grandfathered, not both");
  process.exit(1);
}

if (RUBRIC_GRANDFATHERED) {
  console.error("Error: --rubric-grandfathered is retired.");
  console.error(
    "Remove anchor.rubric_grandfathered from the manifest and persist anchor.rubric_path with --rubric-file."
  );
  process.exit(1);
}

if (DONE_CRITERIA_FILE) {
  const doneCriteriaPath = path.resolve(DONE_CRITERIA_FILE);
  if (!fs.existsSync(doneCriteriaPath)) {
    console.error(`Error: done criteria file not found: ${doneCriteriaPath}`);
    process.exit(1);
  }
}

if (!["immediate", "after-internal-review"].includes(PUBLISH_POLICY)) {
  console.error("Error: --publish-policy must be immediate or after-internal-review");
  process.exit(1);
}

if (!MANIFEST_INPUT && !fs.existsSync(path.join(REPO_PATH, ".git"))) {
  const msg = !fs.existsSync(REPO_PATH)
    ? `repo path does not exist: ${REPO_PATH}`
    : `not a git repository: ${REPO_PATH}`;
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertWithin(base, resolved, label) {
  const norm = path.resolve(resolved);
  if (!norm.startsWith(base + path.sep) && norm !== base) {
    console.error(`Error: ${label} escapes base directory: ${norm}`);
    process.exit(1);
  }
}

function isValidBaseBranchName(branch) {
  return typeof branch === "string" && branch.trim() !== "" && branch.trim() !== "HEAD";
}

function resolveOriginDefaultBranch(repoDir) {
  const remoteHeadRef = execGit(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const prefix = "refs/remotes/origin/";
  if (!remoteHeadRef.startsWith(prefix)) {
    throw new Error(`origin/HEAD resolved to unexpected ref '${remoteHeadRef}'`);
  }

  const branch = remoteHeadRef.slice(prefix.length).trim();
  if (!isValidBaseBranchName(branch)) {
    throw new Error(`origin/HEAD resolved to invalid branch '${branch || "(empty)"}'`);
  }
  return branch;
}

function resolveBaseBranchForNewDispatch(repoDir) {
  let detectedBranch = "";
  try {
    detectedBranch = execGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {}

  if (isValidBaseBranchName(detectedBranch)) {
    return detectedBranch;
  }

  try {
    const fallbackBranch = resolveOriginDefaultBranch(repoDir);
    console.error(
      `[relay-dispatch] base_branch fallback: rev-parse returned '${detectedBranch || "(empty)"}', using origin default '${fallbackBranch}'`
    );
    return fallbackBranch;
  } catch (error) {
    throw new Error(
      "unable to determine base branch for new dispatch when repository HEAD is detached. " +
      `Run 'git remote set-head origin --auto' to repair refs/remotes/origin/HEAD, then retry. (${error.message})`
    );
  }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const DETACH_RECEIPT_ENV = "RELAY_DISPATCH_DETACH_RECEIPT_PATH";
let detachReceiptWritten = false;

function removeDetachFlag(argv) {
  return argv.filter((arg) => arg !== "--detach" && !String(arg).startsWith("--detach="));
}

function appendRunIdArg(argv, runId) {
  return [...argv, "--run-id", runId];
}

function tailFile(filePath, maxBytes = 8192) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function reconcileCommandForReceipt(repoRoot, runId) {
  return `node skills/relay-dispatch/scripts/reconcile-run.js --repo ${shellQuote(repoRoot)} --run-id ${runId}`;
}

function writeJsonFileAtomically(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function ensureEmptyFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  fs.closeSync(fd);
}

function writeDetachReceiptIfRequested({ repoRoot, runId, manifestPath, runDir, stdoutLog, stderrLog }) {
  if (detachReceiptWritten) return;
  const receiptPath = process.env[DETACH_RECEIPT_ENV];
  if (!receiptPath) return;
  if (!runId || !manifestPath || !stdoutLog || !stderrLog) return;
  ensureEmptyFile(stdoutLog);
  ensureEmptyFile(stderrLog);
  writeJsonFileAtomically(receiptPath, {
    runId,
    runDir,
    manifestPath,
    stdoutLog,
    stderrLog,
    reconcileCommand: reconcileCommandForReceipt(repoRoot, runId),
  });
  detachReceiptWritten = true;
  delete process.env[DETACH_RECEIPT_ENV];
}

function buildDetachReceipt({ repoRoot, runId, manifestPath, runDir, stdoutLog, stderrLog, note = null }) {
  return {
    runId,
    runDir,
    manifestPath,
    stdoutLog,
    stderrLog,
    reconcileCommand: reconcileCommandForReceipt(repoRoot, runId),
    ...(note ? { note } : {}),
  };
}

function buildFallbackReceiptForRun({ repoRoot, runId, manifestPath, note }) {
  const paths = getRunArtifactPaths(repoRoot, runId);
  return buildDetachReceipt({
    repoRoot,
    runId,
    manifestPath,
    runDir: paths.runDir,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    note,
  });
}

function planDetachedLaunch() {
  const childArgs = removeDetachFlag(args);

  if (!RESUME_MODE) {
    const runId = RUN_ID || createRunId({ issueNumber: inferIssueNumber(BRANCH), branch: BRANCH });
    const plannedChildArgs = RUN_ID ? childArgs : appendRunIdArg(childArgs, runId);
    return {
      childArgs: plannedChildArgs,
      fallbackReceipt: buildFallbackReceiptForRun({
        repoRoot: REPO_PATH,
        runId,
        manifestPath: getManifestPath(REPO_PATH, runId),
        note: "detached supervisor is still running; the child receipt was not written before the parent wait ceiling. The manifest may appear after setup finishes. Use the logs or reconcile command to follow progress.",
      }),
    };
  }

  try {
    const manifestPath = MANIFEST_INPUT ? path.resolve(MANIFEST_INPUT) : getManifestPath(REPO_PATH, RUN_ID);
    if (!fs.existsSync(manifestPath)) {
      return { childArgs, fallbackReceipt: null };
    }
    const record = readManifest(manifestPath);
    const runId = record.data?.run_id || RUN_ID;
    const repoRoot = record.data?.paths?.repo_root ? path.resolve(record.data.paths.repo_root) : REPO_PATH;
    if (!runId) {
      return { childArgs, fallbackReceipt: null };
    }
    return {
      childArgs,
      fallbackReceipt: buildFallbackReceiptForRun({
        repoRoot,
        runId,
        manifestPath,
        note: "detached supervisor is still running; the child receipt was not written before the parent wait ceiling. Use the logs or reconcile command to follow progress.",
      }),
    };
  } catch {
    return { childArgs, fallbackReceipt: null };
  }
}

async function waitForDetachReceipt({ receiptPath, stderrPath, stdoutPath, child, fallbackReceipt = null, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  while (true) {
    if (fs.existsSync(receiptPath)) {
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
      } catch {
        await sleepAsync(25);
        continue;
      }
      if (!receipt.runId) {
        throw new Error(`detached dispatch wrote an invalid receipt without runId: ${receiptPath}`);
      }
      return receipt;
    }
    if (childExit) {
      const stderrTail = tailFile(stderrPath);
      const stdoutTail = tailFile(stdoutPath);
      const detail = stderrTail || stdoutTail || `child exited code=${childExit.code} signal=${childExit.signal || "none"}`;
      throw new Error(`detached dispatch exited before receipt: ${detail}`);
    }
    if (Date.now() >= deadline && fallbackReceipt) {
      return fallbackReceipt;
    }
    await sleepAsync(50);
  }
}

async function launchDetachedAndExit() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-detach-"));
  const receiptPath = path.join(tmpDir, "receipt.json");
  const stdoutPath = path.join(tmpDir, "supervisor-stdout.log");
  const stderrPath = path.join(tmpDir, "supervisor-stderr.log");
  const detachedLaunch = planDetachedLaunch();
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  let child;
  try {
    child = nodeSpawn(process.execPath, [__filename, ...detachedLaunch.childArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [DETACH_RECEIPT_ENV]: receiptPath,
      },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
  }
  child.unref();
  const receipt = await waitForDetachReceipt({
    receiptPath,
    stderrPath,
    stdoutPath,
    child,
    fallbackReceipt: detachedLaunch.fallbackReceipt,
  });
  const output = {
    status: "detached",
    ...receipt,
    supervisorPid: child.pid,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Detached dispatch launched: ${output.runId}`);
    console.log(`  Manifest:  ${output.manifestPath}`);
    console.log(`  Stdout log: ${output.stdoutLog}`);
    console.log(`  Stderr log: ${output.stderrLog}`);
    console.log(`  Reconcile:  ${output.reconcileCommand}`);
    if (output.note) console.log(`  Note:       ${output.note}`);
  }
}

function localBranchExists(repoRoot, branch) {
  if (!repoRoot || !branch) return false;
  try {
    execFileSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function formatMissingResumeWorktreeError({ repoRoot, runId, worktreePath, branch, baseBranch }) {
  let reprovisionCommand = null;
  if (branch && localBranchExists(repoRoot, branch)) {
    reprovisionCommand = `git worktree add ${shellQuote(worktreePath)} ${shellQuote(branch)}`;
  } else if (branch && baseBranch) {
    reprovisionCommand = `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branch)} ${shellQuote(baseBranch)}`;
  }
  // An externally deleted directory can still be REGISTERED as a worktree (and
  // its branch marked checked out there), which would make a bare `worktree add`
  // fail — clear the stale registration first.
  const unregisterCommand = `git worktree remove --force ${shellQuote(worktreePath)} 2>/dev/null || git worktree prune`;
  return [
    `retained worktree is missing for run '${runId}': ${worktreePath || "(unset)"}`,
    ...(reprovisionCommand
      ? [
          "Re-provision the retained worktree before resuming (clears any stale registration first):",
          `  ${unregisterCommand}`,
          `  ${reprovisionCommand}`,
        ]
      : [
          "Re-provision the retained worktree before resuming with create-worktree.js, then retry.",
        ]),
  ].join("\n");
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POSIX_LEASE_GATE_SCRIPT = [
  "lease_path=$1",
  "expected_pid=$2",
  "expected_pgid=$$",
  "shift 2",
  "attempt=0",
  "lease_matches() {",
  "  [ -f \"$lease_path\" ] || return 1",
  "  awk -v expected_pid=\"$expected_pid\" -v expected_pgid=\"$expected_pgid\" '",
  "    /\"pid\"[[:space:]]*:/ {",
  "      value = $0",
  "      sub(/^.*\"pid\"[[:space:]]*:[[:space:]]*/, \"\", value)",
  "      sub(/[^0-9].*$/, \"\", value)",
  "      if (value == expected_pid) pid_ok = 1",
  "    }",
  "    /\"pgid\"[[:space:]]*:/ {",
  "      value = $0",
  "      sub(/^.*\"pgid\"[[:space:]]*:[[:space:]]*/, \"\", value)",
  "      sub(/[^0-9].*$/, \"\", value)",
  "      if (value == expected_pgid) pgid_ok = 1",
  "    }",
  "    END { exit((pid_ok && pgid_ok) ? 0 : 1) }",
  "  ' \"$lease_path\"",
  "}",
  "while ! lease_matches; do",
  "  attempt=$((attempt + 1))",
  "  if [ \"$attempt\" -ge 600 ]; then",
  "    echo \"relay-dispatch: timed out waiting for fresh run lease: $lease_path pid=$expected_pid pgid=$expected_pgid\" >&2",
  "    exit 125",
  "  fi",
  "  sleep 0.05",
  "done",
  "exec \"$@\"",
].join("\n");

function buildLeaseGatedCommand({ cmd, args, leasePath }) {
  if (process.platform === "win32") {
    return { cmd, args };
  }
  return {
    cmd: "/bin/sh",
    args: ["-c", POSIX_LEASE_GATE_SCRIPT, "relay-dispatch-lease-gate", leasePath, String(process.pid), cmd, ...args],
  };
}

function maybePauseBeforeExecutorSpawnForTest() {
  const pauseMs = Number(process.env.RELAY_TEST_BEFORE_EXECUTOR_SPAWN_PAUSE_MS || 0);
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}

function maybePauseAfterWorktreeCreateForTest() {
  const pauseMs = Number(process.env.RELAY_TEST_AFTER_WORKTREE_CREATE_PAUSE_MS || 0);
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return Promise.resolve();
  const markerPath = process.env.RELAY_TEST_AFTER_WORKTREE_CREATE_MARKER;
  if (markerPath) {
    try {
      fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
    } catch {}
  }
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}

function validateResumeRequestLinkage(manifest, { requestId, leafId, fleetId, doneCriteriaPath }) {
  const checks = [
    {
      field: "source.request_id",
      existing: manifest?.source?.request_id || null,
      incoming: requestId || null,
    },
    {
      field: "source.leaf_id",
      existing: manifest?.source?.leaf_id || null,
      incoming: leafId || null,
    },
    {
      field: "fleet_id",
      existing: manifest?.fleet_id || null,
      incoming: fleetId || null,
    },
    {
      field: "anchor.done_criteria_path",
      existing: manifest?.anchor?.done_criteria_path || null,
      incoming: doneCriteriaPath || null,
      normalize: (value) => path.resolve(value),
    },
  ];

  for (const check of checks) {
    if (!check.incoming) continue;

    if (!check.existing) {
      throw new Error(
        `same-run resume cannot add immutable ${check.field}; intake linkage must be bound when the run is created`
      );
    }

    const normalize = check.normalize || ((value) => value);
    if (normalize(check.existing) !== normalize(check.incoming)) {
      throw new Error(
        `same-run resume cannot change immutable ${check.field} (existing: ${check.existing}, incoming: ${check.incoming})`
      );
    }
  }
}

function validateResumeReviewAssurance(manifest, incoming) {
  const existing = normalizeReviewAssurance(manifest?.policy?.review_assurance);
  const requested = normalizeReviewAssurance(incoming);
  if (existing !== requested) {
    throw new Error(
      `same-run resume cannot change immutable policy.review_assurance (existing: ${existing}, incoming: ${requested})`
    );
  }
}

function failRubricPersistence(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatManifestDisplayPath(manifestPath) {
  const resolvedPath = path.resolve(manifestPath);
  const homeDir = os.homedir();
  return resolvedPath.startsWith(`${homeDir}${path.sep}`)
    ? `~${resolvedPath.slice(homeDir.length)}`
    : resolvedPath;
}

function failRunDirCollision(runId, manifestPath) {
  console.error([
    "Refusing to overwrite existing run dir:",
    `  run_id: ${runId}`,
    `  manifest: ${formatManifestDisplayPath(manifestPath)}`,
    "Pass --run-id <id> to resume, or --manifest <path> to resume from an explicit manifest.",
  ].join("\n"));
  process.exit(1);
}

function isPlannerAnchorOnlyRunDir(runDir) {
  if (!fs.existsSync(runDir)) return false;
  const entries = fs.readdirSync(runDir).filter((entry) => entry !== ".DS_Store");
  return entries.length === 1 && entries[0] === "done-criteria.md";
}

function isCanonicalPlannerDoneCriteriaPath(repoRoot, runId, doneCriteriaPath) {
  if (!doneCriteriaPath) return false;
  const canonicalPath = path.join(getRunDir(repoRoot, runId), "done-criteria.md");
  return path.resolve(doneCriteriaPath) === canonicalPath
    || sameFilesystemLocation(doneCriteriaPath, canonicalPath);
}

function inferDoneCriteriaSource({ repoRoot, runId, doneCriteriaPath, requestId, leafId }) {
  if (!doneCriteriaPath) return null;
  if (requestId || leafId) return "request_snapshot";
  if (isCanonicalPlannerDoneCriteriaPath(repoRoot, runId, doneCriteriaPath)) {
    return "planner_decision";
  }
  return "file";
}

function copyFileAtomically(sourcePath, finalPath) {
  const tmpPath = `${finalPath}.tmp`;
  try {
    fs.copyFileSync(sourcePath, tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function getPersistedRubricPath(runDir, rubricPath = "rubric.yaml") {
  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    failRubricPersistence(containment.reason);
  }
  return containment;
}

function enforceRubricPersistence(manifest, runDir) {
  const legacyGrandfatherField = rejectLegacyGrandfatherField(manifest);
  if (!legacyGrandfatherField.ok) {
    failRubricPersistence(legacyGrandfatherField.error);
  }

  if (RUBRIC_FILE) {
    getPersistedRubricPath(runDir);
    return;
  }

  if (!hasRubricPath(manifest)) {
    failRubricPersistence(
      "--rubric-file is required. Generate the rubric with relay-plan and pass --rubric-file <path> to dispatch.js. " +
      "Retained manifests must carry anchor.rubric_path before dispatch resume."
    );
  }

  if (hasRubricPath(manifest)) {
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(
        `${rubricAnchor.error} Re-dispatch with --rubric-file to repair the run's rubric anchor, ` +
        "or remove anchor.rubric_grandfathered if the retained manifest still carries it."
      );
    }
  }
}

function readyLightTaskProfileForDispatch({ promptText, manifest }) {
  // Trust only structured task_profile metadata, not arbitrary examples embedded in the prompt body.
  let promptProfile = null;
  let extractedGuidance = null;
  try {
    promptProfile = extractTaskProfileSummaryFromPrompt(promptText);
    extractedGuidance = promptProfile ? null : extractGuidanceFromPrompt(promptText);
  } catch (error) {
    failEarly(`Invalid task_profile metadata in prompt: ${error.message}`, {
      error_code: "task_profile_parse_failed",
    });
  }
  const manifestProfile = manifest?.advisory?.guidance?.task_profile_summary || null;
  const taskProfile = promptProfile
    || extractedGuidance?.task_profile_summary
    || manifestProfile
    || null;
  if (!taskProfile) return null;

  const manifestMarker = manifestProfile?.planning_profile || manifestProfile?.route_decision || manifestProfile?.routeDecision || null;
  if (manifestMarker && !taskProfile.planning_profile && !taskProfile.route_decision && !taskProfile.routeDecision) {
    return { ...taskProfile, route_decision: manifestMarker };
  }
  return taskProfile;
}

function readRubricForReadyLightValidation({ rubricFile, manifest, runDir }) {
  if (rubricFile) {
    try {
      return fs.readFileSync(path.resolve(rubricFile), "utf-8");
    } catch (error) {
      failEarly(`Failed to read rubric file: ${error.message}`, {
        error_code: "rubric_file_read_failed",
        rubric_file: rubricFile,
      });
    }
  }

  if (!hasRubricPath(manifest)) return null;
  const rubricAnchor = getRubricAnchorStatus(manifest, { runDir, includeContent: true });
  if (!rubricAnchor.satisfied) {
    failRubricPersistence(rubricAnchor.error);
  }
  return rubricAnchor.content;
}

function enforceReadyLightRubricValidation({ rubricFile, promptText, manifest, runDir }) {
  const taskProfile = readyLightTaskProfileForDispatch({ promptText, manifest });
  if (!taskProfile) return;
  const rubricYaml = readRubricForReadyLightValidation({ rubricFile, manifest, runDir });
  if (!rubricYaml) return;
  const result = validateReadyLightRubric({
    rubricYaml,
    taskProfile,
  });
  if (result.action !== "block") return;
  const firstError = result.errors[0] || { code: "ready_light_rubric_invalid", message: "Ready-light rubric validation failed." };
  failEarly(firstError.message, {
    error_code: firstError.code,
    ready_light_rubric_validation: result,
  });
}

function validateExecutorCli() {
  let adapter;
  try {
    adapter = getExecutor(EXECUTOR);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const cli = adapter.cliBinary || EXECUTOR;
  let version;
  try {
    version = execFileSync(cli, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    const message = `${cli} CLI not found.`;
    const hint = hintForCliBinary(cli);
    if (JSON_OUT_REQUESTED) {
      console.log(JSON.stringify({
        status: "failed",
        error: message,
        hint,
      }, null, 2));
    }
    console.error(`Error: ${message}`);
    console.error(`hint: ${hint}`);
    process.exit(1);
  }
  return { binary: cli, version };
}

function findLatestRedispatchPrompt(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return null;
  let latest = null;
  for (const entry of fs.readdirSync(runDir)) {
    const match = /^review-round-(\d+)-redispatch\.md$/.exec(entry);
    if (!match) continue;
    const round = parseInt(match[1], 10);
    if (!Number.isFinite(round)) continue;
    if (!latest || round > latest.round) {
      latest = { round, path: path.join(runDir, entry) };
    }
  }
  return latest;
}

function readTaskPrompt({ runDir, resumeMode } = {}) {
  if (PROMPT_FILE) {
    const promptPath = path.resolve(PROMPT_FILE);
    if (!fs.existsSync(promptPath)) {
      console.error(`Error: prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    return { prompt: fs.readFileSync(promptPath, "utf-8").trim(), source: "explicit-file", path: promptPath };
  }

  if (PROMPT) {
    return { prompt: PROMPT, source: "explicit-arg", path: null };
  }

  if (resumeMode) {
    const auto = findLatestRedispatchPrompt(runDir);
    if (auto) {
      return {
        prompt: fs.readFileSync(auto.path, "utf-8").trim(),
        source: "auto-discovered-redispatch",
        path: auto.path,
        round: auto.round,
      };
    }
    console.error("Error: --prompt or --prompt-file is required");
    console.error(
      `  Auto-discovery looked for review-round-<N>-redispatch.md in ${runDir} but found none.`
    );
    process.exit(1);
  }

  console.error("Error: --prompt or --prompt-file is required");
  process.exit(1);
}

function resolveRoleBinding(envName, fallback) {
  const explicit = process.env[envName];
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : fallback;
}

function resolveEffectiveDispatchModel({ cliModel, routePlanModel, manifestModelHints, cliModelHints, executorDefaultModel }) {
  if (cliModel) return cliModel;
  if (routePlanModel) return routePlanModel;
  if (manifestModelHints && typeof manifestModelHints.dispatch === "string" && manifestModelHints.dispatch.trim()) {
    return manifestModelHints.dispatch;
  }
  if (cliModelHints && typeof cliModelHints.dispatch === "string" && cliModelHints.dispatch.trim()) {
    return cliModelHints.dispatch;
  }
  const defaultModel = typeof executorDefaultModel === "function"
    ? executorDefaultModel()
    : executorDefaultModel;
  if (defaultModel) return defaultModel;
  return null;
}

function summarizeCommitMode({ status, gitLog, uncommitted }) {
  if (status === "completed-uncommitted") {
    return "completed-uncommitted, recover-commit required";
  }
  if (status === "completed" || status === "completed-with-warning") {
    return gitLog ? "committed in-sandbox" : status;
  }
  return status;
}

function readFileIfExists(filePath) {
  if (!filePath) return null;
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function resolveRoutingRubricText({ rubricFile, manifest, runDir }) {
  if (rubricFile) return readFileIfExists(path.resolve(rubricFile));
  const rubricPath = manifest?.anchor?.rubric_path;
  if (!rubricPath || !runDir) return null;
  return readFileIfExists(path.join(runDir, rubricPath));
}

function summarizeRoutePlan(routePlan) {
  const summary = {};
  for (const [phase, value] of Object.entries(routePlan?.phases || {})) {
    if (!value) continue;
    summary[phase] = {
      actor: value.executor || value.reviewer || null,
      actor_field: value.executor ? "executor" : "reviewer",
      model: value.model || null,
      policy_reason: value.policy_decision?.reason || null,
    };
  }
  return summary;
}

function writeRoutePlanSnapshot({ repoRoot, runId, routePlan, policyResult, projectRoutes, resolvedAt = new Date().toISOString() }) {
  const routePlanPath = getRoutePlanPath(repoRoot, runId);
  const snapshot = {
    version: 1,
    resolved_at: resolvedAt,
    policy: {
      status: policyResult?.status || null,
      sources: policyResult?.sources || null,
    },
    project_routes: {
      status: projectRoutes?.status || null,
      path: projectRoutes?.path || null,
    },
    phases: routePlan.phases,
  };
  fs.mkdirSync(path.dirname(routePlanPath), { recursive: true });
  fs.writeFileSync(routePlanPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return {
    path: routePlanPath,
    snapshot,
  };
}

function collectChangedFilesForRouting(repoDir, baseBranch) {
  const candidates = [];
  if (baseBranch) {
    candidates.push([`${baseBranch}...HEAD`]);
    candidates.push([`origin/${baseBranch}...HEAD`]);
  }
  candidates.push(["--cached"]);

  for (const argsForDiff of candidates) {
    try {
      const output = execGit(repoDir, ["diff", "--name-only", ...argsForDiff]);
      if (output) return output.split("\n").filter(Boolean);
    } catch {}
  }

  try {
    return execGit(repoDir, ["status", "--porcelain"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Worktree location: relay-owned, executor-agnostic.
  // All executors share the same base — manifest tracks the exact path.
  const RELAY_HOME = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const wtBase = process.env.RELAY_WORKTREE_BASE || path.join(RELAY_HOME, "worktrees");
  const wtId = crypto.randomBytes(4).toString("hex");
  let repoRoot = REPO_PATH;
  let projectName = PROJECT_NAME;
  let wtPath = path.join(wtBase, wtId, PROJECT_NAME);
  let resultFile = null;
  let stdoutLog = null;
  let stderrLog = null;
  const resolvedDoneCriteriaPath = DONE_CRITERIA_FILE ? path.resolve(DONE_CRITERIA_FILE) : null;
  let branch = BRANCH;
  let runId = RUN_ID;
  let manifestPath = MANIFEST_INPUT ? path.resolve(MANIFEST_INPUT) : null;
  let cleanupPolicy = "on_close";
  let baseBranch = "main";
  let issueNumber = inferIssueNumber(branch);
  let manifest;
  let copiedFiles = [];
  let executorPid = null;
  let executorPgid = null;
  let executorClosePromise = null;
  let dispatchStartTime = null;
  let fleetIssueLock = null;
  let handlingSignal = false;

  function releaseFleetIssueLock() {
    if (!fleetIssueLock) return;
    releaseIssueLock(fleetIssueLock);
    fleetIssueLock = null;
  }

  function persistInterruptedManifestForSignal() {
    if (!manifest || !manifestPath || !runId) return false;
    try {
      const runDir = getRunDir(repoRoot, runId);
      ensureRunLayout(repoRoot, runId);
      if (RUBRIC_FILE && !hasRubricPath(manifest)) {
        const rubricSrc = path.resolve(RUBRIC_FILE);
        const persistedRubric = getPersistedRubricPath(runDir, "rubric.yaml");
        copyFileAtomically(rubricSrc, persistedRubric.resolvedPath);
        manifest = {
          ...manifest,
          anchor: {
            ...(manifest.anchor || {}),
            rubric_path: persistedRubric.rubricPath,
          },
        };
      }
      if (!fs.existsSync(manifestPath)) {
        writeManifest(manifestPath, manifest);
      }
      return true;
    } catch {
      return false;
    }
  }

  function journalDispatchInterrupted(signal, executorTerminated) {
    if (!manifest || !runId) return;
    let runDir;
    try {
      if (!persistInterruptedManifestForSignal()) return;
      runDir = getRunDir(repoRoot, runId);
      if (!fs.existsSync(runDir)) return;
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.DISPATCH_INTERRUPTED,
        state_from: manifest.state || null,
        state_to: manifest.state || null,
        reason: "signal",
        signal,
        executor_pid: executorPid,
        executor_pgid: executorPgid,
        elapsed_s: dispatchStartTime ? Math.max(0, Math.round((Date.now() - dispatchStartTime) / 1000)) : null,
        timeout_s: TIMEOUT,
        executor_terminated: executorTerminated,
        worktree: wtPath || null,
      });
    } catch {}
  }

  function printSignalRecoveryHint(signal, executorTerminated) {
    try {
      const command = manifestPath
        ? `node skills/relay-dispatch/scripts/dispatch.js --manifest ${manifestPath}`
        : "node skills/relay-dispatch/scripts/dispatch.js --manifest <manifest-path>";
      const suffix = signal === "SIGTERM" && !executorTerminated
        ? " The executor may still be running and may complete on its own."
        : signal === "SIGINT" && executorPid && !executorTerminated
          ? " Executor termination was requested, but the process group may still be running."
        : "";
      console.error(`Dispatch interrupted by ${signal}; retained worktree at ${wtPath || "(unknown)"}. Resume with: ${command}.${suffix}`);
    } catch {}
  }

  async function handleSignal(signal) {
    if (handlingSignal) return;
    handlingSignal = true;
    let executorTerminated = false;
    if (signal === "SIGINT") {
      const pgid = executorPgid || executorPid;
      terminateProcessGroup(pgid);
      executorTerminated = await waitForProcessGroupExit(pgid);
      if (executorClosePromise) {
        await Promise.race([
          executorClosePromise.catch(() => null),
          sleepAsync(100),
        ]);
      }
    }
    journalDispatchInterrupted(signal, executorTerminated);
    releaseFleetIssueLock();
    printSignalRecoveryHint(signal, executorTerminated);
    process.exit(1);
  }

  process.once("exit", releaseFleetIssueLock);
  process.on("SIGINT", () => { void handleSignal("SIGINT"); });
  process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });

  if (RESUME_MODE) {
    const manifestRecord = resolveManifestRecord({
      repoRoot,
      manifestPath: MANIFEST_INPUT,
      runId: RUN_ID,
    });
    manifestPath = manifestRecord.manifestPath;
    manifest = manifestRecord.data;
    const validatedPaths = validateManifestPaths(manifest.paths, {
      expectedRepoRoot: MANIFEST_INPUT ? undefined : ((repoPathRaw || looksLikeGitRepo(repoRoot)) ? repoRoot : undefined),
      manifestPath,
      runId: manifest.run_id || runId,
      allowMissingWorktree: true,
      caller: "dispatch resume",
    });
    repoRoot = validatedPaths.repoRoot;
    projectName = path.basename(repoRoot);
    branch = manifest.git?.working_branch || branch;
    runId = manifest.run_id || runId;
    wtPath = validatedPaths.worktree;
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    };
    const manifestPublishPolicy = manifest.dispatch?.publish_policy || "immediate";
    if (PUBLISH_POLICY_ARG && PUBLISH_POLICY_ARG !== manifestPublishPolicy) {
      console.error(
        `Error: same-run resume cannot change dispatch.publish_policy from ${manifestPublishPolicy} to ${PUBLISH_POLICY_ARG}`
      );
      process.exit(1);
    }
    PUBLISH_POLICY = manifestPublishPolicy;
    if (!["immediate", "after-internal-review"].includes(PUBLISH_POLICY)) {
      console.error(`Error: manifest dispatch.publish_policy must be immediate or after-internal-review, got ${JSON.stringify(PUBLISH_POLICY)}`);
      process.exit(1);
    }
    cleanupPolicy = manifest.policy?.cleanup || cleanupPolicy;
    baseBranch = manifest.git?.base_branch || baseBranch;
    issueNumber = manifest.issue?.number || inferIssueNumber(branch);

    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      console.error(`Error: manifest repo root is not a git repository: ${repoRoot}`);
      process.exit(1);
    }
    const interruptibleResumeState = manifest.state === STATES.DISPATCHED || manifest.state === STATES.DRAFT;
    const latestEvent = interruptibleResumeState ? latestRunEvent(repoRoot, runId) : null;
    const resumesInterruptedDispatch = interruptibleResumeState && latestEvent?.event === EVENTS.DISPATCH_INTERRUPTED;
    if (resumesInterruptedDispatch && isProcessGroupAlive(latestEvent.executor_pgid)) {
      console.error(
        `Error: interrupted executor process group is still alive for run '${runId}' ` +
        `(pid=${latestEvent.executor_pid ?? "unknown"}, pgid=${latestEvent.executor_pgid}). ` +
        "Wait for it to finish, or kill that process group before resuming."
      );
      process.exit(1);
    }
    if (manifest.state !== STATES.CHANGES_REQUESTED && !resumesInterruptedDispatch) {
      console.error(`Error: same-run resume requires state='${STATES.CHANGES_REQUESTED}', got '${manifest.state}'`);
      process.exit(1);
    }
    if (!branch) {
      console.error(`Error: manifest ${manifestPath} is missing git.working_branch`);
      process.exit(1);
    }
    if (validatedPaths.worktreeMissing) {
      console.error(`Error: ${formatMissingResumeWorktreeError({
        repoRoot,
        runId,
        worktreePath: manifest.paths?.worktree || wtPath,
        branch,
        baseBranch,
      })}`);
      process.exit(1);
    }
    if (!wtPath || !fs.existsSync(wtPath)) {
      console.error(`Error: retained worktree is missing for run '${runId}': ${wtPath || "(unset)"}`);
      process.exit(1);
    }
    try {
      const currentBranch = execGit(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (currentBranch !== branch) {
        console.error(`Error: retained worktree HEAD is '${currentBranch}', expected '${branch}'`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: retained worktree is unusable: ${error.message}`);
      process.exit(1);
    }

    // --- Environment drift check ---
    const currentEnv = collectEnvironmentSnapshot(repoRoot, baseBranch);
    const needsDraftEnvironmentBackfill = manifest.state === STATES.DRAFT
      && resumesInterruptedDispatch
      && (
        !manifest.environment
        || ["node_version", "main_sha", "lockfile_hash", "dispatch_ts"].every((field) => manifest.environment[field] == null)
      );
    if (needsDraftEnvironmentBackfill) {
      manifest = {
        ...manifest,
        environment: currentEnv,
      };
      writeManifest(manifestPath, manifest);
    }
    const drift = compareEnvironmentSnapshot(manifest.environment, currentEnv);
    if (drift.length) {
      const driftMsg = drift.map(d => `${d.field}: ${d.from} → ${d.to}`).join(", ");
      if (!JSON_OUT) {
        console.error(`[WARN] Environment drift detected since initial dispatch: ${driftMsg}`);
      }
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.ENVIRONMENT_DRIFT,
        state_from: manifest.state,
        state_to: manifest.state,
        reason: driftMsg,
      });
    }
  } else {
    const issueForCollisionCheck = issueNumber
      || inferIssueFromPromptOrBranch(branch, PROMPT);
    const inflightRuns = issueForCollisionCheck
      ? findInflightRunsForIssue(repoRoot, issueForCollisionCheck)
      : [];
    if (inflightRuns.length > 0 && !ALLOW_CONFLICTING_RUN) {
      console.error("Error: " + formatInflightCollisionError(inflightRuns, { issueNumber: issueForCollisionCheck }));
      process.exit(1);
    }
    runId = runId || createRunId({ issueNumber, branch });
    if (FLEET_ID && issueForCollisionCheck && !DRY_RUN) {
      try {
        fleetIssueLock = acquireIssueLock({
          repoRoot,
          issueNumber: issueForCollisionCheck,
          fleetId: FLEET_ID,
          runId,
        });
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }
    manifestPath = getManifestPath(repoRoot, runId);
    const runDir = getRunDir(repoRoot, runId);
    if (fs.existsSync(manifestPath) || (fs.existsSync(runDir) && !isPlannerAnchorOnlyRunDir(runDir))) {
      failRunDirCollision(runId, manifestPath);
    }
    baseBranch = resolveBaseBranchForNewDispatch(repoRoot);
    if (fs.existsSync(wtPath)) {
      console.error(`Error: worktree path already exists: ${wtPath}`);
      process.exit(1);
    }
    if (inflightRuns.length > 0 && ALLOW_CONFLICTING_RUN) {
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.CONFLICTING_RUN_OVERRIDE,
        state_from: STATES.DRAFT,
        state_to: STATES.DRAFT,
        reason: `bypassed ${inflightRuns.length} non-terminal run(s) for issue-${issueForCollisionCheck}: ${inflightRuns.map((run) => run.runId).join(", ")}`,
      });
    }
  }

  const runtime = resolveDispatchRuntime(repoRoot);
  EXECUTOR = runtime.executor;
  adapter = runtime.adapter;
  adapterDescriptor = runtime.adapterDescriptor;
  TIMEOUT = runtime.timeout;
  executorPolicy = runtime.executorPolicy;
  executorNetworkPolicy = runtime.executorNetworkPolicy;
  INITIAL_ROUTE_RESOLUTION = runtime.routeResolution;
  AUTO_RECOVER_COMMIT = runtime.autoRecoverCommit;
  const runArtifactPaths = getRunArtifactPaths(repoRoot, runId);
  resultFile = runArtifactPaths.resultFile;
  stdoutLog = runArtifactPaths.stdoutLog;
  stderrLog = runArtifactPaths.stderrLog;
  const manifestPathFields = dispatchManifestPathFields(runArtifactPaths);

  if (RESUME_MODE) {
    try {
      validateResumeRequestLinkage(manifest, {
        requestId: REQUEST_ID,
        leafId: LEAF_ID,
        fleetId: FLEET_ID,
        doneCriteriaPath: resolvedDoneCriteriaPath,
      });
      if (REVIEW_ASSURANCE_RAW !== undefined) {
        validateResumeReviewAssurance(manifest, REVIEW_ASSURANCE);
      } else {
        REVIEW_ASSURANCE = normalizeReviewAssurance(manifest?.policy?.review_assurance);
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  const manifestRunDir = getRunDir(repoRoot, runId);
  enforceRubricPersistence(manifest, manifestRunDir);
  let routePlanSnapshot = null;

  const taskPromptResult = readTaskPrompt({ runDir: manifestRunDir, resumeMode: RESUME_MODE });
  let taskPrompt = taskPromptResult.prompt;
  if (!RESUME_MODE && REVIEW_ASSURANCE_RAW === undefined) {
    try {
      REVIEW_ASSURANCE = extractReviewAssuranceFromPrompt(taskPrompt) || REVIEW_ASSURANCE;
    } catch (error) {
      failEarly(`Invalid task_profile metadata in prompt: ${error.message}`, {
        error_code: "task_profile_parse_failed",
      });
    }
  }
  if (taskPromptResult.source === "auto-discovered-redispatch" && !JSON_OUT) {
    console.log(`Auto-discovered redispatch prompt (round ${taskPromptResult.round}): ${taskPromptResult.path}`);
  }

  // --- Prepend iteration history on re-dispatch ---
  if (RESUME_MODE) {
    const previousAttempts = readPreviousAttempts(repoRoot, runId);
    const historySection = formatAttemptsForPrompt(previousAttempts);
    if (historySection) {
      taskPrompt = historySection + taskPrompt;
    }
  }

  if (RESUME_MODE && MODEL_HINTS !== undefined) {
    const beforeModelHints = manifest.model_hints ?? null;
    manifest = {
      ...manifest,
      model_hints: MODEL_HINTS,
    };
    if (!DRY_RUN) {
      writeManifest(manifestPath, manifest);
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.MODEL_HINTS_UPDATED,
        state_from: manifest.state,
        state_to: manifest.state,
        head_sha: manifest.git?.head_sha || null,
        reason: "dispatch_cli_replace",
        before: beforeModelHints,
        after: MODEL_HINTS,
      });
    }
  }

  enforceReadyLightRubricValidation({
    rubricFile: RUBRIC_FILE,
    promptText: taskPrompt,
    manifest,
    runDir: manifestRunDir,
  });

  const effectiveDispatchModel = resolveEffectiveDispatchModel({
    cliModel: MODEL,
    routePlanModel: INITIAL_ROUTE_RESOLUTION.routePlan.phases.dispatch?.model || null,
    manifestModelHints: manifest?.model_hints,
    cliModelHints: MODEL_HINTS,
    executorDefaultModel: () => resolveExecutorDefaultModel(EXECUTOR, { relayHome: RELAY_HOME, repoRoot }),
  });
  const provider = typeof adapter.parseProvider === "function"
    ? (adapter.parseProvider(effectiveDispatchModel) ?? adapter.providerDefault ?? null)
    : (adapter.providerDefault || null);
  let policyDecision;
  try {
    policyDecision = assertRelayPolicyGate({
      repoRoot,
      relayHome: RELAY_HOME,
      phase: "dispatch",
      executor: EXECUTOR,
      model: effectiveDispatchModel,
    });
  } catch (error) {
    const envelope = buildPolicyGateFailureEnvelope(error, {
      runId,
      manifestPath,
      executor: EXECUTOR,
      model: effectiveDispatchModel,
      phase: "dispatch",
      adapter_capability: executorPolicy,
      executor_policy: executorPolicy,
      route_plan: {
        version: 1,
        phases: INITIAL_ROUTE_RESOLUTION.routePlan.phases,
        project_routes: {
          status: INITIAL_ROUTE_RESOLUTION.projectRoutes.status,
          path: INITIAL_ROUTE_RESOLUTION.projectRoutes.path,
        },
      },
    });
    const hint = hintForPolicyDecision(envelope.policy_decision);
    if (JSON_OUT) {
      console.log(JSON.stringify(withHint(envelope, hint), null, 2));
    } else {
      console.error(`Error: ${envelope.error}`);
    }
    if (hint) console.error(`hint: ${hint}`);
    process.exit(1);
  }

  const effectivePolicy = loadRelayPolicy({ repoRoot, relayHome: RELAY_HOME });
  const routePlan = {
    ...INITIAL_ROUTE_RESOLUTION.routePlan,
    phases: {
      ...(INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}),
      dispatch: {
        ...((INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}).dispatch || {}),
        phase: "dispatch",
        executor: EXECUTOR,
        model: effectiveDispatchModel,
        source: EXECUTOR_ARG ? "run_intent" : ((INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}).dispatch?.source || "policy_defaults"),
        sources: {
          ...(((INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}).dispatch || {}).sources || {}),
          executor: EXECUTOR_ARG ? "run_intent" : (((INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}).dispatch || {}).sources?.executor || "policy_defaults"),
          model: MODEL
            ? "run_intent"
            : effectiveDispatchModel
              ? ((((INITIAL_ROUTE_RESOLUTION.routePlan.phases || {}).dispatch || {}).sources?.model) || "executor_defaults")
              : "unresolved",
        },
        policy_decision: policyDecision,
      },
    },
  };
  const routingDecision = resolveRoutingDecision({
    policy: effectivePolicy.policy || {},
    cliTags: ROUTING_TAGS,
    taskProfile: manifest?.advisory?.guidance?.task_profile_summary || null,
    promptText: taskPrompt,
    rubricText: resolveRoutingRubricText({
      rubricFile: RUBRIC_FILE,
      manifest,
      runDir: manifestRunDir,
    }),
    changedFiles: collectChangedFilesForRouting(RESUME_MODE ? wtPath : repoRoot, baseBranch),
    testCommands: TEST_COMMAND ? [TEST_COMMAND] : [],
  });

  // --- Dry run ---
  if (DRY_RUN) {
    const planFleetId = FLEET_ID || manifest?.fleet_id || null;
    const worktreePlan = createWorktree({
      repoRoot,
      worktreePath: wtPath,
      branch,
      title: `Dispatch: ${branch}`,
      register: REGISTER,
      dryRun: true,
    });
    const plan = {
      mode: RESUME_MODE ? "resume" : "new",
      runId,
      manifestPath,
      executor: EXECUTOR, worktree: wtPath, branch,
      prompt: taskPrompt.slice(0, 200),
      model: MODEL, sandbox: SANDBOX, networkAccess: NETWORK_ACCESS, register: REGISTER,
      resultFile, stdoutLog, stderrLog, timeout: TIMEOUT,
      cleanupPolicy,
      worktreeinclude: worktreePlan.worktreeinclude,
      rubricFile: RUBRIC_FILE || null,
      requestId: REQUEST_ID || manifest?.source?.request_id || null,
      leafId: LEAF_ID || manifest?.source?.leaf_id || null,
      doneCriteriaFile: resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null,
      reviewAssurance: REVIEW_ASSURANCE,
      environment: RESUME_MODE ? (manifest?.environment || null) : "collected-at-dispatch",
      runState: manifest?.state || null,
      dispatchSkipped: false,
      policy_decision: policyDecision,
      route_plan: {
        version: 1,
        phases: routePlan.phases,
        policy: {
          status: effectivePolicy.status,
          sources: effectivePolicy.sources,
        },
        project_routes: {
          status: INITIAL_ROUTE_RESOLUTION.projectRoutes.status,
          path: INITIAL_ROUTE_RESOLUTION.projectRoutes.path,
        },
      },
      routing_decision: routingDecision,
    };
    if (planFleetId) {
      plan.fleetId = planFleetId;
    }
    if (MODEL_HINTS !== undefined || manifest?.model_hints !== undefined) {
      plan.model_hints = MODEL_HINTS ?? manifest?.model_hints ?? null;
    }
    if (effectiveDispatchModel !== null) {
      plan.effective_dispatch_model = effectiveDispatchModel;
    }
    if (JSON_OUT) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(formatDispatchDryRun({
        runId,
        mode: RESUME_MODE ? "resume" : "new",
        executor: EXECUTOR,
        repoRoot,
        manifestPath,
        prompt: taskPrompt,
        model: effectiveDispatchModel,
        sandbox: SANDBOX,
        networkAccess: NETWORK_ACCESS,
        register: REGISTER,
        resultFile,
        cleanupPolicy,
        timeout: TIMEOUT,
        rubricFile: RUBRIC_FILE || null,
        requestId: REQUEST_ID || manifest?.source?.request_id || null,
        leafId: LEAF_ID || manifest?.source?.leaf_id || null,
        fleetId: planFleetId,
        doneCriteriaFile: resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null,
        reviewAssurance: REVIEW_ASSURANCE,
        policyDecision,
        routingDecision,
        worktreePlan,
      }));
    }
    return;
  }

  const executorCli = validateExecutorCli();
  executorPolicy = {
    ...executorPolicy,
    cli: executorCli,
  };

  if (!RESUME_MODE) {
    manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch,
      issueNumber,
      worktreePath: wtPath,
      orchestrator: resolveRoleBinding("RELAY_ORCHESTRATOR", "unknown"),
      executor: EXECUTOR,
      reviewer: resolveRoleBinding("RELAY_REVIEWER", "unknown"),
      cleanupPolicy,
      requestId: REQUEST_ID || null,
      leafId: LEAF_ID || null,
      doneCriteriaPath: resolvedDoneCriteriaPath,
      doneCriteriaSource: inferDoneCriteriaSource({
        repoRoot,
        runId,
        doneCriteriaPath: resolvedDoneCriteriaPath,
        requestId: REQUEST_ID,
        leafId: LEAF_ID,
      }),
      reviewAssurance: REVIEW_ASSURANCE,
      modelHints: MODEL_HINTS,
      fleetId: FLEET_ID,
    });
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        ...manifestPathFields,
      },
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
      dispatch: {
        ...(manifest.dispatch || {}),
        publish_policy: PUBLISH_POLICY,
      },
      routing: routingDecision,
      routes: {
        plan_path: "route-plan.json",
        summary: summarizeRoutePlan(routePlan),
      },
    };
    try {
      const created = createWorktree({
        repoRoot,
        worktreePath: wtPath,
        branch,
        title: `Dispatch: ${branch}`,
        copyFiles: COPY_FILES,
        register: false,
        assertWithin,
      });
      copiedFiles = created.copiedFiles;
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    await maybePauseAfterWorktreeCreateForTest();

    // Merge base branch into worktree so the executor works on merged state.
    // Prevents wasted rounds from stale-base conflicts or CI failures.
    // On merge conflict, the worktree is cleaned up and dispatch aborts.
    let fetchSucceeded = false;
    try {
      execGit(wtPath, ["fetch", "origin", baseBranch]);
      fetchSucceeded = true;
    } catch (fetchErr) {
      const msg = (fetchErr.stderr || fetchErr.message || String(fetchErr)).split("\n")[0];
      if (!msg.includes("does not appear to be a git repository")) {
        if (!JSON_OUT) console.log(`  Note: skipping base-branch merge (${msg})`);
      }
    }
    if (fetchSucceeded) {
      try {
        execGit(wtPath, ["merge", `origin/${baseBranch}`, "--no-edit"]);
      } catch (mergeErr) {
        try { execGit(wtPath, ["merge", "--abort"]); } catch {}
        removeWorktree({ repoRoot, worktreePath: wtPath });
        const reason = (mergeErr.stderr || mergeErr.message || String(mergeErr)).split("\n")[0];
        console.error(`Error: failed to merge origin/${baseBranch} into worktree: ${reason}`);
        process.exit(1);
      }
    }

    const environment = collectEnvironmentSnapshot(repoRoot, baseBranch);
    manifest = {
      ...manifest,
      environment,
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
      routing: routingDecision,
      routes: {
        plan_path: "route-plan.json",
        summary: summarizeRoutePlan(routePlan),
      },
    };
    ensureRunLayout(repoRoot, runId);
    routePlanSnapshot = writeRoutePlanSnapshot({
      repoRoot,
      runId,
      routePlan,
      policyResult: effectivePolicy,
      projectRoutes: INITIAL_ROUTE_RESOLUTION.projectRoutes,
    });
    writeManifest(manifestPath, manifest);
  } else if (manifest) {
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        ...manifestPathFields,
      },
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
      routing: routingDecision,
      routes: {
        ...(manifest.routes || {}),
        plan_path: "route-plan.json",
        summary: summarizeRoutePlan(routePlan),
      },
    };
    routePlanSnapshot = writeRoutePlanSnapshot({
      repoRoot,
      runId,
      routePlan,
      policyResult: effectivePolicy,
      projectRoutes: INITIAL_ROUTE_RESOLUTION.projectRoutes,
    });
    writeManifest(manifestPath, manifest);
  }

  // --- Copy rubric file to run dir ---
  if (RUBRIC_FILE) {
    const rubricSrc = path.resolve(RUBRIC_FILE);
    const runDir = getRunDir(repoRoot, runId);
    const persistedRubric = getPersistedRubricPath(runDir, "rubric.yaml");
    const rubricDest = persistedRubric.resolvedPath;
    copyFileAtomically(rubricSrc, rubricDest);
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: persistedRubric.rubricPath,
      },
    };
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(rubricAnchor.error);
    }
    writeManifest(manifestPath, manifest);
  }

  if (routePlanSnapshot) {
    appendRunEvent(repoRoot, runId, {
      event: EVENTS.ROUTE_RESOLUTION,
      state_from: manifest.state,
      state_to: manifest.state,
      head_sha: manifest.git?.head_sha || null,
      reason: ROUTE_INTENT_FILE ? "route_intent_file" : "resolved_defaults",
      executor: EXECUTOR,
      model: effectiveDispatchModel,
      policy_decision: policyDecision,
      route_plan_path: routePlanSnapshot.path,
      route_plan_summary: summarizeRoutePlan(routePlan),
    });
    appendUnregisteredRouteUsedEvent(repoRoot, runId, {
      state: manifest.state,
      headSha: manifest.git?.head_sha || null,
      policyDecision,
    });
  }

  const guidanceMetadata = buildGuidanceMetadata({
    promptText: taskPrompt,
    manifest,
    promptSource: taskPromptResult.source,
    rubricPath: manifest?.anchor?.rubric_path || null,
  });
  if (guidanceMetadata) {
    const runDir = getRunDir(repoRoot, runId);
    try {
      manifest = persistGuidanceMetadata({ runDir, manifest, metadata: guidanceMetadata });
      writeManifest(manifestPath, manifest);
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.GUIDANCE_SELECTED,
        state_from: manifest.state,
        state_to: manifest.state,
        head_sha: manifest.git?.head_sha || null,
        reason: RESUME_MODE ? "same_run_resume" : "new_dispatch",
        guidance_packs: guidanceMetadata.guidance_packs,
        task_profile_summary: guidanceMetadata.task_profile_summary,
        guidance_source: guidanceMetadata.source,
        guidance_artifact_path: GUIDANCE_METADATA_FILENAME,
      });
    } catch (guidanceError) {
      console.error(`Error: failed to persist guidance metadata: ${guidanceError.message}`);
      process.exit(1);
    }
  }

  // --- Step 3: Execute task ---
  // Executor adapter builds command + args + spawn cwd.

  let cmd, execArgs;
  let execCwd;
  let codexGitCommonDir = null;
  const reasoningRunDir = getRunDir(repoRoot, runId);
  const rubricPathForReasoning = manifest?.anchor?.rubric_path
    ? path.join(reasoningRunDir, manifest.anchor.rubric_path)
    : null;
  const resolvedReasoningEffort = resolveReasoningEffort({
    override: REASONING_OVERRIDE,
    rubricPath: rubricPathForReasoning,
  });

  // Prepend non-interactive directive so the model doesn't wait for approval
  // (e.g. brainstorming HARD-GATE or design-confirmation patterns).
  const execPrompt =
    "[NON-INTERACTIVE DISPATCH] This is an automated, non-interactive execution. " +
    "Do not present plans for approval or wait for user confirmation. " +
    "Execute the task fully and autonomously.\n\n" +
    taskPrompt;

  const buildResult = adapter.buildExecCommand({
    wtPath,
    resultFile,
    prompt: execPrompt,
    model: effectiveDispatchModel,
    sandbox: SANDBOX,
    networkAccess: NETWORK_ACCESS,
    reasoning: resolvedReasoningEffort,
    timeoutSeconds: TIMEOUT,
  });
  cmd = buildResult.cmd;
  execArgs = buildResult.args;
  execCwd = buildResult.cwd;
  codexGitCommonDir = buildResult.codexGitCommonDir || null;

  if (EXECUTOR === "opencode") {
    console.error("Warning: opencode executor is experimental; see relay-dispatch/references/reviewer-policy-opencode.md for trust boundary and reviewer policy.");
  }
  if (EXECUTOR === "cursor") {
    console.error("Warning: cursor executor uses the optional Cursor Agent CLI (agent); add cursor to route policy managed_cli when using slug-only models. See relay-dispatch/references/agent-adapter-platform.md.");
  }

  if (!JSON_OUT) {
    console.log(`Dispatching to ${EXECUTOR}...`);
    console.log(`  Run:      ${runId}`);
    console.log(`  Worktree: ${wtPath}`);
    console.log(`  Branch:   ${branch}`);
    console.log(`  Manifest: ${manifestPath}`);
    if (copiedFiles.length) console.log(`  Copied:   ${copiedFiles.join(", ")}`);
    console.log(`  Network:  ${NETWORK_ACCESS}`);
    console.log(`  Result:   ${resultFile}`);
  }

  let exitCode = 0;
  let error = null;
  const startTime = Date.now();
  dispatchStartTime = startTime;
  let stderrText = "";

  // Record HEAD before execution so we can measure only new work.
  let startHead = "";
  try {
    startHead = execGit(wtPath, ["rev-parse", "HEAD"]);
  } catch {}

  fs.rmSync(resultFile, { force: true });
  const dispatchFromState = manifest.state;
  manifest = manifest.state === STATES.DISPATCHED
    ? {
        ...manifest,
        next_action: "await_dispatch_result",
      }
    : updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: startHead || null,
    },
    dispatch: {
      ...(manifest.dispatch || {}),
      last_executor: EXECUTOR,
      last_model: effectiveDispatchModel,
      last_provider: provider,
      publish_policy: PUBLISH_POLICY,
    },
  };
  writeManifest(manifestPath, manifest);
  appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: dispatchFromState,
    state_to: STATES.DISPATCHED,
    head_sha: startHead || null,
    reason: RESUME_MODE ? "same_run_resume" : "new_dispatch",
    executor: EXECUTOR,
    model: effectiveDispatchModel,
    provider,
    executor_network: executorNetworkPolicy,
    executor_policy: executorPolicy,
    policy_decision: policyDecision,
  });
  writeDetachReceiptIfRequested({
    repoRoot,
    runId,
    manifestPath,
    runDir: runArtifactPaths.runDir,
    stdoutLog,
    stderrLog,
  });
  await maybePauseBeforeExecutorSpawnForTest();

  // Redirect stdout/stderr to files. Using spawn with detached: true gives us
  // a killable process group (terminateProcessGroup sends SIGTERM to -pid).
  const stdoutFd = fs.openSync(stdoutLog, "w");
  const stderrFd = fs.openSync(stderrLog, "w");

  const spawnOpts = { stdio: ["ignore", stdoutFd, stderrFd], detached: true };
  if (execCwd) spawnOpts.cwd = execCwd;
  const gatedCommand = buildLeaseGatedCommand({
    cmd,
    args: execArgs,
    leasePath: runArtifactPaths.leasePath,
  });
  const child = nodeSpawn(gatedCommand.cmd, gatedCommand.args, spawnOpts);
  executorPid = child.pid;
  executorPgid = child.pid;
  if (executorPgid) {
    try {
      writeRunLease(repoRoot, runId, {
        pid: process.pid,
        pgid: executorPgid,
        timeoutS: TIMEOUT,
      });
    } catch (leaseError) {
      terminateProcessGroup(executorPgid);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      throw new Error(`lease_write_failed: ${leaseError.message}`);
    }
    writeDetachReceiptIfRequested({
      repoRoot,
      runId,
      manifestPath,
      runDir: runArtifactPaths.runDir,
      stdoutLog,
      stderrLog,
    });
  }

  executorClosePromise = new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid);
    }, TIMEOUT * 1000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, timedOut });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, timedOut, spawnError: e });
    });
  });
  const execResult = await executorClosePromise;
  if (handlingSignal) return;
  if (executorPgid) {
    const processGroupGone = await waitForProcessGroupExit(executorPgid);
    if (!processGroupGone) {
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.DISPATCH_INTERRUPTED,
        state_from: STATES.DISPATCHED,
        state_to: STATES.DISPATCHED,
        reason: "executor_group_unsettled_after_leader_close",
        signal: null,
        executor_pid: executorPid,
        executor_pgid: executorPgid,
        elapsed_s: dispatchStartTime ? Math.max(0, Math.round((Date.now() - dispatchStartTime) / 1000)) : null,
        timeout_s: TIMEOUT,
        executor_terminated: false,
        worktree: wtPath || null,
      });
      throw new Error(
        `executor process group ${executorPgid} is still alive after executor leader exited; ` +
        `kept run lease at ${runArtifactPaths.leasePath}. Run reconcile-run.js for run ${runId}.`
      );
    }
  }
  removeRunLease(repoRoot, runId);
  executorClosePromise = null;
  executorPid = null;
  executorPgid = null;

  if (execResult.timedOut) {
    exitCode = 1;
    error = `executor timed out after ${TIMEOUT}s`;
  } else if (execResult.spawnError) {
    exitCode = 1;
    error = execResult.spawnError.message.split("\n")[0];
  } else if (execResult.code !== 0) {
    exitCode = execResult.code;
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  if (fs.existsSync(stderrLog)) {
    stderrText = fs.readFileSync(stderrLog, "utf-8").trim();
    if (!error && stderrText) {
      error = stderrText.split("\n").slice(0, 10).join("\n");
    }
  }
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  try {
    adapter.finalizeResult({ stdoutLog, resultFile });
  } catch (finalizeError) {
    exitCode = exitCode || 1;
    error = error || `executor_result_finalize_failed: ${String(finalizeError.message || finalizeError).split("\n")[0]}`;
  }

  // --- Step 4: Collect results ---
  let resultText = "";
  if (fs.existsSync(resultFile)) {
    resultText = fs.readFileSync(resultFile, "utf-8").trim();
  }
  const networkFailure = classifyNetworkFailure([stderrText, resultText].filter(Boolean).join("\n"));
  if (networkFailure && !error) {
    error = networkFailure;
  }

  // Only show commits created by this run (startHead..HEAD).
  let gitLog = "";
  let currentHead = startHead;
  try {
    currentHead = execGit(wtPath, ["rev-parse", "HEAD"]);
    if (startHead && currentHead !== startHead) {
      gitLog = execGit(wtPath, ["log", "--oneline", `${startHead}..HEAD`]);
    }
  } catch {}

  let diffStat = "";
  try {
    if (startHead && gitLog) {
      diffStat = execGit(wtPath, ["diff", "--stat", `${startHead}..HEAD`]);
    }
  } catch {}

  // Also capture uncommitted diff for partial runs (timeout, interrupted).
  let uncommittedDiff = "";
  try {
    const wd = execGit(wtPath, ["diff", "--stat"]);
    const staged = execGit(wtPath, ["diff", "--stat", "--cached"]);
    uncommittedDiff = [wd, staged].filter(Boolean).join("\n");
  } catch {}

  // Check for uncommitted work (executor may have worked but not committed).
  // Executor runtime metadata is not reviewable repository work.
  let rawUncommitted = "";
  try {
    rawUncommitted = execGit(wtPath, ["status", "--porcelain"]);
  } catch {}
  const dirt = classifyRepositoryDirt(rawUncommitted);
  let uncommitted = dirt.reviewableStatus;

  const hasResult = resultText !== "";

  // Detect approval-wait: executor stopped to ask for confirmation instead of working.
  const BLOCKED_PATTERNS = [
    /waiting (?:on|for) (?:your )?approval/i,
    /before (?:proceeding|editing|making changes)/i,
    /please confirm/i,
  ];
  const looksBlocked = resultText && BLOCKED_PATTERNS.some((p) => p.test(resultText));

  // Determine actual status — hasWork must be based on NEW commits/changes only.
  const hasWork = gitLog || uncommitted;
  let status;
  if (looksBlocked) {
    status = "failed";
    error = error || `executor blocked on approval: ${resultText.split("\n")[0].slice(0, 120)}`;
  } else if (!hasResult) {
    status = "failed";
    error = error || "executor produced no structured result file or summary (silent failure)";
  } else if (execResult.timedOut && hasWork) {
    status = "completed-with-warning";
  } else if (exitCode === 0 && !gitLog && dirt.hasOnlyRuntimeMetadataDirt && EXECUTOR !== "codex") {
    status = "failed";
    error = error || (
      "executor produced no reviewable repository changes; only runtime metadata dirt was detected: " +
      `${formatRuntimeMetadataDirt(rawUncommitted)}. ` +
      "Rerun dispatch after producing source changes, or close the run as a no-op."
    );
  } else if (exitCode === 0 && !gitLog && !uncommitted) {
    status = "completed-no-op";
  } else if (exitCode === 0 && !gitLog && uncommitted) {
    status = "completed-uncommitted";
  } else if (exitCode === 0 && gitLog) {
    status = "completed";
  } else {
    status = exitCode === 0 ? "completed" : "failed";
  }
  let commitMode = summarizeCommitMode({ status, gitLog, uncommitted });
  const delayedReviewHasUncommittedWork = PUBLISH_POLICY === "after-internal-review" && (
    status === "completed-uncommitted" || (status === "completed-with-warning" && uncommitted)
  );
  let delayedReviewRequiresRecover = false;
  if (delayedReviewHasUncommittedWork && !AUTO_RECOVER_COMMIT) {
    status = "failed";
    exitCode = exitCode || 1;
    error = "recover-commit required before internal review: executor left reviewable uncommitted changes";
    delayedReviewRequiresRecover = true;
  }

  let prNumber = manifest.git?.pr_number ?? null;
  let prCreatedByUs = null;
  const shouldPublishImmediately = PUBLISH_POLICY === "immediate";
  if (
    shouldPublishImmediately
    && (status === "completed" || status === "completed-with-warning")
    && !DRY_RUN
    && gitLog
  ) {
    try {
      const prResult = await pushAndOpenPR({
        repoRoot,
        wtPath,
        branch,
        baseBranch,
        resultPreview: resultText,
        runId,
        executor: EXECUTOR,
      });
      prNumber = prResult.prNumber;
      prCreatedByUs = prResult.createdByUs;
    } catch (e) {
      status = "failed";
      exitCode = exitCode || 1;
      error = `push_or_pr_failed: ${String(e.message || e).split("\n")[0]}`;
    }
  }

  // Persist dispatch artifacts in the run directory for post-mortem analysis.
  const runDir = getRunDir(repoRoot, runId);
  try {
    fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), taskPrompt, "utf-8");
  } catch {}
  try {
    const persistedResultPath = path.join(runDir, "dispatch-result.txt");
    if (resultText && path.resolve(resultFile) !== path.resolve(persistedResultPath)) {
      fs.writeFileSync(persistedResultPath, resultText, "utf-8");
    }
  } catch {}
  let executionEvidencePath = null;
  try {
    executionEvidencePath = writeExecutionEvidence(runDir, buildExecutionEvidence({
      headSha: currentHead || startHead || null,
      testCommand: TEST_COMMAND,
      resultFilePath: fs.existsSync(resultFile) ? resultFile : null,
      executor: EXECUTOR,
      testExitCode: exitCode,
    }));
  } catch (executionEvidenceError) {
    status = "failed";
    exitCode = exitCode || 1;
    error = `execution_evidence_write_failed: ${String(executionEvidenceError.message || executionEvidenceError)}`;
  }

  const dispatchSuccessState = PUBLISH_POLICY === "after-internal-review"
    ? STATES.INTERNAL_REVIEW_PENDING
    : STATES.REVIEW_PENDING;
  const dispatchSuccessNextAction = PUBLISH_POLICY === "after-internal-review"
    ? "run_internal_review"
    : "run_review";
  const dispatchTargetState = delayedReviewRequiresRecover
    ? STATES.INTERNAL_REVIEW_PENDING
    : status === "failed"
      ? STATES.ESCALATED
      : dispatchSuccessState;
  const dispatchNextAction = delayedReviewRequiresRecover
    ? "recover_commit_before_internal_review"
    : status === "failed"
      ? "inspect_dispatch_failure"
      : dispatchSuccessNextAction;
  manifest = updateManifestState(
    manifest,
    dispatchTargetState,
    dispatchNextAction
  );
  const { github: _legacyGithub, ...manifestSansGithub } = manifest;
  const { pr_number: _legacyGithubPrNumber, ...githubFields } = _legacyGithub || {};
  const github = {
    ...githubFields,
    ...(prCreatedByUs !== null ? { pr_created_by_orchestrator: prCreatedByUs } : {}),
  };
  manifest = {
    ...manifestSansGithub,
    git: {
      ...(manifestSansGithub.git || {}),
      ...(prNumber !== null ? { pr_number: prNumber } : {}),
      head_sha: currentHead || startHead || null,
    },
    ...(Object.keys(github).length ? { github } : {}),
  };
  writeManifest(manifestPath, manifest);

  const shouldAutoRecoverCommit = AUTO_RECOVER_COMMIT && !DRY_RUN && (
    status === "completed-uncommitted" ||
    (PUBLISH_POLICY === "after-internal-review" && status === "completed-with-warning" && uncommitted)
  );
  if (shouldAutoRecoverCommit) {
    const recoverCommitPath = path.join(__dirname, "recover-commit.js");
    const reason = `auto-recovered after dispatch returned ${status} with auto-recover-commit enabled (run ${runId})`;
    try {
      const recoveryOutput = execFileSync(process.execPath, [
        recoverCommitPath,
        "--repo", repoRoot,
        "--run-id", runId,
        "--reason", reason,
        "--json",
      ], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const recovery = JSON.parse(recoveryOutput);
      commitMode = "auto-recovered";
      prNumber = recovery.prNumber ?? prNumber;
      currentHead = recovery.commitSha || currentHead;
      try {
        gitLog = execGit(wtPath, ["log", "--oneline", `${startHead}..HEAD`]);
        uncommitted = classifyRepositoryDirt(execGit(wtPath, ["status", "--porcelain"])).reviewableStatus;
        if (!uncommitted) uncommittedDiff = "";
      } catch {}
      try {
        manifest = readManifest(manifestPath).data;
        manifest = {
          ...manifest,
          git: {
            ...(manifest.git || {}),
            ...(prNumber !== null ? { pr_number: prNumber } : {}),
            head_sha: currentHead || startHead || null,
          },
        };
        writeManifest(manifestPath, manifest);
      } catch {}
    } catch (recoverError) {
      const stderr = recoverError.stderr ? String(recoverError.stderr).trim() : "";
      const message = stderr || String(recoverError.message || recoverError).split("\n")[0];
      status = "failed";
      exitCode = exitCode || 1;
      error = `auto_recover_commit_failed: ${message}`;
      commitMode = "auto-recover failed";
      try {
        manifest = readManifest(manifestPath).data;
        if (manifest.state !== STATES.ESCALATED) {
          manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_dispatch_failure");
          manifest = {
            ...manifest,
            git: {
              ...(manifest.git || {}),
              head_sha: currentHead || startHead || null,
            },
          };
          writeManifest(manifestPath, manifest);
        }
      } catch {}
    }
  }
  appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_RESULT,
    state_from: STATES.DISPATCHED,
    state_to: manifest.state,
    head_sha: currentHead || startHead || null,
    reason: status === "failed"
      ? `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${error || "dispatch_failed"}`
      : `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${status}`,
    publish_policy: PUBLISH_POLICY,
    executor_network: executorNetworkPolicy,
    executor_policy: executorPolicy,
    policy_decision: policyDecision,
    failure_class: networkFailure,
    execution_evidence_path: executionEvidencePath,
    execution_evidence_hash: executionEvidencePath ? hashFileSha256(executionEvidencePath) : null,
  });

  // --- Step 4.5: Optional app registration ---
  let threadId = null;
  if (REGISTER && status !== "failed") {
    try {
      const reg = adapter.register({
        wtPath,
        repoPath: repoRoot,
        branch,
        title: `Dispatch: ${branch}`,
      });
      threadId = reg.threadId;
      if (!JSON_OUT) console.log(`\n  Registered in ${EXECUTOR} app.`);
    } catch (e) {
      if (!JSON_OUT) console.log(`\n  Warning: app registration failed: ${e.message.split("\n")[0]}`);
    }
  }

  const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
  const result = {
    runId,
    runDir,
    manifestPath,
    rubricPath: rubricAnchor.resolvedPath || null,
    requestId: manifest.source?.request_id || null,
    leafId: manifest.source?.leaf_id || null,
    doneCriteriaPath: manifest.anchor?.done_criteria_path || null,
    runState: manifest.state,
    cleanupPolicy,
    status,
    commitMode,
    executor: EXECUTOR,
    executorNetwork: executorNetworkPolicy,
    executorPolicy,
    publishPolicy: PUBLISH_POLICY,
    policyDecision,
    routePlanPath: routePlanSnapshot?.path || null,
    routePlan: routePlanSnapshot?.snapshot || null,
    routingDecision,
    codexGitCommonDir,
    worktree: wtPath,
    branch,
    mode: RESUME_MODE ? "resume" : "new",
    headSha: currentHead || startHead || null,
    prNumber,
    prCreatedByUs,
    executionEvidencePath,
    resultFile,
    stdoutLog,
    stderrLog,
    elapsed: `${elapsed}s`,
    exitCode,
    error,
    registered: !!threadId,
    threadId,
    commits: gitLog,
    uncommitted: uncommitted || null,
    uncommittedDiff: uncommittedDiff || null,
    diffStat,
    resultPreview: resultText.slice(0, 500),
  };
  if (manifest.fleet_id) {
    result.fleetId = manifest.fleet_id;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n--- Dispatch ${result.status} (${elapsed}s) ---`);
    if (error) console.log(`  Error: ${error}`);
    console.log(`  Run state: ${result.runState}`);
    console.log(`  Commit mode: ${result.commitMode}`);
    if (prNumber !== null) {
      console.log(`  PR:        #${prNumber}${prCreatedByUs === true ? " (created by orchestrator)" : prCreatedByUs === false ? " (existing)" : ""}`);
    }
    if (gitLog) {
      console.log(`  Commits:`);
      gitLog.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (diffStat) {
      console.log(`  Changes:`);
      diffStat.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (resultText) {
      console.log(`  Result preview:`);
      console.log(`    ${resultText.slice(0, 300).replace(/\n/g, "\n    ")}`);
    }
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`\n  Full result: cat ${resultFile}`);
    console.log(`  Stdout log:  cat ${stdoutLog}`);
    console.log(`  Stderr log:  cat ${stderrLog}`);
    if (uncommittedDiff) {
      console.log(`  Uncommitted changes:`);
      uncommittedDiff.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    console.log(`\n  Review:      git -C ${shellQuote(wtPath)} log --oneline ${startHead ? startHead + "..HEAD" : ""}`);
    console.log(`  Diff:        git -C ${shellQuote(wtPath)} diff ${startHead ? startHead + "..HEAD" : "HEAD~1"}`);
    console.log(`  Merge:       git merge ${branch}`);
    console.log(`  Cleanup:     deferred (${cleanupPolicy})`);
  }

  if (status === "failed") process.exit(exitCode || 1);
}

if (DETACH) {
  launchDetachedAndExit().catch((e) => {
    if (JSON_OUT) {
      console.log(JSON.stringify({
        status: "failed",
        error: e.message,
      }, null, 2));
    }
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
