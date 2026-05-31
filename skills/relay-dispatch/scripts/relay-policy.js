const fs = require("fs");
const os = require("os");
const path = require("path");
const { getProjectPolicyPath, looksLikeGitRepo } = require("./manifest/paths");

const DEFAULT_POLICY_FILE = "policy.json";
const REPO_POLICY_FILE = path.join(".relay", "policy.json");
const MANAGED_MODELLESS_CLI = new Set(["codex", "claude", "cursor"]);

class RelayPolicyError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "RelayPolicyError";
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function policyError(sourceLabel, error, fallbackReason = "invalid_policy") {
  const reason = error instanceof RelayPolicyError ? error.reason : fallbackReason;
  return {
    reason,
    source: sourceLabel,
    message: error.message,
  };
}

function buildDefaultRelayPolicy() {
  return {
    version: 1,
    profile: "managed-cli-default",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
      sidecar: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  };
}

function resolveRelayPolicyPath({ relayHome } = {}) {
  if (nonEmptyString(process.env.RELAY_POLICY_PATH)) {
    return process.env.RELAY_POLICY_PATH.trim();
  }
  const home = relayHome || process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  return path.join(home, DEFAULT_POLICY_FILE);
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new RelayPolicyError("invalid_policy", `failed to read relay policy at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RelayPolicyError("invalid_policy", `failed to parse relay policy at ${filePath}: ${error.message}`);
  }
}

function assertNonEmptyStringArray(value, fieldName, sourceLabel) {
  if (!Array.isArray(value)) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: ${fieldName} must be an array`);
  }
  return value.map((item, index) => {
    const normalized = nonEmptyString(item);
    if (!normalized) {
      throw new RelayPolicyError(
        "invalid_policy",
        `invalid relay policy at ${sourceLabel}: ${fieldName}[${index}] must be a non-empty string`
      );
    }
    return normalized;
  });
}

function normalizeDefaults(defaults, sourceLabel) {
  if (!isPlainObject(defaults)) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: defaults must be an object`);
  }

  const required = ["dispatch", "review", "advisory_review", "sidecar"];
  const normalized = { ...defaults };
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: defaults.${key} is required`);
    }
    const value = defaults[key];
    if (value !== null && !isPlainObject(value)) {
      throw new RelayPolicyError(
        "invalid_policy",
        `invalid relay policy at ${sourceLabel}: defaults.${key} must be an object or null`
      );
    }
    if (isPlainObject(value)) {
      normalized[key] = cloneJson(value);
      for (const [field, fieldValue] of Object.entries(value)) {
        if (fieldValue !== null && fieldValue !== undefined && !nonEmptyString(fieldValue)) {
          throw new RelayPolicyError(
            "invalid_policy",
            `invalid relay policy at ${sourceLabel}: defaults.${key}.${field} must be a non-empty string when set`
          );
        }
      }
    }
  }
  return normalized;
}

function normalizeRouteEntry(entry, listName, index, sourceLabel) {
  if (typeof entry === "string") {
    const route = nonEmptyString(entry);
    if (!route) {
      throw new RelayPolicyError(
        "invalid_policy",
        `invalid relay policy at ${sourceLabel}: ${listName}[${index}] must be a non-empty route string`
      );
    }
    return { route };
  }

  if (!isPlainObject(entry)) {
    throw new RelayPolicyError(
      "invalid_policy",
      `invalid relay policy at ${sourceLabel}: ${listName}[${index}] must be a route string or object`
    );
  }

  const route = nonEmptyString(entry.route);
  if (!route) {
    throw new RelayPolicyError(
      "invalid_policy",
      `invalid relay policy at ${sourceLabel}: ${listName}[${index}].route must be a non-empty string`
    );
  }

  const normalized = {
    route,
  };
  for (const field of ["phases", "executors", "reviewers"]) {
    if (entry[field] !== undefined) {
      normalized[field] = assertNonEmptyStringArray(entry[field], `${listName}[${index}].${field}`, sourceLabel);
    }
  }
  return normalized;
}

function normalizeRouteList(value, listName, sourceLabel) {
  if (!Array.isArray(value)) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: ${listName} must be an array`);
  }
  return value.map((entry, index) => normalizeRouteEntry(entry, listName, index, sourceLabel));
}

function normalizeRoutingRules(value, sourceLabel) {
  if (!Array.isArray(value)) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: routing_rules must be an array`);
  }
  return value.map((rule, index) => {
    if (!isPlainObject(rule)) {
      throw new RelayPolicyError(
        "invalid_policy",
        `invalid relay policy at ${sourceLabel}: routing_rules[${index}] must be an object`
      );
    }
    return cloneJson(rule);
  });
}

function validateRelayPolicy(policy, sourceLabel = "relay policy") {
  if (!isPlainObject(policy)) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: expected object`);
  }
  if (policy.version !== 1) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: version must be 1`);
  }

  const profile = nonEmptyString(policy.profile);
  if (!profile) {
    throw new RelayPolicyError("invalid_policy", `invalid relay policy at ${sourceLabel}: profile must be a non-empty string`);
  }

  if (typeof policy.deny_unknown_model_routes !== "boolean") {
    throw new RelayPolicyError(
      "invalid_policy",
      `invalid relay policy at ${sourceLabel}: deny_unknown_model_routes must be a boolean`
    );
  }

  return {
    ...cloneJson(policy),
    version: 1,
    profile,
    defaults: normalizeDefaults(policy.defaults, sourceLabel),
    managed_cli: assertNonEmptyStringArray(policy.managed_cli, "managed_cli", sourceLabel),
    allowed_model_routes: normalizeRouteList(policy.allowed_model_routes, "allowed_model_routes", sourceLabel),
    denied_model_routes: normalizeRouteList(policy.denied_model_routes, "denied_model_routes", sourceLabel),
    routing_rules: normalizeRoutingRules(policy.routing_rules, sourceLabel),
    deny_unknown_model_routes: policy.deny_unknown_model_routes,
  };
}

function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function matchRoutePattern(pattern, route) {
  const normalizedPattern = nonEmptyString(pattern);
  const normalizedRoute = nonEmptyString(route);
  if (!normalizedPattern || !normalizedRoute) return false;

  const source = normalizedPattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(normalizedRoute);
}

function patternCovers(basePattern, candidatePattern) {
  if (basePattern === candidatePattern) return true;
  if (basePattern === "*") return true;
  if (!candidatePattern.includes("*")) return matchRoutePattern(basePattern, candidatePattern);
  if (!basePattern.includes("*")) return false;

  const baseFirstStar = basePattern.indexOf("*");
  const baseLastStar = basePattern.lastIndexOf("*");
  const candidateFirstStar = candidatePattern.indexOf("*");
  const candidateLastStar = candidatePattern.lastIndexOf("*");
  const basePrefix = basePattern.slice(0, baseFirstStar);
  const baseSuffix = basePattern.slice(baseLastStar + 1);
  const candidatePrefix = candidatePattern.slice(0, candidateFirstStar);
  const candidateSuffix = candidatePattern.slice(candidateLastStar + 1);

  return candidatePrefix.startsWith(basePrefix) && candidateSuffix.endsWith(baseSuffix);
}

function arrayScopeCovers(baseValues, candidateValues) {
  if (baseValues === undefined) return true;
  if (candidateValues === undefined) return false;
  const base = new Set(baseValues);
  return candidateValues.every((value) => base.has(value));
}

function actorScopeCovers(baseEntry, candidateEntry) {
  const baseHasActorScope = baseEntry.executors !== undefined || baseEntry.reviewers !== undefined;
  if (!baseHasActorScope) return true;

  const phases = candidateEntry.phases;
  const mayUseExecutors = phases === undefined || phases.includes("dispatch") || phases.includes("sidecar");
  const mayUseReviewers = phases === undefined || phases.includes("review") || phases.includes("advisory_review");

  if ((mayUseExecutors || candidateEntry.executors !== undefined) && !arrayScopeCovers(baseEntry.executors, candidateEntry.executors)) {
    return false;
  }
  if ((mayUseReviewers || candidateEntry.reviewers !== undefined) && !arrayScopeCovers(baseEntry.reviewers, candidateEntry.reviewers)) {
    return false;
  }
  return true;
}

function routeEntryCovers(baseEntry, candidateEntry) {
  return (
    patternCovers(baseEntry.route, candidateEntry.route) &&
    arrayScopeCovers(baseEntry.phases, candidateEntry.phases) &&
    actorScopeCovers(baseEntry, candidateEntry)
  );
}

function ensurePolicyNarrows(base, override, {
  reason = "repo_policy_widens_global_policy",
  subject = "repo relay policy",
  baseName = "global policy",
} = {}) {
  const baseManaged = new Set(base.managed_cli);
  for (const actor of override.managed_cli) {
    if (!baseManaged.has(actor)) {
      throw new RelayPolicyError(
        reason,
        `${subject} widens ${baseName}: managed_cli adds ${actor}`
      );
    }
  }

  if (base.deny_unknown_model_routes && !override.deny_unknown_model_routes) {
    throw new RelayPolicyError(
      reason,
      `${subject} widens ${baseName}: deny_unknown_model_routes cannot change from true to false`
    );
  }

  for (const candidate of override.allowed_model_routes) {
    if (!base.allowed_model_routes.some((entry) => routeEntryCovers(entry, candidate))) {
      throw new RelayPolicyError(
        reason,
        `${subject} widens ${baseName}: allowed_model_routes adds or widens ${candidate.route}`
      );
    }
  }

  for (const requiredDeny of base.denied_model_routes) {
    if (!override.denied_model_routes.some((entry) => routeEntryCovers(entry, requiredDeny))) {
      throw new RelayPolicyError(
        reason,
        `${subject} widens ${baseName}: denied_model_routes removes ${requiredDeny.route}`
      );
    }
  }
}

function ensureRepoPolicyNarrows(base, override) {
  ensurePolicyNarrows(base, override, {
    reason: "repo_policy_widens_global_policy",
    subject: "repo relay policy",
    baseName: "global policy",
  });
}

function mergeRelayPolicies(base, override, {
  baseLabel = "global policy",
  overrideLabel = "repo policy",
  wideningReason = "repo_policy_widens_global_policy",
  wideningSubject = "repo relay policy",
  wideningBaseName = "global policy",
} = {}) {
  const normalizedBase = validateRelayPolicy(base, baseLabel);
  const normalizedOverride = validateRelayPolicy(override, overrideLabel);
  ensurePolicyNarrows(normalizedBase, normalizedOverride, {
    reason: wideningReason,
    subject: wideningSubject,
    baseName: wideningBaseName,
  });
  return normalizedOverride;
}

function resolveRepoPolicyPath(repoRoot) {
  return repoRoot ? path.join(repoRoot, REPO_POLICY_FILE) : null;
}

function resolveProjectPolicyPath(repoRoot, relayHome) {
  if (!repoRoot || !looksLikeGitRepo(repoRoot)) return null;
  try {
    return getProjectPolicyPath(repoRoot, { relayHome });
  } catch {
    return null;
  }
}

function loadRelayPolicy(options = {}) {
  const globalPath = options.globalPath || resolveRelayPolicyPath({ relayHome: options.relayHome });
  const repoPath = options.repoPolicyPath || resolveRepoPolicyPath(options.repoRoot);
  const projectPath = options.projectPolicyPath || resolveProjectPolicyPath(options.repoRoot, options.relayHome);
  const sources = {
    global: globalPath,
    repo: repoPath,
    project: projectPath,
  };

  let policy;
  let status = "defaulted";
  try {
    if (options.globalPolicy !== undefined) {
      policy = validateRelayPolicy(options.globalPolicy, options.globalSourceLabel || "injected global policy");
      status = "ok";
    } else if (globalPath && fs.existsSync(globalPath)) {
      policy = validateRelayPolicy(readJsonFile(globalPath), globalPath);
      status = "ok";
    } else {
      policy = buildDefaultRelayPolicy();
    }
  } catch (error) {
    return {
      ok: false,
      status: "error",
      policy: null,
      errors: [policyError(globalPath, error)],
      sources,
    };
  }

  try {
    let repoPolicy = null;
    if (options.repoPolicy !== undefined) {
      repoPolicy = options.repoPolicy;
    } else if (repoPath && fs.existsSync(repoPath)) {
      repoPolicy = readJsonFile(repoPath);
    }

    if (repoPolicy !== null) {
      policy = mergeRelayPolicies(policy, repoPolicy, {
        baseLabel: options.globalSourceLabel || globalPath,
        overrideLabel: options.repoSourceLabel || repoPath || "injected repo policy",
      });
      status = "ok";
    }
  } catch (error) {
    return {
      ok: false,
      status: "error",
      policy: null,
      errors: [policyError(repoPath || "injected repo policy", error)],
      sources,
    };
  }

  try {
    let projectPolicy = null;
    if (options.projectPolicy !== undefined) {
      projectPolicy = options.projectPolicy;
    } else if (projectPath && fs.existsSync(projectPath)) {
      projectPolicy = readJsonFile(projectPath);
    }

    if (projectPolicy !== null) {
      policy = mergeRelayPolicies(policy, projectPolicy, {
        baseLabel: "effective policy before project policy",
        overrideLabel: options.projectSourceLabel || projectPath || "injected project policy",
        wideningReason: "project_policy_widens_effective_policy",
        wideningSubject: "project relay policy",
        wideningBaseName: "effective policy",
      });
      status = "ok";
    }
  } catch (error) {
    return {
      ok: false,
      status: "error",
      policy: null,
      errors: [policyError(projectPath || "injected project policy", error)],
      sources,
    };
  }

  return {
    ok: true,
    status,
    policy: validateRelayPolicy(policy, status === "defaulted" ? "default relay policy" : "effective relay policy"),
    errors: [],
    sources,
  };
}

function resolveActor({ phase, executor, reviewer, executorOrReviewer }) {
  if (executorOrReviewer) return nonEmptyString(executorOrReviewer);
  if (executor && reviewer) {
    return phase === "review" || phase === "advisory_review" ? nonEmptyString(reviewer) : nonEmptyString(executor);
  }
  return nonEmptyString(executor) || nonEmptyString(reviewer);
}

function isManagedModelessActor(policy, actor) {
  return MANAGED_MODELLESS_CLI.has(actor) && policy.managed_cli.includes(actor);
}

function hasProviderModelRoute(model) {
  const normalized = nonEmptyString(model);
  if (!normalized) return false;
  const parts = normalized.split("/");
  return parts.length >= 2 && Boolean(parts[0].trim()) && Boolean(parts.slice(1).join("/").trim());
}

function routeEntryApplies(entry, { phase, executor, reviewer, actor, model }) {
  if (!matchRoutePattern(entry.route, model)) return false;
  if (entry.phases !== undefined && !entry.phases.includes(phase)) return false;

  const hasActorScope = entry.executors !== undefined || entry.reviewers !== undefined;
  if (!hasActorScope) return true;
  if (phase === "review" || phase === "advisory_review") {
    return Boolean(entry.reviewers?.includes(reviewer || actor));
  }
  if (phase === "dispatch" || phase === "sidecar") {
    return Boolean(entry.executors?.includes(executor || actor));
  }
  return Boolean(entry.executors?.includes(actor) || entry.reviewers?.includes(actor));
}

function decision({ allowed, reason, phase, actor, model, matchedRoute = null }) {
  return {
    allowed,
    reason,
    phase,
    actor,
    model: model || null,
    matchedRoute,
  };
}

function unwrapPolicy(policyOrLoadResult) {
  if (policyOrLoadResult && policyOrLoadResult.ok === false) {
    throw new RelayPolicyError(
      policyOrLoadResult.errors?.[0]?.reason || "invalid_policy",
      policyOrLoadResult.errors?.[0]?.message || "relay policy failed to load"
    );
  }
  if (policyOrLoadResult && policyOrLoadResult.policy && policyOrLoadResult.ok === true) {
    return policyOrLoadResult.policy;
  }
  return policyOrLoadResult;
}

function evaluateRelayRoute(policyOrLoadResult, routeTuple) {
  const phase = nonEmptyString(routeTuple?.phase);
  const actor = resolveActor(routeTuple || {});
  const model = nonEmptyString(routeTuple?.model);
  let policy;

  try {
    policy = validateRelayPolicy(unwrapPolicy(policyOrLoadResult), "effective relay policy");
  } catch (error) {
    return decision({
      allowed: false,
      reason: error instanceof RelayPolicyError ? error.reason : "invalid_policy",
      phase,
      actor,
      model,
    });
  }

  if (!phase || !actor) {
    return decision({ allowed: false, reason: "invalid_route_tuple", phase, actor, model });
  }

  if (!model && isManagedModelessActor(policy, actor)) {
    return decision({ allowed: true, reason: "managed_cli", phase, actor, model: null });
  }

  const scopedTuple = {
    phase,
    executor: nonEmptyString(routeTuple.executor),
    reviewer: nonEmptyString(routeTuple.reviewer),
    actor,
    model,
  };

  const denied = policy.denied_model_routes.find((entry) => routeEntryApplies(entry, scopedTuple));
  if (denied) {
    return decision({ allowed: false, reason: "denied_model_route", phase, actor, model, matchedRoute: denied.route });
  }

  if (policy.deny_unknown_model_routes && !isManagedModelessActor(policy, actor) && !hasProviderModelRoute(model)) {
    return decision({ allowed: false, reason: "missing_model_route", phase, actor, model });
  }

  const allowed = policy.allowed_model_routes.find((entry) => routeEntryApplies(entry, scopedTuple));
  if (allowed) {
    return decision({ allowed: true, reason: "allowed_model_route", phase, actor, model, matchedRoute: allowed.route });
  }

  if (!policy.deny_unknown_model_routes) {
    return decision({ allowed: true, reason: "unknown_allowed", phase, actor, model });
  }

  return decision({ allowed: false, reason: "unknown_model_route", phase, actor, model });
}

module.exports = {
  RelayPolicyError,
  buildDefaultRelayPolicy,
  evaluateRelayRoute,
  loadRelayPolicy,
  matchRoutePattern,
  mergeRelayPolicies,
  resolveRelayPolicyPath,
  validateRelayPolicy,
};
