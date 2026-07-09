#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  evaluateRelayRoute,
  loadRelayPolicy,
  resolveRelayPolicyPath,
} = require("./relay-policy");
const { loadProjectConfig } = require("./project-config");
const { getProjectConfigPath, getProjectPolicyPath, getProjectRoutesPath, getRepoSlug } = require("./manifest/paths");
const {
  loadProjectRoutes,
  resolveGlobalRoutesPath,
  resolveRouteIntent,
  validateRouteConfig,
} = require("./relay-routing");
const { normalizeReviewAssurance } = require("./manifest/review-assurance");
const {
  findUnknownFlags,
  getPositionals,
  modeLabel,
  readArg,
  schemaHasFlag,
} = require("./cli-args");
const { listDeadDispatchedRunAdvisories } = require("./reconcile-advisory");
const {
  findOnPath,
  hasProviderModelRoute,
  probeModels,
  resolveModelRequest,
  resolutionMetadata,
} = require("./model-resolver");
const { catalogFreshnessReport } = require("./model-catalog");

const args = process.argv.slice(2);
const COMMAND_NAME = "relay-config";
const CLI_ARG_OPTIONS = { commandName: COMMAND_NAME };
const VALID_PHASES = ["dispatch", "review", "advisory_review"];
const EXECUTOR_PHASES = new Set(["dispatch"]);
const REVIEWER_PHASES = new Set(["review", "advisory_review"]);
const DEFAULT_PATHS = new Set([
  "dispatch.executor",
  "review.reviewer",
  "advisory_review.reviewer",
]);
const DOCTOR_TOOLS = ["codex", "claude", "opencode", "pi"];
const SUBCOMMAND_FLAGS = {
  init: new Set(["--profile", "--json", "--help"]),
  show: new Set(["--effective", "--json", "--help"]),
  doctor: new Set(["--json", "--reconcile", "--help"]),
  "catalog-report": new Set(["--json", "--help"]),
  "resolve-model": new Set(["--phase", "--executor", "--reviewer", "--model", "--fallback", "--json", "--help"]),
  check: new Set(["--phase", "--executor", "--reviewer", "--model", "--json", "--help"]),
  "plan-run": new Set(["--repo", "--dispatch", "--review", "--advisory-review", "--route-intent-file", "--json", "--help"]),
  "set-default": new Set(["--json", "--help"]),
  "add-route": new Set(["--phase", "--executor", "--reviewer", "--json", "--help"]),
  "allow-route": new Set(["--phase", "--executor", "--reviewer", "--json", "--help"]),
  "deny-route": new Set(["--phase", "--executor", "--reviewer", "--json", "--help"]),
  preset: new Set(["--dispatch", "--review", "--advisory-review", "--advisory-profile", "--review-assurance", "--json", "--help"]),
};
const RELAY_CONFIG_FLAG_ALIASES = new Map([
  ["-h", "--help"],
  ["-e", "--executor"],
  ["-m", "--model"],
]);

function hasCliFlag(flag) {
  return schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log("Usage: relay-config.js <command> [options]");
  console.log("");
  console.log("Configure relay provider/model routes. Executor/reviewer names are harnesses; provider/model route strings are the routing boundary.");
  console.log("");
  console.log("Commands:");
  console.log(`  init --profile <company|personal> ${modeLabel("--profile")} [--json ${modeLabel("--json")}]`);
  console.log(`  show --effective ${modeLabel("--effective")} [--json ${modeLabel("--json")}]`);
  console.log(`  doctor [--json ${modeLabel("--json")}] [--reconcile ${modeLabel("--reconcile")}]`);
  console.log(`  catalog-report [--json ${modeLabel("--json")}]`);
  console.log(`  resolve-model --phase <phase> ${modeLabel("--phase")} [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--model <name|provider/model> ${modeLabel("--model")}] [--fallback catalog ${modeLabel("--fallback")}] [--json ${modeLabel("--json")}]`);
  console.log(`  check --phase <phase> ${modeLabel("--phase")} [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--model <provider/model> ${modeLabel("--model")}] [--json ${modeLabel("--json")}]`);
  console.log(`  plan-run [--repo <path> ${modeLabel("--repo")}] [--dispatch <actor[:provider/model]> ${modeLabel("--dispatch")}] [--review <actor[:provider/model]> ${modeLabel("--review")}] [--advisory-review <actor[:provider/model]> ${modeLabel("--advisory-review")}] [--route-intent-file <path> ${modeLabel("--route-intent-file")}] [--json ${modeLabel("--json")}]`);
  console.log("  set-default <path> <value> [--json]");
  console.log(`  add-route <pattern> --phase <csv> ${modeLabel("--phase")} [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--json ${modeLabel("--json")}]`);
  console.log(`  allow-route <pattern> --phase <csv> ${modeLabel("--phase")} [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--json ${modeLabel("--json")}] (deprecated; use add-route)`);
  console.log(`  deny-route <pattern> [--phase <csv> ${modeLabel("--phase")}] [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--json ${modeLabel("--json")}]`);
  console.log(`  preset add|remove|show <name> [--dispatch <actor[:provider/model]> ${modeLabel("--dispatch")}] [--review <actor[:provider/model]> ${modeLabel("--review")}] [--advisory-review <actor[:provider/model]> ${modeLabel("--advisory-review")}] [--advisory-profile <name> ${modeLabel("--advisory-profile")}] [--review-assurance <standard|hardened> ${modeLabel("--review-assurance")}] [--json ${modeLabel("--json")}]`);
  console.log("");
  console.log("Supported default paths:");
  console.log("  dispatch.executor, review.reviewer, advisory_review.reviewer");
  console.log("");
  console.log(`Options: --help ${modeLabel("--help")}`);
}

function flagName(token) {
  const text = String(token);
  const separator = text.indexOf("=");
  const raw = separator === -1 ? text : text.slice(0, separator);
  return RELAY_CONFIG_FLAG_ALIASES.get(raw) || raw;
}

function unsupportedFlagsForCommand(command, argv) {
  const allowed = SUBCOMMAND_FLAGS[command];
  if (!allowed) return [];

  const unsupported = [];
  for (const token of argv) {
    if (!String(token).startsWith("-")) continue;
    const flag = flagName(token);
    if (!allowed.has(flag)) unsupported.push(flag);
  }
  return [...new Set(unsupported)];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function relayRoutesPath() {
  return resolveGlobalRoutesPath();
}

function readRoutesFile(routesPath) {
  try {
    return JSON.parse(fs.readFileSync(routesPath, "utf-8"));
  } catch (error) {
    throw new Error(`failed to read routes config at ${routesPath}: ${error.message}`);
  }
}

function legacyShadowWarnings({ routesExisted }) {
  if (routesExisted) return [];
  if (!fs.existsSync(resolveRelayPolicyPath())) return [];
  return [
    "routes.json now takes precedence; legacy policy.json/executors.json are ignored until migration arrives in Phase C",
  ];
}

function loadRoutesForMutation() {
  const routesPath = relayRoutesPath();
  const routesExisted = fs.existsSync(routesPath);
  if (!routesExisted) {
    return {
      routesPath,
      routesExisted,
      routes: { version: 2 },
      warnings: legacyShadowWarnings({ routesExisted }),
    };
  }
  const routes = readRoutesFile(routesPath);
  validateRouteConfig(routes, routesPath);
  return {
    routesPath,
    routesExisted,
    routes,
    warnings: legacyShadowWarnings({ routesExisted }),
  };
}

function writeRoutes(routesPath, routes) {
  validateRouteConfig(routes, routesPath);
  fs.mkdirSync(path.dirname(routesPath), { recursive: true });
  fs.writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`, "utf-8");
  return routes;
}

function loadGlobalPresetsForShow() {
  const routesPath = relayRoutesPath();
  if (!fs.existsSync(routesPath)) {
    return {};
  }
  const routes = readRoutesFile(routesPath);
  const validated = validateRouteConfig(routes, routesPath);
  return cloneJson(validated.presets || {});
}

function requireValue(value, label) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function parsePhases(rawValue, { required } = { required: false }) {
  const raw = nonEmptyString(rawValue);
  if (!raw) {
    if (required) {
      throw new Error(`--phase is required and must include one or more of: ${VALID_PHASES.join(", ")}`);
    }
    return undefined;
  }

  const phases = [];
  for (const token of raw.split(",")) {
    const phase = token.trim();
    if (!phase) continue;
    if (!VALID_PHASES.includes(phase)) {
      throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
    }
    if (!phases.includes(phase)) phases.push(phase);
  }

  if (!phases.length) {
    throw new Error(`--phase is required and must include one or more of: ${VALID_PHASES.join(", ")}`);
  }
  return phases;
}

function routeEntry(pattern, { phases, executor, reviewer }) {
  const route = requireValue(pattern, "route pattern");
  const entry = { route };
  if (phases !== undefined) entry.phases = phases;

  const executorName = nonEmptyString(executor);
  const reviewerName = nonEmptyString(reviewer);
  if (!executorName && !reviewerName) return entry;

  const hasExecutorPhase = !phases || phases.some((phase) => EXECUTOR_PHASES.has(phase));
  const hasReviewerPhase = !phases || phases.some((phase) => REVIEWER_PHASES.has(phase));

  if (executorName && reviewerName) {
    if (hasExecutorPhase) entry.executors = [executorName];
    if (hasReviewerPhase) entry.reviewers = [reviewerName];
    return entry;
  }

  if (executorName) {
    if (hasExecutorPhase) entry.executors = [executorName];
    if (hasReviewerPhase) entry.reviewers = [executorName];
    return entry;
  }

  if (reviewerName) {
    if (hasExecutorPhase) entry.executors = [reviewerName];
    if (hasReviewerPhase) entry.reviewers = [reviewerName];
  }
  return entry;
}

function outputMutation({ jsonOut, action, routesPath, routes, entry = null, defaultPath = null, profile = null, presetName = null, preset = null, warnings = [] }) {
  if (jsonOut) {
    printJson({
      ok: true,
      action,
      profile,
      path: routesPath,
      defaultPath,
      entry,
      presetName,
      preset,
      routes,
      warnings,
    });
    return;
  }
  for (const warning of warnings) console.log(`warning: ${warning}`);
  console.log(`relay-config: ${action} wrote ${routesPath}`);
}

function commandInit(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("init does not accept positional arguments");
  }
  const profile = requireValue(readArg(args, "--profile", undefined, CLI_ARG_OPTIONS), "--profile");
  // Overwrite semantics: init builds the profile shape from scratch so it can
  // also recover from an invalid existing routes.json. Only the legacy-shadow
  // warning depends on prior filesystem state.
  const routesPath = relayRoutesPath();
  const routesExisted = fs.existsSync(routesPath);
  const warnings = legacyShadowWarnings({ routesExisted });
  const written = writeRoutes(routesPath, {
    version: 2,
    strict: profile === "company",
    routes: [],
    denied_routes: [],
  });
  outputMutation({ jsonOut, action: "init", profile, routesPath, routes: written, warnings });
}

function commandShow(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("show does not accept positional arguments");
  }
  if (!hasCliFlag("--effective")) {
    throw new Error("show requires --effective");
  }

  const result = loadRelayPolicy({ repoRoot: process.cwd() });
  if (jsonOut) {
    printJson(result);
  } else if (result.ok) {
    console.log(`relay-config: effective routes status ${result.status}`);
    const globalSource = result.sources.routes?.global || result.sources.global;
    const repoSource = result.sources.routes?.project || result.sources.repo || result.sources.project;
    console.log(`global config: ${globalSource}`);
    if (repoSource) console.log(`repo config: ${repoSource}`);
    console.log(JSON.stringify(result.policy, null, 2));
  } else {
    console.log("relay-config: effective routes failed to load");
    for (const error of result.errors) {
      console.log(`${error.reason}: ${error.message}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

function defaultActors(policy) {
  return [
    policy.defaults.dispatch?.executor,
    policy.defaults.review?.reviewer,
    policy.defaults.advisory_review?.reviewer,
  ].filter(Boolean);
}

function routeActors(policy) {
  const actors = [];
  for (const listName of ["allowed_model_routes", "denied_model_routes"]) {
    for (const entry of policy[listName]) {
      actors.push(...(entry.executors || []), ...(entry.reviewers || []));
    }
  }
  return actors;
}

function actorHasConfiguredAllowedRoute(policy, actor) {
  return policy.allowed_model_routes.some((entry) => {
    const hasActorScope = entry.executors !== undefined || entry.reviewers !== undefined;
    if (!hasActorScope) return true;
    return Boolean(entry.executors?.includes(actor) || entry.reviewers?.includes(actor));
  });
}

function doctorTool(policy, name) {
  const executable = findOnPath(name);
  const dispatchDecision = evaluateRelayRoute(policy, { phase: "dispatch", executor: name });
  let policyStatus = dispatchDecision.allowed ? "allowed" : "policy-disallowed";
  let reason = dispatchDecision.reason;

  if (!dispatchDecision.allowed && actorHasConfiguredAllowedRoute(policy, name)) {
    policyStatus = "route-configured";
    reason = "provider_model_route_required";
  }

  return {
    name,
    installed: Boolean(executable),
    path: executable,
    policy: policyStatus,
    reason,
    model_probe: probeModels(name, executable),
    ...(name === "antigravity" ? { model_note: "Antigravity model values are policy labels only; relay does not pass them to agy." } : {}),
  };
}

function displayToolRouteStatus(tool) {
  if (tool.policy === "policy-disallowed") return "route-disallowed";
  return tool.policy;
}

function listDoctorRunAdvisories(repoRoot, options) {
  try {
    return listDeadDispatchedRunAdvisories(repoRoot, options);
  } catch (error) {
    if (error?.name === "CanonicalRepoRootResolutionError") return [];
    throw error;
  }
}

function commandDoctor(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("doctor does not accept positional arguments");
  }
  const result = loadRelayPolicy({ repoRoot: process.cwd() });
  if (!result.ok) {
    if (jsonOut) printJson({ ok: false, status: result.status, sources: result.sources, errors: result.errors });
    else {
      console.error("relay-config doctor: routes failed to load");
      for (const error of result.errors) console.error(`${error.reason}: ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const toolNames = [...new Set([
    ...DOCTOR_TOOLS,
    ...result.policy.managed_cli,
    ...defaultActors(result.policy),
    ...routeActors(result.policy),
  ])].sort();
  const tools = toolNames.map((name) => doctorTool(result.policy, name));
  const projectConfig = loadProjectConfig({ repoRoot: process.cwd() });
  const projectRoutes = loadProjectRoutes({ repoRoot: process.cwd() });
  const advisories = listDoctorRunAdvisories(process.cwd(), {
    mutate: hasCliFlag("--reconcile"),
  });
  const output = {
    ok: true,
    status: result.status,
    sources: result.sources,
    project_config: projectConfig,
    project_routes: projectRoutes,
    tools,
    advisories,
  };

  if (jsonOut) {
    printJson(output);
  } else {
    console.log(`relay-config doctor: routes ${result.status}`);
    for (const tool of tools) {
      const installed = tool.installed ? `installed at ${tool.path}` : "not installed on PATH";
      console.log(`${tool.name}: ${installed}; ${displayToolRouteStatus(tool)} (${tool.reason})`);
    }
    for (const advisory of advisories) {
      if (advisory.kind !== "dead_dispatched_run") continue;
      console.log(
        `advisory: run ${advisory.runId} is dispatched with ${advisory.leaseStatus} lease; ` +
        `reconcile row ${advisory.reconcile?.row || "unknown"} (${advisory.reconcile?.rowName || "unknown"})`
      );
    }
  }
}

function actorFieldForPhase(phase) {
  return REVIEWER_PHASES.has(phase) ? "reviewer" : "executor";
}

function actorForPhaseFromArgs(phase) {
  const executor = nonEmptyString(readArg(args, "--executor", undefined, CLI_ARG_OPTIONS));
  const reviewer = nonEmptyString(readArg(args, "--reviewer", undefined, CLI_ARG_OPTIONS));
  if (EXECUTOR_PHASES.has(phase)) return requireValue(executor, "--executor");
  if (REVIEWER_PHASES.has(phase)) return requireValue(reviewer, "--reviewer");
  throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
}

function routeCoverage(entry) {
  return Object.entries(entry.actor_routes || {})
    .map(([actor, route]) => `${actor}:${route}`)
    .join(", ") || "(none)";
}

function commandCatalogReport(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("catalog-report does not accept positional arguments");
  }
  const report = catalogFreshnessReport();
  const output = {
    ok: true,
    catalog: report,
  };

  if (jsonOut) {
    printJson(output);
    return;
  }

  console.log(
    `model catalog: ${report.summary.total} entries, ` +
    `${report.summary.stale} stale, stale_after_days=${report.stale_after_days}`
  );
  for (const entry of report.entries) {
    const status = entry.stale === true ? "stale" : entry.stale === false ? "fresh" : "unknown-age";
    console.log(
      `${entry.id}: ${status}; last_checked=${entry.last_checked}; ` +
      `age_days=${entry.age_days ?? "unknown"}; routes=${routeCoverage(entry)}`
    );
  }
}

function optionalActorForPhaseFromArgs(phase) {
  const executor = nonEmptyString(readArg(args, "--executor", undefined, CLI_ARG_OPTIONS));
  const reviewer = nonEmptyString(readArg(args, "--reviewer", undefined, CLI_ARG_OPTIONS));
  if (EXECUTOR_PHASES.has(phase)) return executor;
  if (REVIEWER_PHASES.has(phase)) return reviewer;
  throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
}

function normalizeFallback(value) {
  const fallback = nonEmptyString(value) || "none";
  if (!["none", "catalog"].includes(fallback)) {
    throw new Error("--fallback must be 'catalog' when provided");
  }
  return fallback;
}

function commandResolveModel(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("resolve-model does not accept positional arguments");
  }
  const phase = requireValue(readArg(args, "--phase", undefined, CLI_ARG_OPTIONS), "--phase");
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
  }
  const actor = optionalActorForPhaseFromArgs(phase);
  const model = nonEmptyString(readArg(args, "--model", undefined, CLI_ARG_OPTIONS));
  const fallback = normalizeFallback(readArg(args, "--fallback", undefined, CLI_ARG_OPTIONS));
  const policyResult = loadRelayPolicy({ repoRoot: process.cwd() });
  if (!policyResult.ok) {
    const output = {
      ok: false,
      error: "policy_error",
      policy: policyResult,
    };
    if (jsonOut) printJson(output);
    else console.error(`relay-config resolve-model: routes failed: ${policyResult.errors?.[0]?.message || "unknown route config error"}`);
    process.exitCode = 1;
    return;
  }

  const output = resolveModelRequest({
    phase,
    actor,
    actorField: actorFieldForPhase(phase),
    model,
    fallback,
    policy: policyResult.policy,
  });
  output.policy = {
    status: policyResult.status,
    sources: policyResult.sources,
  };

  if (jsonOut) {
    printJson(output);
  } else if (output.ok) {
    console.log(output.resolved_route || "(model-less)");
    for (const warning of output.warnings || []) console.log(`warning: ${humanWarning(warning)}`);
  } else {
    console.error(`${output.error}: ${output.requested_model || "(none)"}`);
    for (const candidate of output.candidates || []) console.error(`candidate: ${candidate}`);
    for (const warning of output.warnings || []) console.error(`warning: ${humanWarning(warning)}`);
  }
  if (!output.ok) process.exitCode = 1;
}

function commandCheck(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("check does not accept positional arguments");
  }

  const phase = requireValue(readArg(args, "--phase", undefined, CLI_ARG_OPTIONS), "--phase");
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
  }
  let executor = nonEmptyString(readArg(args, "--executor", undefined, CLI_ARG_OPTIONS));
  let reviewer = nonEmptyString(readArg(args, "--reviewer", undefined, CLI_ARG_OPTIONS));
  if (EXECUTOR_PHASES.has(phase)) executor = requireValue(executor, "--executor");
  if (REVIEWER_PHASES.has(phase)) reviewer = requireValue(reviewer, "--reviewer");
  const model = readArg(args, "--model", undefined, CLI_ARG_OPTIONS);
  const result = loadRelayPolicy({ repoRoot: process.cwd() });
  const decision = evaluateRelayRoute(result, { phase, executor, reviewer, model });
  const output = {
    ok: decision.allowed,
    status: result.status,
    sources: result.sources,
    decision,
  };

  if (jsonOut) {
    printJson(output);
  } else {
    const label = decision.allowed ? "allowed" : "denied";
    console.log(`${label}: ${decision.reason}`);
    if (decision.matchedRoute) console.log(`matched route: ${decision.matchedRoute}`);
  }

  if (!decision.allowed) process.exitCode = 1;
}

function parseRouteSpecWithResolution(spec, phase, { policy = null, fallback = "catalog" } = {}) {
  const raw = nonEmptyString(spec);
  if (!raw) return { spec: null, modelResolution: null };
  const separator = raw.indexOf(":");
  const actor = separator === -1 ? raw : raw.slice(0, separator).trim();
  const model = separator === -1 ? null : raw.slice(separator + 1).trim();
  if (!actor) throw new Error(`${phase} route must start with an actor name`);
  if (separator !== -1 && !model) throw new Error(`${phase} route model must be non-empty when ':' is used`);
  const actorField = REVIEWER_PHASES.has(phase) ? "reviewer" : "executor";
  if (!model || !policy) {
    return {
      spec: {
        [actorField]: actor,
        ...(model ? { model } : {}),
      },
      modelResolution: null,
    };
  }
  if (hasProviderModelRoute(model)) {
    return {
      spec: {
        [actorField]: actor,
        model,
      },
      modelResolution: null,
    };
  }

  const resolution = resolveModelRequest({
    phase,
    actor,
    actorField,
    model,
    fallback,
    policy,
  });
  if (!resolution.ok) {
    const details = resolution.policy_decision?.reason || resolution.error || "unresolved";
    const error = new Error(`failed to resolve ${phase} route ${raw}: ${details}`);
    error.resolution = resolution;
    throw error;
  }
  return {
    spec: {
      [actorField]: actor,
      model: resolution.resolved_route,
    },
    modelResolution: resolutionMetadata(resolution, { originalInput: raw }),
  };
}

function assignModelResolution(target, phase, metadata) {
  if (!metadata) return;
  if (!isPlainObject(target.model_resolution)) target.model_resolution = {};
  target.model_resolution[phase] = metadata;
}

function readRouteIntentFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (error) {
    throw new Error(`failed to read route intent file at ${resolved}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`route intent file at ${resolved} must contain a JSON object`);
  }
  return parsed;
}

function humanWarning(warning) {
  return String(warning).replace(/\bpolicy label\b/g, "route label");
}

function routePlanPhaseValues(phases = {}) {
  const values = [];
  for (const phase of Object.values(phases || {})) {
    if (Array.isArray(phase)) values.push(...phase.filter(Boolean));
    else if (phase) values.push(phase);
  }
  return values;
}

function commandPlanRun(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("plan-run does not accept positional arguments");
  }
  const repoRoot = path.resolve(readArg(args, "--repo", process.cwd(), CLI_ARG_OPTIONS));
  const routeIntentFile = readArg(args, "--route-intent-file", undefined, CLI_ARG_OPTIONS);
  const runIntent = {
    ...readRouteIntentFile(routeIntentFile),
  };
  const policyResult = loadRelayPolicy({ repoRoot });
  const projectConfig = loadProjectConfig({ repoRoot });
  const projectRoutes = loadProjectRoutes({ repoRoot });
  if (!policyResult.ok) {
    const output = {
      ok: false,
      status: "policy_error",
      repo: {
        root: repoRoot,
        slug: null,
      },
      policy: policyResult,
      project_config: projectConfig,
      project_routes: projectRoutes,
      route_plan: null,
      warnings: [],
    };
    if (jsonOut) printJson(output);
    else console.error(`relay-config plan-run: routes failed: ${policyResult.errors?.[0]?.message || "unknown route config error"}`);
    process.exitCode = 1;
    return;
  }
  if (!projectRoutes.ok) {
    const output = {
      ok: false,
      status: "routes_error",
      repo: {
        root: repoRoot,
        slug: getRepoSlug(repoRoot),
      },
      policy: policyResult,
      project_config: projectConfig,
      project_routes: projectRoutes,
      route_plan: null,
      warnings: [],
    };
    if (jsonOut) printJson(output);
    else console.error(`relay-config plan-run: routes failed: ${projectRoutes.error}`);
    process.exitCode = 1;
    return;
  }

  const dispatchSpec = parseRouteSpecWithResolution(readArg(args, "--dispatch", undefined, CLI_ARG_OPTIONS), "dispatch", { policy: policyResult.policy });
  const reviewSpec = parseRouteSpecWithResolution(readArg(args, "--review", undefined, CLI_ARG_OPTIONS), "review", { policy: policyResult.policy });
  const advisorySpec = parseRouteSpecWithResolution(readArg(args, "--advisory-review", undefined, CLI_ARG_OPTIONS), "advisory_review", { policy: policyResult.policy });
  if (dispatchSpec.spec) runIntent.dispatch = dispatchSpec.spec;
  if (reviewSpec.spec) runIntent.review = reviewSpec.spec;
  if (advisorySpec.spec) runIntent.advisory_review = advisorySpec.spec;
  assignModelResolution(runIntent, "dispatch", dispatchSpec.modelResolution);
  assignModelResolution(runIntent, "review", reviewSpec.modelResolution);
  assignModelResolution(runIntent, "advisory_review", advisorySpec.modelResolution);

  const routePlan = resolveRouteIntent({
    runIntent,
    projectRoutes: projectRoutes.routes,
    policy: policyResult.policy,
  });
  const phaseValues = routePlanPhaseValues(routePlan.phases);
  const denied = phaseValues.filter((phase) => phase.policy_decision?.allowed !== true);
  const warnings = modelResolutionWarnings(runIntent);
  for (const phase of phaseValues) {
    const actor = phase.executor || phase.reviewer;
    if (actor === "antigravity" && phase.model) {
      warnings.push(`antigravity ${phase.phase} model ${phase.model} is a policy label; not passed to agy until the CLI exposes model selection`);
    }
  }
  const output = {
    ok: denied.length === 0,
    status: denied.length === 0 ? "allowed" : "denied",
    repo: {
      root: repoRoot,
      slug: getRepoSlug(repoRoot),
    },
    project_paths: {
      project_json: getProjectConfigPath(repoRoot),
      policy_json: getProjectPolicyPath(repoRoot),
      routes_json: getProjectRoutesPath(repoRoot),
    },
    policy: {
      status: policyResult.status,
      sources: policyResult.sources,
    },
    project_config: projectConfig,
    project_routes: projectRoutes,
    route_plan: routePlan,
    denied_phases: denied.map((phase) => phase.phase),
    warnings,
  };

  if (jsonOut) {
    printJson(output);
  } else {
    console.log(`relay-config plan-run: ${output.status}`);
    for (const phase of phaseValues) {
      const actor = phase.executor || phase.reviewer || "(none)";
      console.log(`${phase.phase}: ${actor} model=${phase.model || "(none)"} decision=${phase.policy_decision.reason}`);
    }
    for (const warning of warnings) console.log(`warning: ${humanWarning(warning)}`);
  }
  if (!output.ok) process.exitCode = 1;
}

function commandSetDefault(positionals, jsonOut) {
  if (positionals.length !== 3) {
    throw new Error("set-default requires <path> <value>");
  }
  const defaultPath = positionals[1];
  const value = requireValue(positionals[2], "default value");
  if (!DEFAULT_PATHS.has(defaultPath)) {
    throw new Error(`unsupported default path: ${defaultPath}`);
  }

  const { routesPath, routes, warnings } = loadRoutesForMutation();
  const updated = cloneJson(routes);
  const [phase, field] = defaultPath.split(".");
  if (!hasOwn(updated, "defaults")) updated.defaults = {};
  updated.defaults[phase] = {
    ...(isPlainObject(updated.defaults[phase]) ? updated.defaults[phase] : {}),
    [field]: value,
  };
  const written = writeRoutes(routesPath, updated);
  outputMutation({ jsonOut, action: "set-default", routesPath, routes: written, defaultPath, warnings });
}

function commandRouteMutation(positionals, jsonOut, { action, listName, requirePhase }) {
  if (positionals.length !== 2) {
    throw new Error(`${action} requires <pattern>`);
  }
  const pattern = positionals[1];
  const phases = parsePhases(readArg(args, "--phase", undefined, CLI_ARG_OPTIONS), { required: requirePhase });
  const executor = readArg(args, "--executor", undefined, CLI_ARG_OPTIONS);
  const reviewer = readArg(args, "--reviewer", undefined, CLI_ARG_OPTIONS);
  const entry = routeEntry(pattern, { phases, executor, reviewer });

  const { routesPath, routes, warnings } = loadRoutesForMutation();
  const updated = cloneJson(routes);
  if (!hasOwn(updated, listName)) updated[listName] = [];
  updated[listName].push(entry);
  const written = writeRoutes(routesPath, updated);
  outputMutation({ jsonOut, action, routesPath, routes: written, entry, warnings });
}

function presetActorForPhase(phase, value) {
  if (!isPlainObject(value)) return null;
  return REVIEWER_PHASES.has(phase) ? nonEmptyString(value.reviewer) : nonEmptyString(value.executor);
}

function presetReferenceWarnings(routes, presetName, preset) {
  const warnings = [];
  const policyResult = loadRelayPolicy({ globalRoutes: routes });
  const policy = policyResult.ok ? policyResult.policy : null;
  for (const phase of VALID_PHASES) {
    const phaseValue = preset[phase];
    if (!isPlainObject(phaseValue)) continue;
    const actor = presetActorForPhase(phase, phaseValue);
    if (actor && !findOnPath(actor)) {
      warnings.push(`${actor} CLI not found on PATH for preset ${presetName} ${phase}`);
    }
    const model = nonEmptyString(phaseValue.model);
    if (policy && routes.strict === true && actor && model) {
      const decision = REVIEWER_PHASES.has(phase)
        ? evaluateRelayRoute(policy, { phase, reviewer: actor, model })
        : evaluateRelayRoute(policy, { phase, executor: actor, model });
      if (decision.reason === "unknown_model_route" || decision.reason === "missing_model_route") {
        warnings.push(`strict routes config does not register ${phase} route ${model} for ${actor}`);
      }
    }
  }
  return warnings;
}

function parsePresetFromArgs({ policy }) {
  const preset = {};
  const dispatchSpec = parseRouteSpecWithResolution(readArg(args, "--dispatch", undefined, CLI_ARG_OPTIONS), "dispatch", { policy });
  const reviewSpec = parseRouteSpecWithResolution(readArg(args, "--review", undefined, CLI_ARG_OPTIONS), "review", { policy });
  const advisorySpec = parseRouteSpecWithResolution(readArg(args, "--advisory-review", undefined, CLI_ARG_OPTIONS), "advisory_review", { policy });
  if (dispatchSpec.spec) preset.dispatch = dispatchSpec.spec;
  if (reviewSpec.spec) preset.review = reviewSpec.spec;
  assignModelResolution(preset, "dispatch", dispatchSpec.modelResolution);
  assignModelResolution(preset, "review", reviewSpec.modelResolution);
  const advisoryProfile = nonEmptyString(readArg(args, "--advisory-profile", undefined, CLI_ARG_OPTIONS));
  if (advisoryProfile && !advisorySpec.spec) {
    throw new Error("--advisory-profile requires --advisory-review");
  }
  if (advisorySpec.spec) {
    preset.advisory_review = {
      ...advisorySpec.spec,
      ...(advisoryProfile ? { profile: advisoryProfile } : {}),
    };
    assignModelResolution(preset, "advisory_review", advisorySpec.modelResolution);
  }
  const reviewAssurance = nonEmptyString(readArg(args, "--review-assurance", undefined, CLI_ARG_OPTIONS));
  if (reviewAssurance) {
    preset.review_assurance = normalizeReviewAssurance(reviewAssurance);
  }
  if (!Object.keys(preset).length) {
    throw new Error("preset add requires at least one of --dispatch, --review, --advisory-review, or --review-assurance");
  }
  return preset;
}

function modelResolutionWarnings(routeIntent) {
  const warnings = [];
  for (const metadata of Object.values(routeIntent.model_resolution || {})) {
    for (const warning of metadata?.warnings || []) {
      if (warning && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  return warnings;
}

const PRESET_MUTATION_FLAGS = [
  "--dispatch", "--review", "--advisory-review", "--advisory-profile", "--review-assurance",
];

// add-only flags describe a mutation; show/remove must reject them rather than
// silently ignore an inapplicable flag. Detect presence (hasCliFlag), not a
// parsed value — a value flag given bare (e.g. `--dispatch --json`) reads back as
// undefined but is still present and must still be rejected.
function assertNoPresetMutationFlags(action) {
  const present = PRESET_MUTATION_FLAGS.filter((flag) => hasCliFlag(flag));
  if (present.length) {
    throw new Error(`preset ${action} does not accept ${present.join(", ")}`);
  }
}

function commandPreset(positionals, jsonOut) {
  const action = positionals[1];
  if (!["add", "remove", "show"].includes(action)) {
    throw new Error("preset requires add, remove, or show");
  }
  if (action !== "add") {
    assertNoPresetMutationFlags(action);
  }

  if (action === "show") {
    if (positionals.length !== 2 && positionals.length !== 3) {
      throw new Error("preset show accepts optional <name>");
    }
    const name = positionals[2] ? requireValue(positionals[2], "preset name") : null;
    const presets = loadGlobalPresetsForShow();
    const output = {
      ok: true,
      action: "preset show",
      presets,
      ...(name ? { presetName: name, preset: presets[name] || null } : {}),
    };
    if (name && !presets[name]) {
      throw new Error(`unknown preset: ${name}`);
    }
    if (jsonOut) {
      printJson(output);
    } else if (name) {
      console.log(JSON.stringify(output.preset, null, 2));
    } else {
      console.log(JSON.stringify(presets, null, 2));
    }
    return;
  }

  if (positionals.length !== 3) {
    throw new Error(`preset ${action} requires <name>`);
  }
  const presetName = requireValue(positionals[2], "preset name");
  const { routesPath, routes, warnings } = loadRoutesForMutation();
  const updated = cloneJson(routes);

  if (action === "add") {
    const policyResult = loadRelayPolicy({ globalRoutes: routes });
    if (!policyResult.ok) {
      throw new Error(policyResult.errors?.[0]?.message || "failed to load routes config for preset resolution");
    }
    const preset = parsePresetFromArgs({ policy: policyResult.policy });
    updated.presets = {
      ...(isPlainObject(updated.presets) ? updated.presets : {}),
      [presetName]: preset,
    };
    validateRouteConfig(updated, routesPath);
    const routeWarnings = presetReferenceWarnings(updated, presetName, preset);
    const written = writeRoutes(routesPath, updated);
    outputMutation({
      jsonOut,
      action: "preset add",
      routesPath,
      routes: written,
      presetName,
      preset,
      warnings: [...warnings, ...modelResolutionWarnings(preset), ...routeWarnings],
    });
    return;
  }

  if (!isPlainObject(updated.presets) || !Object.prototype.hasOwnProperty.call(updated.presets, presetName)) {
    throw new Error(`unknown preset: ${presetName}`);
  }
  const removed = updated.presets[presetName];
  delete updated.presets[presetName];
  if (!Object.keys(updated.presets).length) delete updated.presets;
  const written = writeRoutes(routesPath, updated);
  outputMutation({
    jsonOut,
    action: "preset remove",
    routesPath,
    routes: written,
    presetName,
    preset: removed,
    warnings,
  });
}

function main() {
  if (!args.length || hasCliFlag(["--help", "-h"])) {
    printHelp();
    return;
  }

  const unknownFlags = findUnknownFlags(args, COMMAND_NAME);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const jsonOut = hasCliFlag("--json");
  const positionals = getPositionals(args, COMMAND_NAME);
  const command = positionals[0];
  if (!command) {
    throw new Error("command is required");
  }
  if (!Object.prototype.hasOwnProperty.call(SUBCOMMAND_FLAGS, command)) {
    throw new Error(`unknown command: ${command}`);
  }

  const unsupportedFlags = unsupportedFlagsForCommand(command, args);
  if (unsupportedFlags.length) {
    throw new Error(`unsupported flags for ${command}: ${unsupportedFlags.join(", ")}`);
  }

  switch (command) {
    case "init":
      commandInit(positionals, jsonOut);
      break;
    case "show":
      commandShow(positionals, jsonOut);
      break;
    case "doctor":
      commandDoctor(positionals, jsonOut);
      break;
    case "catalog-report":
      commandCatalogReport(positionals, jsonOut);
      break;
    case "resolve-model":
      commandResolveModel(positionals, jsonOut);
      break;
    case "check":
      commandCheck(positionals, jsonOut);
      break;
    case "plan-run":
      commandPlanRun(positionals, jsonOut);
      break;
    case "set-default":
      commandSetDefault(positionals, jsonOut);
      break;
    case "add-route":
      commandRouteMutation(positionals, jsonOut, {
        action: "add-route",
        listName: "routes",
        requirePhase: true,
      });
      break;
    case "allow-route":
      console.error("Warning: allow-route is deprecated; use add-route");
      commandRouteMutation(positionals, jsonOut, {
        action: "add-route",
        listName: "routes",
        requirePhase: true,
      });
      break;
    case "deny-route":
      commandRouteMutation(positionals, jsonOut, {
        action: "deny-route",
        listName: "denied_routes",
        requirePhase: false,
      });
      break;
    case "preset":
      commandPreset(positionals, jsonOut);
      break;
  }
}

try {
  main();
} catch (error) {
  if (hasCliFlag("--json")) {
    printJson({
      ok: false,
      error: error.message,
      ...(error.resolution ? { resolution: error.resolution } : {}),
    });
  } else {
    console.error(`Error: ${error.message}`);
  }
  process.exit(1);
}
