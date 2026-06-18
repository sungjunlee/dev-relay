#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const OUTCOMES = Object.freeze({
  PASS: "pass",
  FAIL_SAFE_PASS: "fail-safe-pass",
  TIMEOUT: "timeout",
  FAIL: "fail",
  NOT_RUN: "not-run",
});

const DEFAULTS = Object.freeze({
  piModel: process.env.RELAY_LIVE_DOGFOOD_PI_MODEL || null,
  opencodeModel: process.env.RELAY_LIVE_DOGFOOD_OPENCODE_MODEL || null,
  antigravityModel: process.env.RELAY_LIVE_DOGFOOD_ANTIGRAVITY_MODEL || "google/antigravity-cli",
  commandTimeoutMs: 300_000,
  piReviewTimeout: "120s",
  opencodeReviewTimeout: "120s",
  antigravityReviewTimeout: "120s",
  antigravityFailSafeReviewTimeout: "5s",
  antigravityDispatchTimeoutSeconds: 45,
  dispatchBaseRef: "origin/main",
  dispatchCanary: false,
  dispatchTimeoutSeconds: 180,
  dispatchBranchPrefix: "dogfood-dispatch",
});

const MODEL_OPTION_BY_ADAPTER = Object.freeze({
  pi: "piModel",
  opencode: "opencodeModel",
  antigravity: "antigravityModel",
});

const REVIEWER_SCRIPT_BY_ADAPTER = Object.freeze({
  pi: "invoke-reviewer-pi.js",
  opencode: "invoke-reviewer-opencode.js",
  antigravity: "invoke-reviewer-antigravity.js",
});

const DEFAULT_REVIEW_PHASE_BY_ADAPTER = Object.freeze({
  pi: "primary_review",
  opencode: "advisory_review",
  antigravity: "primary_review",
});

const LIVE_DOGFOOD_SCENARIOS = Object.freeze([
  {
    name: "probe-pi",
    adapter: "pi",
    phase: "probe",
    category: "probe",
    classifier: "probe-json",
    defaultEnabled: true,
    healthyPromotion: false,
  },
  {
    name: "probe-opencode",
    adapter: "opencode",
    phase: "probe",
    category: "probe",
    classifier: "probe-json",
    defaultEnabled: true,
    healthyPromotion: false,
  },
  {
    name: "probe-antigravity",
    adapter: "antigravity",
    phase: "probe",
    category: "probe",
    classifier: "probe-json",
    defaultEnabled: true,
    healthyPromotion: false,
  },
  {
    name: "opencode-advisory",
    adapter: "opencode",
    phase: "advisory_review",
    category: "healthy-review",
    classifier: "standard-json",
    defaultEnabled: true,
    healthyPromotion: true,
    env: { name: "RELAY_OPENCODE_REVIEW_TIMEOUT", option: "opencodeReviewTimeout" },
  },
  {
    name: "opencode-primary",
    adapter: "opencode",
    phase: "primary_review",
    category: "healthy-review",
    classifier: "standard-json",
    defaultEnabled: false,
    healthyPromotion: true,
    env: { name: "RELAY_OPENCODE_REVIEW_TIMEOUT", option: "opencodeReviewTimeout" },
  },
  {
    name: "pi-advisory",
    adapter: "pi",
    phase: "advisory_review",
    category: "healthy-review",
    classifier: "standard-json",
    defaultEnabled: true,
    healthyPromotion: true,
    env: { name: "RELAY_PI_REVIEW_TIMEOUT", option: "piReviewTimeout" },
  },
  {
    name: "pi-primary",
    adapter: "pi",
    phase: "primary_review",
    category: "healthy-review",
    classifier: "standard-json",
    defaultEnabled: true,
    healthyPromotion: true,
    env: { name: "RELAY_PI_REVIEW_TIMEOUT", option: "piReviewTimeout" },
  },
  {
    name: "antigravity-primary",
    adapter: "antigravity",
    phase: "primary_review",
    category: "healthy-review",
    classifier: "antigravity-primary",
    defaultEnabled: true,
    healthyPromotion: true,
    env: { name: "RELAY_ANTIGRAVITY_REVIEW_TIMEOUT", option: "antigravityReviewTimeout" },
  },
  {
    name: "antigravity-advisory",
    adapter: "antigravity",
    phase: "advisory_review",
    category: "healthy-review",
    classifier: "standard-json",
    defaultEnabled: true,
    healthyPromotion: true,
    env: { name: "RELAY_ANTIGRAVITY_REVIEW_TIMEOUT", option: "antigravityReviewTimeout" },
  },
  {
    name: "antigravity-primary-fail-safe-timeout",
    adapter: "antigravity",
    phase: "primary_review",
    category: "fail-safe",
    classifier: "antigravity-fail-safe-timeout",
    defaultEnabled: true,
    healthyPromotion: false,
    env: { name: "RELAY_ANTIGRAVITY_REVIEW_TIMEOUT", option: "antigravityFailSafeReviewTimeout" },
  },
  {
    name: "antigravity-dispatch-fail-safe-noop",
    adapter: "antigravity",
    phase: "dispatch",
    category: "fail-safe",
    classifier: "antigravity-noop-dispatch",
    defaultEnabled: true,
    healthyPromotion: false,
  },
  {
    name: "pi-dispatch-canary",
    adapter: "pi",
    phase: "dispatch",
    category: "healthy-dispatch",
    classifier: "healthy-dispatch",
    defaultEnabled: false,
    requiresDispatchCanary: true,
    healthyPromotion: true,
  },
  {
    name: "opencode-dispatch-canary",
    adapter: "opencode",
    phase: "dispatch",
    category: "healthy-dispatch",
    classifier: "healthy-dispatch",
    defaultEnabled: false,
    requiresDispatchCanary: true,
    healthyPromotion: true,
  },
  {
    name: "antigravity-dispatch-canary",
    adapter: "antigravity",
    phase: "dispatch",
    category: "healthy-dispatch",
    classifier: "healthy-dispatch",
    defaultEnabled: false,
    requiresDispatchCanary: true,
    healthyPromotion: true,
  },
]);

const LIVE_DOGFOOD_READINESS_EXEMPTIONS = Object.freeze([]);

function parseArgs(argv) {
  const parsed = {
    repo: ".",
    relayHome: null,
    keepRelayHome: false,
    probeOnly: false,
    dryRun: false,
    json: false,
    markdown: false,
    scenarios: [],
    piModel: DEFAULTS.piModel,
    opencodeModel: DEFAULTS.opencodeModel,
    antigravityModel: DEFAULTS.antigravityModel,
    commandTimeoutMs: DEFAULTS.commandTimeoutMs,
    piReviewTimeout: DEFAULTS.piReviewTimeout,
    opencodeReviewTimeout: DEFAULTS.opencodeReviewTimeout,
    antigravityReviewTimeout: DEFAULTS.antigravityReviewTimeout,
    antigravityFailSafeReviewTimeout: DEFAULTS.antigravityFailSafeReviewTimeout,
    antigravityDispatchTimeoutSeconds: DEFAULTS.antigravityDispatchTimeoutSeconds,
    dispatchBaseRef: DEFAULTS.dispatchBaseRef,
    dispatchCanary: DEFAULTS.dispatchCanary,
    dispatchTimeoutSeconds: DEFAULTS.dispatchTimeoutSeconds,
    dispatchBranchPrefix: DEFAULTS.dispatchBranchPrefix,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--repo") parsed.repo = next();
    else if (arg === "--relay-home") parsed.relayHome = next();
    else if (arg === "--keep-relay-home") parsed.keepRelayHome = true;
    else if (arg === "--probe-only") parsed.probeOnly = true;
    else if (arg === "--scenario") parsed.scenarios.push(next());
    else if (arg === "--dispatch-canary") parsed.dispatchCanary = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--markdown") parsed.markdown = true;
    else if (arg === "--pi-model") parsed.piModel = next();
    else if (arg === "--opencode-model") parsed.opencodeModel = next();
    else if (arg === "--antigravity-model") parsed.antigravityModel = next();
    else if (arg === "--command-timeout-ms") parsed.commandTimeoutMs = Number(next());
    else if (arg === "--pi-review-timeout") parsed.piReviewTimeout = next();
    else if (arg === "--opencode-review-timeout") parsed.opencodeReviewTimeout = next();
    else if (arg === "--antigravity-review-timeout") parsed.antigravityReviewTimeout = next();
    else if (arg === "--antigravity-fail-safe-timeout") parsed.antigravityFailSafeReviewTimeout = next();
    else if (arg === "--antigravity-dispatch-timeout") parsed.antigravityDispatchTimeoutSeconds = Number(next());
    else if (arg === "--dispatch-base-ref") parsed.dispatchBaseRef = next();
    else if (arg === "--dispatch-timeout") parsed.dispatchTimeoutSeconds = Number(next());
    else if (arg === "--dispatch-branch-prefix") parsed.dispatchBranchPrefix = next();
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isSafeInteger(parsed.commandTimeoutMs) || parsed.commandTimeoutMs <= 0) {
    throw new Error("--command-timeout-ms must be a positive integer");
  }
  if (!Number.isSafeInteger(parsed.antigravityDispatchTimeoutSeconds) || parsed.antigravityDispatchTimeoutSeconds <= 0) {
    throw new Error("--antigravity-dispatch-timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(parsed.dispatchTimeoutSeconds) || parsed.dispatchTimeoutSeconds <= 0) {
    throw new Error("--dispatch-timeout must be a positive integer");
  }
  if (!String(parsed.dispatchBranchPrefix || "").trim()) {
    throw new Error("--dispatch-branch-prefix must be a non-empty string");
  }
  if (parsed.scenarios.length) {
    const knownScenarios = new Set(LIVE_DOGFOOD_SCENARIOS.map((scenario) => scenario.name));
    for (const scenario of parsed.scenarios) {
      if (!knownScenarios.has(scenario)) {
        throw new Error(`unknown --scenario ${JSON.stringify(scenario)}; expected one of: ${[...knownScenarios].join(", ")}`);
      }
    }
  }
  return parsed;
}

function buildAllowedModelRoutes(options = {}) {
  const piModel = options.piModel || DEFAULTS.piModel;
  const opencodeModel = options.opencodeModel || DEFAULTS.opencodeModel;
  const antigravityModel = options.antigravityModel || DEFAULTS.antigravityModel;

  return [
    piModel ? {
      route: piModel,
      phases: ["dispatch", "review"],
      executors: ["pi"],
      reviewers: ["pi"],
    } : null,
    opencodeModel ? {
      route: opencodeModel,
      phases: ["dispatch", "advisory_review"],
      executors: ["opencode"],
      reviewers: ["opencode"],
    } : null,
    antigravityModel ? {
      route: antigravityModel,
      phases: ["dispatch", "review", "advisory_review"],
      executors: ["antigravity"],
      reviewers: ["antigravity"],
    } : null,
  ].filter(Boolean);
}

function buildPolicy(options = {}) {
  return {
    version: 1,
    profile: "live-adapter-dogfood",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: buildAllowedModelRoutes(options),
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  };
}

function ensureRelayHome(relayHome, options = {}) {
  const resolved = relayHome
    ? path.resolve(relayHome)
    : fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-dogfood-"));
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "policy.json"), `${JSON.stringify(buildPolicy(options), null, 2)}\n`, "utf-8");
  return resolved;
}

function writePromptFiles(relayHome, options = {}) {
  const promptDir = path.join(relayHome, "dogfood-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const advisoryPrompt = path.join(promptDir, "advisory-prompt.md");
  const primaryPrompt = path.join(promptDir, "primary-prompt.md");
  const rubric = path.join(promptDir, "antigravity-dispatch-noop-rubric.yaml");
  fs.writeFileSync(advisoryPrompt, [
    "Return exactly one advisory JSON object for a relay live dogfood canary.",
    "The object must contain profile, summary, required_findings, advisory_findings, and duplicate_or_low_confidence.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(primaryPrompt, [
    "Return exactly one relay primary review verdict JSON object.",
    "Use verdict=pass, contract_status=pass, quality_review_status=pass, next_action=ready_to_merge, no issues, and empty scope drift.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(rubric, [
    "factors:",
    "  - name: live_dogfood_noop",
    "    target: 3",
    "    criteria:",
    "      3: Live dogfood no-op canary returns a safe no-op or failed/escalated classification without a PR.",
    "      0: Live dogfood no-op canary incorrectly creates reviewable output or a PR.",
    "",
  ].join("\n"), "utf-8");

  const dispatchStamp = String(options.dispatchStamp || Date.now());
  const dispatchCanaries = {};
  for (const executor of ["pi", "opencode", "antigravity"]) {
    const canaryFile = `relay-live-dogfood-${executor}-${dispatchStamp}.txt`;
    const canaryLine = `relay live dogfood dispatch canary ${executor} ${dispatchStamp}`;
    const promptFile = path.join(promptDir, `${executor}-dispatch-canary-prompt.md`);
    const rubricFile = path.join(promptDir, `${executor}-dispatch-canary-rubric.yaml`);
    const routeIntentFile = path.join(promptDir, `${executor}-dispatch-canary-route-intent.json`);
    fs.writeFileSync(promptFile, [
      `Create or update ${canaryFile} with exactly one line:`,
      canaryLine,
      "Commit that file and do not change anything else.",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(rubricFile, [
      "criteria:",
      "  - id: minimal-intentional-change",
      `    description: Creates or updates only ${canaryFile} with the requested single line.`,
      "    weight: 1",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(routeIntentFile, `${JSON.stringify({
      dispatch: { executor, model: modelForAdapter(options, executor) },
      review: { reviewer: "codex" },
    }, null, 2)}\n`, "utf-8");
    dispatchCanaries[executor] = { promptFile, rubricFile, routeIntentFile, canaryFile, canaryLine };
  }

  return { advisoryPrompt, primaryPrompt, rubric, dispatchCanaries, dispatchStamp };
}

function plannedStep(name, command, notes = "") {
  return { name, outcome: OUTCOMES.NOT_RUN, command, notes };
}

function spawnCommand({ spawnImpl, cwd, env, command, args, timeoutMs }) {
  return spawnImpl(command, args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function assertCleanDispatchCanaryRepo(repo, spawnImpl = spawnSync) {
  const result = spawnImpl("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`--dispatch-canary requires git status to succeed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = summarizeOutput(result) || `git status exited ${result.status}`;
    throw new Error(`--dispatch-canary requires git status to succeed: ${details}`);
  }
  const dirty = String(result.stdout || "").trim();
  if (dirty) {
    throw new Error(
      "--dispatch-canary requires a clean worktree because live dispatch canaries create branches, commits, and PRs. " +
      `Current dirty status:\n${dirty}`
    );
  }
}

function prepareDispatchBaseRepo({ repo, relayHome, options, spawnImpl }) {
  const baseRef = String(options.dispatchBaseRef || DEFAULTS.dispatchBaseRef).trim();
  if (!baseRef) throw new Error("--dispatch-base-ref must not be empty");
  const baseDir = path.join(relayHome, `dispatch-base-${process.pid}-${Date.now()}`);
  const baseRepo = path.join(baseDir, "repo");
  fs.mkdirSync(baseDir, { recursive: true });
  const result = spawnImpl("git", ["worktree", "add", "--detach", baseRepo, baseRef], {
    cwd: repo,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(`--dispatch-canary failed to create clean base worktree from ${baseRef}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = summarizeOutput(result) || `git worktree add exited ${result.status}`;
    throw new Error(`--dispatch-canary failed to create clean base worktree from ${baseRef}: ${details}`);
  }
  const cleanup = () => {
    spawnImpl("git", ["worktree", "remove", "--force", baseRepo], {
      cwd: repo,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });
  };
  try {
    assertCleanDispatchCanaryRepo(baseRepo, spawnImpl);
  } catch (error) {
    cleanup();
    throw error;
  }
  return { repo: baseRepo, baseRef, cleanup };
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

function summarizeOutput(result) {
  const stderr = String(result.stderr || "").trim();
  const stdout = String(result.stdout || "").trim();
  const error = result.error?.message ? String(result.error.message).trim() : "";
  return (stderr || stdout || error).split(/\r?\n/).slice(0, 8).join("\n");
}

function classifyStandardJson(result) {
  if (result.error?.code === "ETIMEDOUT") return { outcome: OUTCOMES.TIMEOUT, notes: "harness command timeout" };
  const parsed = parseJson(result.stdout);
  if (result.status === 0 && parsed) return { outcome: OUTCOMES.PASS, parsed, notes: "valid JSON returned" };
  const text = summarizeOutput(result);
  if (/mutated the worktree/i.test(text)) return { outcome: OUTCOMES.FAIL, notes: text };
  if (/timed out/i.test(text)) return { outcome: OUTCOMES.TIMEOUT, notes: text };
  return { outcome: OUTCOMES.FAIL, notes: text || "command failed without parseable JSON" };
}

function classifyProbeJson(result) {
  const standard = classifyStandardJson(result);
  if (standard.outcome !== OUTCOMES.PASS) return standard;
  const parsed = standard.parsed;
  if (parsed.agent_probe_error) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: `agent_probe_error: ${parsed.agent_probe_error}` };
  }
  if (parsed.policy_decision?.allowed !== true) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: `policy denied route: ${parsed.policy_decision?.reason || "unknown"}` };
  }
  if (!String(parsed.agent_tools_raw || "").trim()) {
    return { outcome: OUTCOMES.FAIL, parsed, notes: "probe returned no agent_tools_raw evidence" };
  }
  return standard;
}

function classifyAntigravityPrimary(result) {
  return classifyStandardJson(result);
}

function classifyAntigravityFailSafeTimeout(result) {
  const standard = classifyStandardJson(result);
  if (standard.outcome === OUTCOMES.TIMEOUT && /Antigravity reviewer primary_review timed out/i.test(standard.notes)) {
    return { ...standard, outcome: OUTCOMES.FAIL_SAFE_PASS };
  }
  if (standard.outcome === OUTCOMES.PASS) {
    return {
      ...standard,
      outcome: OUTCOMES.FAIL,
      notes: "fail-safe timeout canary returned structured JSON instead of exercising the timeout path",
    };
  }
  return standard;
}

function hasPrNumber(parsed) {
  return parsed?.prNumber !== null && typeof parsed?.prNumber !== "undefined";
}

function classifyHealthyDispatch(result) {
  if (result.error?.code === "ETIMEDOUT") return { outcome: OUTCOMES.TIMEOUT, notes: "harness command timeout" };
  const parsed = parseJson(result.stdout);
  if (!parsed) return { outcome: OUTCOMES.FAIL, notes: summarizeOutput(result) || "dispatch did not return JSON" };
  if (result.status === 0 && parsed.runState === "review_pending" && hasPrNumber(parsed)) {
    return { outcome: OUTCOMES.PASS, parsed, notes: "dispatch produced reviewable PR" };
  }
  const notes = parsed.error || summarizeOutput(result) || `unexpected dispatch state ${parsed.runState || "(unknown)"}`;
  if (/timed out|timeout/i.test(notes)) return { outcome: OUTCOMES.TIMEOUT, parsed, notes };
  return { outcome: OUTCOMES.FAIL, parsed, notes };
}

function classifyAntigravityNoOpDispatch(result) {
  if (result.error?.code === "ETIMEDOUT") return { outcome: OUTCOMES.TIMEOUT, notes: "harness command timeout" };
  const parsed = parseJson(result.stdout);
  if (!parsed) return { outcome: OUTCOMES.FAIL, notes: summarizeOutput(result) || "dispatch did not return JSON" };
  if (hasPrNumber(parsed)) {
    return {
      outcome: OUTCOMES.FAIL,
      parsed,
      notes: "no-op fail-safe canary produced a PR; treating as false success",
    };
  }
  if (parsed.status === "completed-no-op") {
    return { outcome: OUTCOMES.FAIL_SAFE_PASS, parsed, notes: "no-op canary produced no PR" };
  }
  if (parsed.runState === "escalated" && parsed.status === "failed" && parsed.prNumber === null) {
    const notes = parsed.error || "dispatch failed safely without PR";
    if (/timed out|timeout|no reviewable repository changes|runtime metadata|silent failure|blocked on approval/i.test(notes)) {
      return { outcome: OUTCOMES.FAIL_SAFE_PASS, parsed, notes };
    }
  }
  return { outcome: OUTCOMES.FAIL, parsed, notes: parsed.error || `unexpected no-op dispatch state ${parsed.runState || "(unknown)"}` };
}

function classifyAntigravityDispatch(result) {
  return classifyHealthyDispatch(result);
}

function buildDispatchCommand({ node, repo, branch, executor, model, routeIntentFile, promptFile, rubricFile, timeoutSeconds }) {
  const command = [
    node,
    path.join(SCRIPT_REPO_ROOT, "skills/relay-dispatch/scripts/dispatch.js"),
    repo,
    "-b", branch,
    "--prompt-file", promptFile,
    "--rubric-file", rubricFile,
    "--timeout", String(timeoutSeconds),
    "--json",
  ];
  if (routeIntentFile) {
    command.splice(command.length - 1, 0, "--route-intent-file", routeIntentFile);
  } else {
    command.splice(command.length - 1, 0, "--executor", executor, "--model", model);
  }
  return command;
}

const CLASSIFIER_BY_ID = Object.freeze({
  "probe-json": classifyProbeJson,
  "standard-json": classifyStandardJson,
  "antigravity-primary": classifyAntigravityPrimary,
  "antigravity-fail-safe-timeout": classifyAntigravityFailSafeTimeout,
  "antigravity-noop-dispatch": classifyAntigravityNoOpDispatch,
  "healthy-dispatch": classifyHealthyDispatch,
});

function modelForAdapter(options, adapter) {
  const optionName = MODEL_OPTION_BY_ADAPTER[adapter];
  if (!optionName) throw new Error(`unknown dogfood adapter: ${adapter}`);
  const model = options[optionName];
  if (!String(model || "").trim()) {
    const flag = optionName
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      .replace(/-model$/, "-model");
    const envName = {
      piModel: "RELAY_LIVE_DOGFOOD_PI_MODEL",
      opencodeModel: "RELAY_LIVE_DOGFOOD_OPENCODE_MODEL",
      antigravityModel: "RELAY_LIVE_DOGFOOD_ANTIGRAVITY_MODEL",
    }[optionName];
    throw new Error(`${adapter} live dogfood requires --${flag} or ${envName}`);
  }
  return model;
}

function isScenarioEnabled(scenario, options) {
  if (options.scenarios?.length) return options.scenarios.includes(scenario.name);
  if (options.probeOnly) return scenario.category === "probe";
  if (scenario.requiresDispatchCanary) return options.dispatchCanary === true;
  return scenario.defaultEnabled === true;
}

function includesDispatchCanaryScenario(options = {}) {
  if (options.dispatchCanary) return true;
  if (!options.scenarios?.length) return false;
  const selected = new Set(options.scenarios);
  return LIVE_DOGFOOD_SCENARIOS.some((scenario) => (
    scenario.requiresDispatchCanary === true && selected.has(scenario.name)
  ));
}

function buildScenarioEnv(scenario, options) {
  if (!scenario.env) return {};
  return { [scenario.env.name]: options[scenario.env.option] };
}

function buildProbeScenarioCommand({ node, repo, options, scenario }) {
  return [
    node,
    path.join(SCRIPT_REPO_ROOT, "skills/relay-plan/scripts/probe-executor-env.js"),
    repo,
    "--executor", scenario.adapter,
    "--model", modelForAdapter(options, scenario.adapter),
    "--json",
  ];
}

function buildReviewScenarioCommand({ node, repo, prompts, options, scenario }) {
  const script = REVIEWER_SCRIPT_BY_ADAPTER[scenario.adapter];
  if (!script) throw new Error(`unknown reviewer dogfood adapter: ${scenario.adapter}`);

  const promptFile = scenario.phase === "advisory_review"
    ? prompts.advisoryPrompt
    : prompts.primaryPrompt;
  const command = [
    node,
    path.join(SCRIPT_REPO_ROOT, "skills/relay-review/scripts", script),
    "--repo", repo,
    "--prompt-file", promptFile,
    "--model", modelForAdapter(options, scenario.adapter),
    "--json",
  ];
  if (scenario.phase !== DEFAULT_REVIEW_PHASE_BY_ADAPTER[scenario.adapter]) {
    command.splice(command.length - 1, 0, "--phase", scenario.phase);
  }
  return command;
}

function buildFailSafeDispatchCommand({ node, repo, prompts, options, branch }) {
  return [
    node,
    path.join(SCRIPT_REPO_ROOT, "skills/relay-dispatch/scripts/dispatch.js"),
    repo,
    "-b", branch,
    "--prompt", "Live dogfood fail-safe no-op canary: do not modify repository files, do not commit, and do not create a PR-ready change.",
    "--executor", "antigravity",
    "--model", options.antigravityModel,
    "--rubric-file", prompts.rubric,
    "--timeout", String(options.antigravityDispatchTimeoutSeconds),
    "--json",
  ];
}

function buildHealthyDispatchScenarioCommand({ node, repo, prompts, options, scenario }) {
  const canary = prompts.dispatchCanaries[scenario.adapter];
  return buildDispatchCommand({
    node,
    repo,
    branch: `${options.dispatchBranchPrefix}-${scenario.adapter}-${prompts.dispatchStamp}`,
    executor: scenario.adapter,
    model: modelForAdapter(options, scenario.adapter),
    routeIntentFile: canary.routeIntentFile,
    promptFile: canary.promptFile,
    rubricFile: canary.rubricFile,
    timeoutSeconds: options.dispatchTimeoutSeconds,
  });
}

function buildScenarioCommand(context, scenario) {
  if (scenario.category === "probe") {
    return buildProbeScenarioCommand({ ...context, scenario });
  }
  if (scenario.category === "healthy-review" || (scenario.category === "fail-safe" && scenario.phase !== "dispatch")) {
    return buildReviewScenarioCommand({ ...context, scenario });
  }
  if (scenario.name === "antigravity-dispatch-fail-safe-noop") {
    return buildFailSafeDispatchCommand({
      ...context,
      branch: context.failSafeDispatchBranch,
    });
  }
  if (scenario.category === "healthy-dispatch") {
    return buildHealthyDispatchScenarioCommand({ ...context, scenario });
  }
  throw new Error(`unknown dogfood scenario category: ${scenario.category}`);
}

function buildSteps({ repo, relayHome, prompts, options }) {
  const node = process.execPath;
  const context = {
    node,
    repo,
    relayHome,
    prompts,
    options,
    failSafeDispatchBranch: `dogfood-antigravity-${Date.now()}`,
  };

  return LIVE_DOGFOOD_SCENARIOS
    .filter((scenario) => isScenarioEnabled(scenario, options))
    .map((scenario) => {
      const classify = CLASSIFIER_BY_ID[scenario.classifier];
      if (!classify) throw new Error(`unknown dogfood classifier: ${scenario.classifier}`);
      return {
        ...scenario,
        command: buildScenarioCommand(context, scenario),
        env: buildScenarioEnv(scenario, options),
        classify,
        relayHome,
      };
    });
}

function scenarioMetadata(scenario) {
  return {
    name: scenario.name,
    adapter: scenario.adapter,
    phase: scenario.phase,
    category: scenario.category,
    defaultEnabled: scenario.defaultEnabled === true,
    requiresDispatchCanary: scenario.requiresDispatchCanary === true,
    healthyPromotion: scenario.healthyPromotion === true,
  };
}

function readinessExemptionMetadata(exemption) {
  return {
    adapter: exemption.adapter,
    phase: exemption.phase,
    reason: exemption.reason,
  };
}

function buildCoverageMetadata() {
  return {
    scenarios: LIVE_DOGFOOD_SCENARIOS.map(scenarioMetadata),
    readiness_exemptions: LIVE_DOGFOOD_READINESS_EXEMPTIONS.map(readinessExemptionMetadata),
  };
}

function runDogfood(options = {}, deps = {}) {
  const spawnImpl = deps.spawnSync || spawnSync;
  const repo = path.resolve(options.repo || ".");
  const effectiveOptions = { ...DEFAULTS, ...options };
  const relayHome = ensureRelayHome(options.relayHome, effectiveOptions);
  let dispatchBase = null;
  if (includesDispatchCanaryScenario(effectiveOptions) && !effectiveOptions.dryRun) {
    dispatchBase = prepareDispatchBaseRepo({ repo, relayHome, options: effectiveOptions, spawnImpl });
  }
  const executionRepo = dispatchBase?.repo || repo;
  const prompts = writePromptFiles(relayHome, effectiveOptions);
  const envBase = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_POLICY_PATH: path.join(relayHome, "policy.json"),
  };
  const steps = buildSteps({ repo: executionRepo, relayHome, prompts, options: effectiveOptions });

  let results;
  try {
    results = steps.map((step) => {
      const commandText = step.command.map((part) => String(part)).join(" ");
      if (options.dryRun) return plannedStep(step.name, commandText, "dry-run");
      const [command, ...args] = step.command;
      const raw = spawnCommand({
        spawnImpl,
        cwd: executionRepo,
        env: { ...envBase, ...(step.env || {}) },
        command,
        args,
        timeoutMs: options.commandTimeoutMs || DEFAULTS.commandTimeoutMs,
      });
      const classified = step.classify(raw);
      return {
        name: step.name,
        outcome: classified.outcome,
        command: commandText,
        notes: classified.notes || "",
        parsed: classified.parsed || null,
      };
    });
  } finally {
    if (dispatchBase) dispatchBase.cleanup();
  }

  const result = {
    schema_version: 1,
    relay_home: relayHome,
    repo,
    ...(dispatchBase ? { dispatch_base_repo: dispatchBase.repo, dispatch_base_ref: dispatchBase.baseRef } : {}),
    temp_relay_home: !options.relayHome,
    outcomes: results,
  };
  if (effectiveOptions.dryRun) {
    result.coverage = buildCoverageMetadata();
  }
  return result;
}

function renderMarkdown(result) {
  const lines = [
    "## Live Adapter Dogfood",
    "",
    `- Repo: \`${result.repo}\``,
    `- RELAY_HOME: \`${result.relay_home}\`${result.temp_relay_home ? " (temporary)" : ""}`,
    "",
    "| Step | Outcome | Notes |",
    "| --- | --- | --- |",
  ];
  for (const step of result.outcomes) {
    lines.push(`| \`${step.name}\` | \`${step.outcome}\` | ${String(step.notes || "").replace(/\n/g, "<br>")} |`);
  }
  lines.push("");
  lines.push("Outcome meanings: `pass` proves that a healthy live canary path returned the expected structured output; `fail-safe-pass` means an intentionally bounded fail-safe canary avoided a reviewable false success and is not healthy success; `timeout` is inconclusive; `fail` is actionable failure; `not-run` is planning/dry-run only.");
  return `${lines.join("\n")}\n`;
}

function printHelp() {
  console.log("Usage: live-dogfood.js --repo <path> [--json|--markdown] [options]");
  console.log("");
  console.log("Runs bounded live multi-executor adapter canaries using a temporary RELAY_HOME by default.");
  console.log("");
  console.log("Options:");
  console.log("  --repo <path>                         Repository root (default: .)");
  console.log("  --relay-home <path>                   Use an explicit RELAY_HOME instead of a temp directory");
  console.log("  --probe-only                          Run only Pi/OpenCode/Antigravity probes");
  console.log("  --scenario <name>                     Run only a named scenario; repeat for multiple scenarios");
  console.log("  --dispatch-canary                     Add healthy Pi/OpenCode/Antigravity dispatch canaries that must produce review_pending PRs");
  console.log("  --dry-run                             Print planned steps without invoking live CLIs");
  console.log("  --json                                Emit structured JSON");
  console.log("  --markdown                            Emit GitHub-comment-ready Markdown");
  console.log("  --pi-model <route>                    Pi route (or RELAY_LIVE_DOGFOOD_PI_MODEL)");
  console.log("  --opencode-model <route>              OpenCode route (or RELAY_LIVE_DOGFOOD_OPENCODE_MODEL)");
  console.log("  --antigravity-model <route>           Antigravity route (default: RELAY_LIVE_DOGFOOD_ANTIGRAVITY_MODEL or google/antigravity-cli)");
  console.log("  --pi-review-timeout <duration>        RELAY_PI_REVIEW_TIMEOUT for the Pi canary (default: 120s)");
  console.log("  --opencode-review-timeout <duration>  RELAY_OPENCODE_REVIEW_TIMEOUT for OpenCode review canaries (default: 120s)");
  console.log("  --antigravity-review-timeout <duration>  RELAY_ANTIGRAVITY_REVIEW_TIMEOUT for the healthy Antigravity review canary (default: 120s)");
  console.log("  --antigravity-fail-safe-timeout <duration>  RELAY_ANTIGRAVITY_REVIEW_TIMEOUT for the intentional fail-safe timeout canary (default: 5s)");
  console.log("  --antigravity-dispatch-timeout <sec>  Antigravity no-op/fail-safe dispatch timeout seconds (default: 45)");
  console.log("  --dispatch-base-ref <ref>             Clean git ref used to anchor dispatch canaries (default: origin/main)");
  console.log("  --dispatch-timeout <sec>              Healthy dispatch canary timeout seconds (default: 180)");
  console.log("  --dispatch-branch-prefix <prefix>     Healthy dispatch canary branch prefix (default: dogfood-dispatch)");
  console.log("  --command-timeout-ms <ms>             Harness per-command timeout (default: 300000)");
  console.log("");
  console.log("Examples:");
  console.log("  live-dogfood.js --repo . --opencode-model opencode-go/glm-5.2 --scenario opencode-advisory --json");
  console.log("  live-dogfood.js --repo . --pi-model <pi-provider>/<pi-model> --scenario pi-primary --json");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = runDogfood(options);
  if (options.markdown && !options.json) {
    process.stdout.write(renderMarkdown(result));
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.markdown) process.stdout.write(`\n${renderMarkdown(result)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  OUTCOMES,
  buildPolicy,
  buildAllowedModelRoutes,
  classifyAntigravityDispatch,
  classifyAntigravityFailSafeTimeout,
  classifyAntigravityNoOpDispatch,
  classifyAntigravityPrimary,
  classifyHealthyDispatch,
  classifyProbeJson,
  classifyStandardJson,
  ensureRelayHome,
  LIVE_DOGFOOD_READINESS_EXEMPTIONS,
  LIVE_DOGFOOD_SCENARIOS,
  parseArgs,
  renderMarkdown,
  runDogfood,
};
