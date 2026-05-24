#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  buildDefaultRelayPolicy,
  evaluateRelayRoute,
  loadRelayPolicy,
  resolveRelayPolicyPath,
  validateRelayPolicy,
} = require("./relay-policy");
const {
  findUnknownFlags,
  getPositionals,
  modeLabel,
  readArg,
  schemaHasFlag,
} = require("./cli-args");

const args = process.argv.slice(2);
const COMMAND_NAME = "relay-config";
const CLI_ARG_OPTIONS = { commandName: COMMAND_NAME };
const VALID_PHASES = ["dispatch", "review", "advisory_review", "sidecar"];
const EXECUTOR_PHASES = new Set(["dispatch", "sidecar"]);
const REVIEWER_PHASES = new Set(["review", "advisory_review"]);
const DEFAULT_PATHS = new Set([
  "dispatch.executor",
  "review.reviewer",
  "advisory_review.reviewer",
  "sidecar.executor",
]);
const DOCTOR_TOOLS = ["codex", "claude", "opencode", "pi"];

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
  console.log("Configure relay provider/model route policy. Executor/reviewer names are harnesses; provider/model route strings are the policy boundary.");
  console.log("");
  console.log("Commands:");
  console.log(`  init --profile <company|personal> ${modeLabel("--profile")} [--json ${modeLabel("--json")}]`);
  console.log(`  show --effective ${modeLabel("--effective")} [--json ${modeLabel("--json")}]`);
  console.log(`  doctor [--json ${modeLabel("--json")}]`);
  console.log(`  check --phase <phase> ${modeLabel("--phase")} --executor <name> ${modeLabel("--executor")} [--reviewer <name> ${modeLabel("--reviewer")}] [--model <provider/model> ${modeLabel("--model")}] [--json ${modeLabel("--json")}]`);
  console.log("  set-default <path> <value> [--json]");
  console.log(`  allow-route <pattern> --phase <csv> ${modeLabel("--phase")} [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--json ${modeLabel("--json")}]`);
  console.log(`  deny-route <pattern> [--phase <csv> ${modeLabel("--phase")}] [--executor <name> ${modeLabel("--executor")}] [--reviewer <name> ${modeLabel("--reviewer")}] [--json ${modeLabel("--json")}]`);
  console.log("");
  console.log("Supported default paths:");
  console.log("  dispatch.executor, review.reviewer, advisory_review.reviewer, sidecar.executor");
  console.log("");
  console.log(`Options: --help ${modeLabel("--help")}`);
}

function relayPolicyPath() {
  return resolveRelayPolicyPath();
}

function writePolicy(policyPath, policy) {
  const normalized = validateRelayPolicy(policy, policyPath);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

function loadGlobalPolicyForMutation() {
  const policyPath = relayPolicyPath();
  const result = loadRelayPolicy({ globalPath: policyPath, repoRoot: null });
  if (!result.ok) {
    const error = result.errors[0];
    throw new Error(error ? error.message : "failed to load relay policy");
  }
  return {
    policyPath,
    policy: result.policy,
  };
}

function buildProfilePolicy(profile) {
  return validateRelayPolicy(
    {
      ...buildDefaultRelayPolicy(),
      profile,
    },
    `${profile} relay policy`
  );
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

function outputMutation({ jsonOut, action, policyPath, policy, entry = null, defaultPath = null }) {
  if (jsonOut) {
    printJson({
      ok: true,
      action,
      path: policyPath,
      defaultPath,
      entry,
      policy,
    });
    return;
  }
  console.log(`relay-config: ${action} wrote ${policyPath}`);
}

function commandInit(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("init does not accept positional arguments");
  }
  const profile = requireValue(readArg(args, "--profile", undefined, CLI_ARG_OPTIONS), "--profile");
  const policyPath = relayPolicyPath();
  const policy = writePolicy(policyPath, buildProfilePolicy(profile));
  if (jsonOut) {
    printJson({
      ok: true,
      action: "init",
      profile,
      path: policyPath,
      policy,
    });
  } else {
    console.log(`relay-config: initialized ${profile} policy at ${policyPath}`);
  }
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
    console.log(`relay-config: effective policy status ${result.status}`);
    console.log(`global: ${result.sources.global}`);
    if (result.sources.repo) console.log(`repo: ${result.sources.repo}`);
    console.log(JSON.stringify(result.policy, null, 2));
  } else {
    console.log("relay-config: effective policy failed to load");
    for (const error of result.errors) {
      console.log(`${error.reason}: ${error.message}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

function pathEntries() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function findOnPath(binaryName) {
  for (const dir of pathEntries()) {
    const candidate = path.join(dir, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return null;
}

function defaultActors(policy) {
  return [
    policy.defaults.dispatch?.executor,
    policy.defaults.review?.reviewer,
    policy.defaults.advisory_review?.reviewer,
    policy.defaults.sidecar?.executor,
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
  };
}

function commandDoctor(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("doctor does not accept positional arguments");
  }
  const result = loadRelayPolicy({ repoRoot: process.cwd() });
  if (!result.ok) {
    if (jsonOut) printJson({ ok: false, status: result.status, sources: result.sources, errors: result.errors });
    else {
      console.error("relay-config doctor: policy failed to load");
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
  const output = {
    ok: true,
    status: result.status,
    sources: result.sources,
    tools,
  };

  if (jsonOut) {
    printJson(output);
  } else {
    console.log(`relay-config doctor: policy ${result.status}`);
    for (const tool of tools) {
      const installed = tool.installed ? `installed at ${tool.path}` : "not installed on PATH";
      console.log(`${tool.name}: ${installed}; ${tool.policy} (${tool.reason})`);
    }
  }
}

function commandCheck(positionals, jsonOut) {
  if (positionals.length !== 1) {
    throw new Error("check does not accept positional arguments");
  }

  const phase = requireValue(readArg(args, "--phase", undefined, CLI_ARG_OPTIONS), "--phase");
  if (!VALID_PHASES.includes(phase)) {
    throw new Error(`unsupported phase: ${phase}; expected one of: ${VALID_PHASES.join(", ")}`);
  }
  const executor = requireValue(readArg(args, "--executor", undefined, CLI_ARG_OPTIONS), "--executor");
  const reviewer = readArg(args, "--reviewer", undefined, CLI_ARG_OPTIONS);
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

function commandSetDefault(positionals, jsonOut) {
  if (positionals.length !== 3) {
    throw new Error("set-default requires <path> <value>");
  }
  const defaultPath = positionals[1];
  const value = requireValue(positionals[2], "default value");
  if (!DEFAULT_PATHS.has(defaultPath)) {
    throw new Error(`unsupported default path: ${defaultPath}`);
  }

  const { policyPath, policy } = loadGlobalPolicyForMutation();
  const [phase, field] = defaultPath.split(".");
  policy.defaults[phase] = {
    ...(policy.defaults[phase] || {}),
    [field]: value,
  };
  const updated = writePolicy(policyPath, policy);
  outputMutation({ jsonOut, action: "set-default", policyPath, policy: updated, defaultPath });
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

  const { policyPath, policy } = loadGlobalPolicyForMutation();
  policy[listName].push(entry);
  const updated = writePolicy(policyPath, policy);
  outputMutation({ jsonOut, action, policyPath, policy: updated, entry });
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
    case "check":
      commandCheck(positionals, jsonOut);
      break;
    case "set-default":
      commandSetDefault(positionals, jsonOut);
      break;
    case "allow-route":
      commandRouteMutation(positionals, jsonOut, {
        action: "allow-route",
        listName: "allowed_model_routes",
        requirePhase: true,
      });
      break;
    case "deny-route":
      commandRouteMutation(positionals, jsonOut, {
        action: "deny-route",
        listName: "denied_model_routes",
        requirePhase: false,
      });
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  if (hasCliFlag("--json")) {
    printJson({
      ok: false,
      error: error.message,
    });
  } else {
    console.error(`Error: ${error.message}`);
  }
  process.exit(1);
}
