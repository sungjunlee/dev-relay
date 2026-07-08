#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  evaluateRelayRoute,
  loadRelayPolicy,
  resolveRelayPolicyPath,
} = require("./relay-policy");
const { loadProjectConfig } = require("./project-config");
const { getProjectConfigPath, getProjectPolicyPath, getProjectRoutesPath, getRepoSlug } = require("./manifest/paths");
const {
  loadRouteConfig,
  loadProjectRoutes,
  resolveGlobalRoutesPath,
  resolveRouteIntent,
  validateRouteConfig,
} = require("./relay-routing");
const {
  readAllRunEvents,
  EVENTS,
} = require("./relay-events");
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
  gaps: new Set(["--json", "--help"]),
  migrate: new Set(["--yes", "--json", "--help"]),
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
  console.log(`  gaps [--json ${modeLabel("--json")}]`);
  console.log(`  migrate [--yes] [--json ${modeLabel("--json")}]`);
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
  console.log("  dispatch.executor, review.reviewer, advisory_review.reviewer, executor_defaults.<executor>.model");
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
    "routes.json now takes precedence; legacy policy.json/executors.json are ignored; run relay-config migrate to fold legacy defaults into routes.json",
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

function routeActorEntries(policy, listName = "allowed_model_routes") {
  const entries = [];
  for (const route of policy?.[listName] || []) {
    const phases = route.phases || VALID_PHASES;
    for (const phase of phases) {
      const actorField = actorFieldForPhase(phase);
      const actors = actorField === "reviewer" ? route.reviewers : route.executors;
      for (const actor of actors || []) {
        entries.push({
          phase,
          actor,
          actorField,
          route: route.route,
          listName,
        });
      }
    }
  }
  return entries;
}

function sampleRouteFromPattern(pattern) {
  const route = nonEmptyString(pattern);
  if (!route) return null;
  if (!route.includes("*")) return route;
  return route.replace(/\*/g, "fast");
}

function defaultRoutePatternForActor(actor) {
  if (actor === "opencode") return "example/opencode-model-*";
  if (actor === "pi") return "example/pi-*";
  return `${actor}/*`;
}

function addRouteProposal({ phase, actor, actorField, route }) {
  const args = ["add-route", route, "--phase", phase];
  args.push(actorField === "reviewer" ? "--reviewer" : "--executor", actor, "--json");
  return { subcommand: "add-route", args };
}

function denyRouteProposal({ phase, actor, actorField, route }) {
  const args = ["deny-route", route, "--phase", phase];
  args.push(actorField === "reviewer" ? "--reviewer" : "--executor", actor, "--json");
  return {
    subcommand: "deny-route",
    args,
    note: `or install ${actor} manually`,
  };
}

function removePresetProposal(presetName) {
  return {
    subcommand: "preset",
    args: ["preset", "remove", presetName, "--json"],
  };
}

function probeDiagnosticProposal() {
  return {
    kind: "diagnostic",
    command: "doctor",
    args: ["doctor", "--json"],
    automatic: false,
    reason: "probe_failure",
  };
}

function migrateProposal() {
  return { subcommand: "migrate", args: ["migrate", "--yes", "--json"] };
}

function setExecutorDefaultProposal(actor, model) {
  return {
    subcommand: "set-default",
    args: ["set-default", `executor_defaults.${actor}.model`, model, "--json"],
  };
}

function gapKey(gap) {
  return JSON.stringify([
    gap.type,
    gap.actor || null,
    gap.actor_field || null,
    gap.phase || null,
    gap.route || null,
    gap.model || null,
    gap.path || null,
    gap.preset || null,
  ]);
}

function pushGap(gaps, seen, gap) {
  const key = gapKey(gap);
  if (seen.has(key)) return;
  seen.add(key);
  gaps.push(gap);
}

function executorDefaultModel(policy, actor) {
  return nonEmptyString(policy?.executor_defaults?.[actor]?.model);
}

function legacyConfigPaths({ repoRoot, relayHome }) {
  const paths = [];
  const globalPolicy = resolveRelayPolicyPath({ relayHome });
  if (globalPolicy && fs.existsSync(globalPolicy)) {
    paths.push({ kind: "global_policy", path: globalPolicy });
  }
  const executorsPath = process.env.RELAY_EXECUTORS_PATH || path.join(relayHome || process.env.RELAY_HOME || path.join(os.homedir(), ".relay"), "executors.json");
  if (executorsPath && fs.existsSync(executorsPath)) {
    paths.push({ kind: "executors", path: executorsPath });
  }
  const repoPolicy = repoRoot ? path.join(repoRoot, ".relay", "policy.json") : null;
  if (repoPolicy && fs.existsSync(repoPolicy)) {
    paths.push({ kind: "repo_policy", path: repoPolicy });
  }
  let projectRoutesPath = null;
  if (repoRoot) {
    try {
      projectRoutesPath = getProjectRoutesPath(repoRoot, { relayHome });
    } catch {
      projectRoutesPath = null;
    }
  }
  if (projectRoutesPath && fs.existsSync(projectRoutesPath)) {
    try {
      const projectRoutes = readRoutesFile(projectRoutesPath);
      if (projectRoutes?.version === 1) {
        paths.push({ kind: "project_routes_v1", path: projectRoutesPath });
      }
    } catch {
      paths.push({ kind: "project_routes_unknown", path: projectRoutesPath });
    }
  }
  return paths;
}

function configuredActorSet(policy) {
  const actors = new Set([
    ...defaultActors(policy),
    ...routeActors(policy),
  ]);
  return actors;
}

function routeConfiguredForTuple(policy, { phase, actor, actorField, model }) {
  const tuple = actorField === "reviewer"
    ? { phase, reviewer: actor, model }
    : { phase, executor: actor, model };
  const decision = evaluateRelayRoute(policy, tuple);
  return decision.reason === "allowed_model_route" || decision.reason === "managed_cli";
}

function deniedRouteConfiguredForTuple(policy, tuple) {
  return (policy.denied_model_routes || []).some((entry) => routeEntryCoversTuple(entry, tuple));
}

function collectPresetGaps({ gaps, seen, policy, toolsByName }) {
  const presets = policy?.presets || {};
  if (!isPlainObject(presets) || Object.keys(presets).length === 0) return;
  for (const [presetName, preset] of Object.entries(presets)) {
    if (!isPlainObject(preset)) continue;
    for (const phase of VALID_PHASES) {
      const phaseValue = preset[phase];
      if (!isPlainObject(phaseValue)) continue;
      const actorField = actorFieldForPhase(phase);
      const actor = nonEmptyString(phaseValue[actorField]);
      if (!actor) continue;
      const tool = toolsByName.get(actor) || doctorTool(policy, actor);
      if (tool && !tool.installed) {
        pushGap(gaps, seen, {
          type: "preset_broken",
          preset: presetName,
          phase,
          actor,
          actor_field: actorField,
          reason: "cli_missing",
          proposal: removePresetProposal(presetName),
        });
      }
      const model = nonEmptyString(phaseValue.model);
      if (policy.deny_unknown_model_routes && model) {
        const decision = evaluateRelayRoute(policy, actorField === "reviewer"
          ? { phase, reviewer: actor, model }
          : { phase, executor: actor, model });
        if (decision.reason === "unknown_model_route" || decision.reason === "missing_model_route") {
          pushGap(gaps, seen, {
            type: "preset_broken",
            preset: presetName,
            phase,
            actor,
            actor_field: actorField,
            model,
            reason: decision.reason,
            proposal: addRouteProposal({ phase, actor, actorField, route: model }),
          });
        }
      }
    }
  }
}

function collectUsageGaps({ gaps, seen, policy, repoRoot }) {
  let events = [];
  try {
    events = readAllRunEvents(repoRoot);
  } catch {
    events = [];
  }
  const tuples = new Map();
  for (const event of events) {
    if (event.event !== EVENTS.UNREGISTERED_ROUTE_USED) continue;
    const phase = nonEmptyString(event.phase || event.policy_decision?.phase);
    const actorField = nonEmptyString(event.actor_field || event.policy_decision?.actor_field)
      || (phase === "review" || phase === "advisory_review" ? "reviewer" : "executor");
    const actor = nonEmptyString(actorField === "reviewer"
      ? (event.reviewer || event.policy_decision?.reviewer || event.policy_decision?.actor)
      : (event.executor || event.policy_decision?.executor || event.policy_decision?.actor));
    const model = nonEmptyString(event.model || event.policy_decision?.model);
    if (!phase || !actor || !model) continue;
    const key = `${phase}\u0000${actorField}\u0000${actor}\u0000${model}`;
    tuples.set(key, { phase, actorField, actor, model, count: (tuples.get(key)?.count || 0) + 1 });
  }
  for (const tuple of [...tuples.values()].sort((a, b) => `${a.phase}:${a.actor}:${a.model}`.localeCompare(`${b.phase}:${b.actor}:${b.model}`))) {
    if (routeConfiguredForTuple(policy, tuple)) continue;
    pushGap(gaps, seen, {
      type: "unregistered_route_in_use",
      phase: tuple.phase,
      actor: tuple.actor,
      actor_field: tuple.actorField,
      model: tuple.model,
      occurrences: tuple.count,
      proposal: addRouteProposal({
        phase: tuple.phase,
        actor: tuple.actor,
        actorField: tuple.actorField,
        route: tuple.model,
      }),
    });
  }
}

function commandGaps(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("gaps does not accept positional arguments");
  }
  const repoRoot = process.cwd();
  const relayHome = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const policyResult = loadRelayPolicy({ repoRoot, relayHome });
  if (!policyResult.ok) {
    const output = { ok: false, status: policyResult.status, sources: policyResult.sources, errors: policyResult.errors, gaps: [] };
    if (jsonOut) printJson(output);
    else console.error(`relay-config gaps: routes failed: ${policyResult.errors?.[0]?.message || "unknown route config error"}`);
    process.exitCode = 1;
    return;
  }

  const routeConfig = loadRouteConfig({ repoRoot, relayHome });
  const toolNames = [...new Set([
    ...DOCTOR_TOOLS,
    ...policyResult.policy.managed_cli,
    ...defaultActors(policyResult.policy),
    ...routeActors(policyResult.policy),
  ])].sort();
  const tools = toolNames.map((name) => doctorTool(policyResult.policy, name));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const configuredActors = configuredActorSet(policyResult.policy);
  const gaps = [];
  const seen = new Set();

  for (const tool of tools) {
    if (tool.installed && !configuredActors.has(tool.name) && tool.policy === "policy-disallowed") {
      const route = defaultRoutePatternForActor(tool.name);
      pushGap(gaps, seen, {
        type: "installed_cli_unrouted",
        actor: tool.name,
        path: tool.path,
        phase: "dispatch",
        actor_field: "executor",
        proposal: addRouteProposal({ phase: "dispatch", actor: tool.name, actorField: "executor", route }),
      });
    }
    if (tool.model_probe?.status === "warning") {
      pushGap(gaps, seen, {
        type: "probe_failure",
        actor: tool.name,
        path: tool.path,
        warning: tool.model_probe.warning,
        proposal: probeDiagnosticProposal(),
      });
    }
  }

  for (const entry of [
    ...routeActorEntries(policyResult.policy, "allowed_model_routes"),
    ...routeActorEntries(policyResult.policy, "denied_model_routes"),
  ]) {
    const tool = toolsByName.get(entry.actor) || doctorTool(policyResult.policy, entry.actor);
    if (
      !tool.installed
      && entry.listName === "allowed_model_routes"
      && !deniedRouteConfiguredForTuple(policyResult.policy, entry)
    ) {
      pushGap(gaps, seen, {
        type: "route_without_cli",
        actor: entry.actor,
        actor_field: entry.actorField,
        phase: entry.phase,
        route: entry.route,
        proposal: denyRouteProposal(entry),
      });
    }
    if (entry.listName === "allowed_model_routes" && entry.actorField === "executor" && entry.phase === "dispatch" && !executorDefaultModel(policyResult.policy, entry.actor)) {
      const model = sampleRouteFromPattern(entry.route);
      if (model) {
        pushGap(gaps, seen, {
          type: "executor_missing_default_model",
          actor: entry.actor,
          phase: entry.phase,
          route: entry.route,
          model,
          proposal: setExecutorDefaultProposal(entry.actor, model),
        });
      }
    }
  }

  for (const legacy of legacyConfigPaths({ repoRoot, relayHome })) {
    pushGap(gaps, seen, {
      type: "legacy_config_present",
      legacy_kind: legacy.kind,
      path: legacy.path,
      shadowed: routeConfig.status === "ok",
      proposal: migrateProposal(),
    });
  }

  collectPresetGaps({ gaps, seen, policy: policyResult.policy, toolsByName });
  collectUsageGaps({ gaps, seen, policy: policyResult.policy, repoRoot });

  gaps.sort((a, b) => gapKey(a).localeCompare(gapKey(b)));
  const output = {
    ok: true,
    status: policyResult.status,
    sources: policyResult.sources,
    route_config: {
      status: routeConfig.status,
      sources: routeConfig.sources,
    },
    tools,
    gaps,
  };

  if (jsonOut) {
    printJson(output);
  } else {
    console.log(`relay-config gaps: ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`);
    for (const gap of gaps) {
      const subject = [gap.type, gap.actor, gap.phase, gap.model || gap.route || gap.path].filter(Boolean).join(" ");
      const proposal = gap.proposal.subcommand
        ? `${gap.proposal.subcommand} ${gap.proposal.args.slice(1).join(" ")}`
        : `${gap.proposal.kind || "manual"} ${gap.proposal.action || gap.proposal.reason || ""}`.trim();
      console.log(`${subject}: ${proposal}`);
    }
  }
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readRoutesFile(filePath);
}

function executorDefaultsFromLegacyExecutors(filePath) {
  const parsed = readOptionalJson(filePath);
  const defaults = {};
  for (const [executor, config] of Object.entries(parsed?.executors || {})) {
    const model = nonEmptyString(config?.default_model);
    if (model) defaults[executor] = { model };
  }
  return defaults;
}

function routesFromPolicy(policy, executorDefaults) {
  const routes = {
    version: 2,
    strict: policy.deny_unknown_model_routes === true,
    defaults: cloneJson(policy.defaults || {}),
    executor_defaults: {
      ...(isPlainObject(policy.executor_defaults) ? cloneJson(policy.executor_defaults) : {}),
      ...executorDefaults,
    },
    routes: cloneJson(policy.allowed_model_routes || []),
    denied_routes: cloneJson(policy.denied_model_routes || []),
  };
  if (isPlainObject(policy.presets) && Object.keys(policy.presets).length) {
    routes.presets = cloneJson(policy.presets);
  }
  if (!Object.keys(routes.executor_defaults).length) delete routes.executor_defaults;
  validateRouteConfig(routes, "migrated routes config");
  return routes;
}

function mergeRouteDefaults(base = {}, override = {}) {
  const merged = cloneJson(base || {});
  for (const phase of VALID_PHASES) {
    if (!hasOwn(override || {}, phase)) continue;
    merged[phase] = {
      ...(isPlainObject(merged[phase]) ? merged[phase] : {}),
      ...(isPlainObject(override[phase]) ? override[phase] : {}),
    };
  }
  return merged;
}

function routeEntryCoversTuple(entry, { phase, actorField, actor, route }) {
  if (entry.route !== route) return false;
  if (entry.phases !== undefined && !entry.phases.includes(phase)) return false;
  const hasActorScope = entry.executors !== undefined || entry.reviewers !== undefined;
  if (!hasActorScope) return true;
  const actors = actorField === "reviewer" ? entry.reviewers : entry.executors;
  return Boolean(actor && actors?.includes(actor));
}

function routeEntryTuples(entry) {
  const tuples = [];
  const route = nonEmptyString(entry?.route);
  if (!route) return tuples;
  const phases = entry.phases || VALID_PHASES;
  const hasActorScope = entry.executors !== undefined || entry.reviewers !== undefined;
  for (const phase of phases) {
    const actorField = actorFieldForPhase(phase);
    const actors = actorField === "reviewer" ? entry.reviewers : entry.executors;
    if (!hasActorScope) {
      tuples.push({ phase, actorField, actor: null, route });
      continue;
    }
    for (const actor of actors || []) {
      tuples.push({ phase, actorField, actor, route });
    }
  }
  return tuples;
}

function routeEntryFromTuple({ phase, actorField, actor, route }) {
  const entry = { route, phases: [phase] };
  if (actor) {
    entry[actorField === "reviewer" ? "reviewers" : "executors"] = [actor];
  }
  return entry;
}

function appendLegacyOnlyRouteTuples(targetRoutes, legacyRoutes, listName) {
  const existing = Array.isArray(targetRoutes[listName]) ? cloneJson(targetRoutes[listName]) : [];
  const additions = [];
  for (const legacyEntry of legacyRoutes[listName] || []) {
    for (const tuple of routeEntryTuples(legacyEntry)) {
      const covered = [...existing, ...additions].some((entry) => routeEntryCoversTuple(entry, tuple));
      if (!covered) additions.push(routeEntryFromTuple(tuple));
    }
  }
  if (existing.length || additions.length) targetRoutes[listName] = [...existing, ...additions];
  else delete targetRoutes[listName];
}

function foldLegacyRoutesIntoExisting(existingRoutes, legacyRoutes) {
  const folded = cloneJson(existingRoutes);
  if (!hasOwn(folded, "version")) folded.version = 2;
  if (!hasOwn(folded, "strict") && hasOwn(legacyRoutes, "strict")) folded.strict = legacyRoutes.strict;

  const defaults = mergeRouteDefaults(legacyRoutes.defaults, folded.defaults);
  if (Object.keys(defaults).length) folded.defaults = defaults;
  else delete folded.defaults;

  const executorDefaults = {
    ...(isPlainObject(legacyRoutes.executor_defaults) ? cloneJson(legacyRoutes.executor_defaults) : {}),
    ...(isPlainObject(folded.executor_defaults) ? cloneJson(folded.executor_defaults) : {}),
  };
  if (Object.keys(executorDefaults).length) folded.executor_defaults = executorDefaults;
  else delete folded.executor_defaults;

  const presets = {
    ...(isPlainObject(legacyRoutes.presets) ? cloneJson(legacyRoutes.presets) : {}),
    ...(isPlainObject(folded.presets) ? cloneJson(folded.presets) : {}),
  };
  if (Object.keys(presets).length) folded.presets = presets;
  else delete folded.presets;

  appendLegacyOnlyRouteTuples(folded, legacyRoutes, "routes");
  appendLegacyOnlyRouteTuples(folded, legacyRoutes, "denied_routes");
  validateRouteConfig(folded, "migrated routes config");
  return folded;
}

function foldProjectRoutesV1(routes, projectRoutes) {
  if (projectRoutes.status === "absent" || projectRoutes.status === "ignored_v2") return routes;
  if (!projectRoutes.ok) {
    if (!projectRoutes.path) return routes;
    throw new Error(projectRoutes.error || "failed to load project routes v1");
  }
  if (projectRoutes.routes?.version !== 1) return routes;
  const folded = cloneJson(routes);
  folded.defaults = mergeRouteDefaults(folded.defaults, projectRoutes.routes.defaults);
  validateRouteConfig(folded, "migrated routes config");
  return folded;
}

function writeMigratedMarker(filePath, routesPath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const markerPath = `${filePath}.migrated`;
  fs.writeFileSync(
    markerPath,
    `migrated into routes.json\nsource: ${filePath}\ntarget: ${routesPath}\nlegacy file retained; do not delete automatically\n`,
    "utf-8"
  );
  return markerPath;
}

function commandMigrate(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("migrate does not accept positional arguments");
  }
  const repoRoot = process.cwd();
  const relayHome = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const routesPath = relayRoutesPath();
  const executorsPath = process.env.RELAY_EXECUTORS_PATH || path.join(relayHome, "executors.json");
  const confirmed = hasCliFlag("--yes");
  const routesExisted = fs.existsSync(routesPath);
  const policyResult = loadRelayPolicy({
    repoRoot,
    relayHome,
    routesPath: path.join(relayHome, "__relay_config_migrate_absent_routes__.json"),
  });
  if (!policyResult.ok) {
    const output = { ok: false, status: "policy_error", errors: policyResult.errors };
    if (jsonOut) printJson(output);
    else console.error(`relay-config migrate: legacy routes failed: ${policyResult.errors?.[0]?.message || "unknown route config error"}`);
    process.exitCode = 1;
    return;
  }
  const executorDefaults = executorDefaultsFromLegacyExecutors(executorsPath);
  const projectRoutes = loadProjectRoutes({ repoRoot, relayHome });
  let routes;
  try {
    const legacyRoutes = foldProjectRoutesV1(routesFromPolicy(policyResult.policy, executorDefaults), projectRoutes);
    routes = routesExisted
      ? foldLegacyRoutesIntoExisting(validateRouteConfig(readRoutesFile(routesPath), routesPath), legacyRoutes)
      : legacyRoutes;
  } catch (error) {
    const output = { ok: false, status: "project_routes_error", errors: [{ message: error.message }], project_routes: projectRoutes };
    if (jsonOut) printJson(output);
    else console.error(`relay-config migrate: project routes failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const legacyPaths = legacyConfigPaths({ repoRoot, relayHome });
  const output = {
    ok: true,
    action: "migrate",
    dry_run: !confirmed,
    wrote: false,
    path: routesPath,
    routes,
    project_routes: projectRoutes,
    legacy: legacyPaths,
    summary: [
      `${(routes.routes || []).length} allowed route(s)`,
      `${(routes.denied_routes || []).length} denied route(s)`,
      `${Object.keys(routes.executor_defaults || {}).length} executor default(s)`,
      `strict=${routes.strict === true}`,
    ],
  };

  if (!confirmed) {
    if (jsonOut) {
      printJson(output);
    } else {
      console.log("relay-config migrate: dry run");
      for (const line of output.summary) console.log(`  ${line}`);
      console.log("rerun with --yes to write routes.json and .migrated marker notes");
    }
    return;
  }

  writeRoutes(routesPath, routes);
  const markers = [];
  for (const legacy of legacyPaths) {
    const marker = writeMigratedMarker(legacy.path, routesPath);
    if (marker) markers.push(marker);
  }
  output.dry_run = false;
  output.wrote = true;
  output.markers = markers;

  if (jsonOut) {
    printJson(output);
  } else {
    console.log(`relay-config migrate: wrote ${routesPath}`);
    for (const line of output.summary) console.log(`  ${line}`);
    for (const marker of markers) console.log(`  marker: ${marker}`);
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
  const executorDefaultMatch = defaultPath.match(/^executor_defaults\.([^.\s]+)\.model$/);
  if (!DEFAULT_PATHS.has(defaultPath) && !executorDefaultMatch) {
    throw new Error(`unsupported default path: ${defaultPath}`);
  }

  const { routesPath, routes, warnings } = loadRoutesForMutation();
  const updated = cloneJson(routes);
  if (executorDefaultMatch) {
    const executor = executorDefaultMatch[1];
    if (!hasOwn(updated, "executor_defaults")) updated.executor_defaults = {};
    updated.executor_defaults[executor] = {
      ...(isPlainObject(updated.executor_defaults[executor]) ? updated.executor_defaults[executor] : {}),
      model: value,
    };
  } else {
    const [phase, field] = defaultPath.split(".");
    if (!hasOwn(updated, "defaults")) updated.defaults = {};
    updated.defaults[phase] = {
      ...(isPlainObject(updated.defaults[phase]) ? updated.defaults[phase] : {}),
      [field]: value,
    };
  }
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
    case "gaps":
      commandGaps(positionals, jsonOut);
      break;
    case "migrate":
      commandMigrate(positionals, jsonOut);
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
