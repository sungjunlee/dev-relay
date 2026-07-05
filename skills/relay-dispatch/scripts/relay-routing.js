"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveExecutorDefaultModel } = require("./executor-model-config");
const { getProjectRoutesPath } = require("./manifest/paths");
const { buildDefaultRelayPolicy, evaluateRelayRoute } = require("./relay-policy");

const GLOBAL_ROUTES_FILE = "routes.json";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pushUnique(target, values) {
  for (const value of values || []) {
    if (!target.includes(value)) target.push(value);
  }
  return target;
}

function normalizeTags(input) {
  const raw = [];
  if (Array.isArray(input)) {
    for (const item of input) raw.push(...normalizeTags(item));
  } else if (typeof input === "string") {
    const parts = input.includes(",") ? input.split(",") : [input];
    for (const part of parts) {
      const tag = part.trim().replace(/^['"]|['"]$/g, "").trim().toLowerCase();
      if (tag) raw.push(tag);
    }
  }
  return pushUnique([], raw);
}

function normalizePathForClassification(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function isDocsPath(filePath) {
  const normalized = normalizePathForClassification(filePath);
  if (!normalized) return false;
  const basename = normalized.split("/").pop();
  return /^README.*\.md$/i.test(basename)
    || normalized.startsWith("docs/")
    || /^skills\/[^/]+\/SKILL\.md$/i.test(normalized);
}

function isTestPath(filePath) {
  const normalized = normalizePathForClassification(filePath);
  if (!normalized) return false;
  return normalized.startsWith("tests/")
    || normalized.includes("/tests/")
    || normalized.includes("/__tests__/")
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function classifyChangedFiles(changedFiles = []) {
  const files = (changedFiles || []).map(normalizePathForClassification).filter(Boolean);
  const tags = [];
  if (!files.length) return tags;

  const docsCount = files.filter(isDocsPath).length;
  if (docsCount > 0) tags.push("docs");
  if (docsCount > 0 && docsCount === files.length) tags.push("docs-only");

  if (files.some(isTestPath)) {
    tags.push("tests", "test-gap");
  }
  return tags;
}

function tagsFromTaskProfile(profile) {
  if (!isPlainObject(profile)) return [];
  const tags = [];
  for (const field of ["tags", "labels", "domains", "risk_tags", "guidance_packs"]) {
    pushUnique(tags, normalizeTags(profile[field]));
  }
  return tags;
}

function tagsFromRubricObject(rubric) {
  if (!isPlainObject(rubric)) return [];
  const tags = [];
  pushUnique(tags, tagsFromTaskProfile(rubric));
  pushUnique(tags, tagsFromTaskProfile(rubric.task_profile));
  pushUnique(tags, tagsFromTaskProfile(rubric.taskProfile));
  pushUnique(tags, tagsFromTaskProfile(rubric.profile));
  pushUnique(tags, tagsFromTaskProfile(rubric.metadata));
  return tags;
}

function tagsFromCoverageText(text) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const tags = [];
  if (/\b(?:node --test|pytest|vitest|jest|coverage|test[-_\s]?gap|test_command|test-command)\b/i.test(raw)) {
    tags.push("test-gap");
  }
  if (/\b(?:docs?|readme|documentation)\b/i.test(raw)) {
    tags.push("docs");
  }
  return tags;
}

function parseTaskProfileFromText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  if (!raw.includes("task_profile:")) return null;
  const fenced = raw.match(/```(?:yaml|yml)?\s*\n([\s\S]*?^```)$/m);
  const body = fenced ? fenced[1].replace(/\n```$/, "") : raw;
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "task_profile:");
  if (start === -1) return null;

  const profile = {};
  let currentArrayKey = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^\S/.test(line)) break;

    const keyValue = /^ {2}([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (keyValue) {
      const key = keyValue[1];
      const value = keyValue[2] || "";
      currentArrayKey = null;
      if (/^\[.*\]$/.test(value.trim())) {
        profile[key] = normalizeTags(value.replace(/^\[/, "").replace(/\]$/, ""));
      } else if (value.trim()) {
        profile[key] = normalizeTags(value);
      } else {
        profile[key] = [];
        currentArrayKey = key;
      }
      continue;
    }

    const listItem = /^ {4}-\s*(.*)$/.exec(line);
    if (listItem && currentArrayKey) {
      profile[currentArrayKey].push(...normalizeTags(listItem[1]));
      profile[currentArrayKey] = normalizeTags(profile[currentArrayKey]);
    }
  }
  return profile;
}

function collectRoutingTagSources({
  cliTags = [],
  issueLabels = [],
  labels = [],
  taskProfile = null,
  promptText = null,
  rubric = null,
  rubricText = null,
  changedFiles = [],
  testCommands = [],
} = {}) {
  const parsedPromptProfile = parseTaskProfileFromText(promptText);
  const sourceTags = {
    cli: normalizeTags(cliTags),
    issue_labels: normalizeTags([...normalizeTags(issueLabels), ...normalizeTags(labels)]),
    task_profile: normalizeTags([
      ...tagsFromTaskProfile(taskProfile),
      ...tagsFromTaskProfile(parsedPromptProfile),
    ]),
    rubric: normalizeTags([
      ...tagsFromRubricObject(rubric),
      ...tagsFromCoverageText(rubricText),
    ]),
    changed_files: normalizeTags(classifyChangedFiles(changedFiles)),
    test_commands: normalizeTags(tagsFromCoverageText((testCommands || []).join("\n"))),
  };

  const inferred = [];
  for (const key of ["issue_labels", "task_profile", "rubric", "changed_files", "test_commands"]) {
    pushUnique(inferred, sourceTags[key]);
  }

  if (sourceTags.cli.length) {
    return {
      source_tags: sourceTags,
      effective_source: "cli",
      effective_tags: sourceTags.cli,
    };
  }

  return {
    source_tags: sourceTags,
    effective_source: inferred.length ? "inferred" : "none",
    effective_tags: inferred,
  };
}

function normalizeRuleName(rule, index) {
  return nonEmptyString(rule?.name) || `routing_rules[${index}]`;
}

function normalizeMatch(rule) {
  const match = isPlainObject(rule.match) ? rule.match : {};
  return {
    any_tags: normalizeTags(match.any_tags || match.tags || rule.tags || rule.match_tags),
    all_tags: normalizeTags(match.all_tags),
  };
}

function normalizeSelection(value, fieldName, index, warnings) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    warnings.push({
      code: "invalid_selection",
      field: fieldName,
      index,
      reason: "expected_object",
    });
    return null;
  }

  const normalized = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (fieldValue === null || fieldValue === undefined) continue;
    const text = nonEmptyString(fieldValue);
    if (!text) {
      warnings.push({
        code: "invalid_selection_field",
        field: `${fieldName}.${field}`,
        index,
        reason: "expected_non_empty_string",
      });
      continue;
    }
    normalized[field] = text;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function requirePhaseObject(value, fieldName, sourceLabel) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new Error(`invalid project routes at ${sourceLabel}: defaults.${fieldName} must be an object or null`);
  }
  return value;
}

function normalizeOptionalField(object, fieldName, sourceLabel, { required = false, label = fieldName } = {}) {
  if (object[fieldName] === undefined || object[fieldName] === null) {
    if (required) {
      throw new Error(`invalid project routes at ${sourceLabel}: ${label} must be a non-empty string`);
    }
    return undefined;
  }
  const value = nonEmptyString(object[fieldName]);
  if (!value) {
    throw new Error(`invalid project routes at ${sourceLabel}: ${label} must be a non-empty string`);
  }
  return value;
}

function normalizeRouteDefault(value, phase, sourceLabel, { partial = false } = {}) {
  const routeDefault = requirePhaseObject(value, phase, sourceLabel);
  if (routeDefault === null) return null;

  if (phase === "dispatch") {
    const normalized = {};
    if (routeDefault.executor !== undefined || !partial) {
      normalized.executor = normalizeOptionalField(routeDefault, "executor", sourceLabel, {
        required: !partial,
        label: "defaults.dispatch.executor",
      });
    }
    if (routeDefault.model !== undefined) {
      normalized.model = normalizeOptionalField(routeDefault, "model", sourceLabel, { label: "defaults.dispatch.model" });
    }
    return normalized;
  }
  if (phase === "review" || phase === "advisory_review") {
    const normalized = {};
    if (routeDefault.reviewer !== undefined || !partial) {
      normalized.reviewer = normalizeOptionalField(routeDefault, "reviewer", sourceLabel, {
        required: !partial,
        label: `defaults.${phase}.reviewer`,
      });
    }
    if (routeDefault.model !== undefined) normalized.model = normalizeOptionalField(routeDefault, "model", sourceLabel, { label: `defaults.${phase}.model` });
    if (phase === "advisory_review" && routeDefault.profile !== undefined) {
      normalized.profile = normalizeOptionalField(routeDefault, "profile", sourceLabel, { label: "defaults.advisory_review.profile" });
    }
    return normalized;
  }
  throw new Error(`unsupported route phase: ${phase}`);
}

function validateProjectRoutes(routes, sourceLabel = "project routes") {
  if (isPlainObject(routes) && routes.version === 2) {
    return validateRouteConfig(routes, sourceLabel, { project: true });
  }
  if (!isPlainObject(routes)) {
    throw new Error(`invalid project routes at ${sourceLabel}: expected object`);
  }
  if (routes.version !== 1) {
    throw new Error(`invalid project routes at ${sourceLabel}: version must be 1`);
  }
  if (routes.defaults !== undefined && !isPlainObject(routes.defaults)) {
    throw new Error(`invalid project routes at ${sourceLabel}: defaults must be an object`);
  }
  const defaults = routes.defaults || {};
  return {
    ...cloneJson(routes),
    version: 1,
    defaults: {
      ...(defaults.dispatch !== undefined ? { dispatch: normalizeRouteDefault(defaults.dispatch, "dispatch", sourceLabel) } : {}),
      ...(defaults.review !== undefined ? { review: normalizeRouteDefault(defaults.review, "review", sourceLabel) } : {}),
      ...(defaults.advisory_review !== undefined ? { advisory_review: normalizeRouteDefault(defaults.advisory_review, "advisory_review", sourceLabel) } : {}),
    },
  };
}

function assertNonEmptyStringArray(value, fieldName, sourceLabel) {
  if (!Array.isArray(value)) {
    throw new Error(`invalid routes config at ${sourceLabel}: ${fieldName} must be an array`);
  }
  return value.map((item, index) => {
    const normalized = nonEmptyString(item);
    if (!normalized) {
      throw new Error(`invalid routes config at ${sourceLabel}: ${fieldName}[${index}] must be a non-empty string`);
    }
    return normalized;
  });
}

function normalizeRouteEntry(entry, listName, index, sourceLabel) {
  if (typeof entry === "string") {
    const route = nonEmptyString(entry);
    if (!route) {
      throw new Error(`invalid routes config at ${sourceLabel}: ${listName}[${index}] must be a non-empty route string`);
    }
    return { route };
  }
  if (!isPlainObject(entry)) {
    throw new Error(`invalid routes config at ${sourceLabel}: ${listName}[${index}] must be a route string or object`);
  }
  const route = nonEmptyString(entry.route);
  if (!route) {
    throw new Error(`invalid routes config at ${sourceLabel}: ${listName}[${index}].route must be a non-empty string`);
  }
  const normalized = { route };
  for (const field of ["phases", "executors", "reviewers"]) {
    if (entry[field] !== undefined) {
      normalized[field] = assertNonEmptyStringArray(entry[field], `${listName}[${index}].${field}`, sourceLabel);
    }
  }
  return normalized;
}

function normalizeRouteEntries(value, listName, sourceLabel) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`invalid routes config at ${sourceLabel}: ${listName} must be an array`);
  }
  return value.map((entry, index) => normalizeRouteEntry(entry, listName, index, sourceLabel));
}

function normalizeRoutesDefaults(defaults, sourceLabel, { project = false } = {}) {
  if (defaults === undefined) return {};
  if (!isPlainObject(defaults)) {
    throw new Error(`invalid routes config at ${sourceLabel}: defaults must be an object`);
  }
  return {
    ...(defaults.dispatch !== undefined ? { dispatch: normalizeRouteDefault(defaults.dispatch, "dispatch", sourceLabel, { partial: project }) } : {}),
    ...(defaults.review !== undefined ? { review: normalizeRouteDefault(defaults.review, "review", sourceLabel, { partial: project }) } : {}),
    ...(defaults.advisory_review !== undefined ? { advisory_review: normalizeRouteDefault(defaults.advisory_review, "advisory_review", sourceLabel, { partial: project }) } : {}),
  };
}

function normalizeExecutorDefaults(value, sourceLabel) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`invalid routes config at ${sourceLabel}: executor_defaults must be an object`);
  }
  const normalized = {};
  for (const [executor, config] of Object.entries(value)) {
    const executorName = nonEmptyString(executor);
    if (!executorName) {
      throw new Error(`invalid routes config at ${sourceLabel}: executor_defaults keys must be non-empty strings`);
    }
    if (!isPlainObject(config)) {
      throw new Error(`invalid routes config at ${sourceLabel}: executor_defaults.${executorName} must be an object`);
    }
    const model = normalizeOptionalField(config, "model", sourceLabel, { label: `executor_defaults.${executorName}.model` });
    normalized[executorName] = model === undefined ? {} : { model };
  }
  return normalized;
}

function normalizePresets(value, sourceLabel) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`invalid routes config at ${sourceLabel}: presets must be an object`);
  }
  for (const [name, preset] of Object.entries(value)) {
    if (!isPlainObject(preset)) {
      throw new Error(`invalid routes config at ${sourceLabel}: presets.${name} must be an object`);
    }
  }
  return cloneJson(value);
}

function validateRouteConfig(routes, sourceLabel = "routes config", { project = false } = {}) {
  if (!isPlainObject(routes)) {
    throw new Error(`invalid routes config at ${sourceLabel}: expected object`);
  }
  if (routes.version !== 2) {
    throw new Error(`invalid routes config at ${sourceLabel}: version must be 2`);
  }
  if (routes.strict !== undefined && typeof routes.strict !== "boolean") {
    throw new Error(`invalid routes config at ${sourceLabel}: strict must be a boolean`);
  }
  const normalized = {
    ...cloneJson(routes),
    version: 2,
    defaults: normalizeRoutesDefaults(routes.defaults, sourceLabel, { project }),
    executor_defaults: normalizeExecutorDefaults(routes.executor_defaults, sourceLabel),
    routes: normalizeRouteEntries(routes.routes, "routes", sourceLabel),
    denied_routes: normalizeRouteEntries(routes.denied_routes, "denied_routes", sourceLabel),
    presets: normalizePresets(routes.presets, sourceLabel),
  };
  // Preserve omission: a scope that does not set strict must not override
  // another scope's strict at merge time (mergeRouteConfigs keys off
  // hasOwnProperty, so materializing a default false here would defeat it).
  if (routes.strict === undefined) {
    delete normalized.strict;
  } else {
    normalized.strict = routes.strict === true;
  }
  return normalized;
}

function mergePhaseDefaults(base = {}, override = {}) {
  if (override === null) return null;
  if (base === null) return override === undefined ? null : cloneJson(override);
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  };
}

function mergeDefaults(base = {}, override = {}) {
  const merged = { ...(base || {}) };
  for (const phase of ["dispatch", "review", "advisory_review"]) {
    if (Object.prototype.hasOwnProperty.call(override || {}, phase)) {
      merged[phase] = mergePhaseDefaults(merged[phase], override[phase]);
    }
  }
  return merged;
}

function mergeExecutorDefaults(base = {}, override = {}) {
  const merged = cloneJson(base || {});
  for (const [executor, config] of Object.entries(override || {})) {
    merged[executor] = {
      ...(merged[executor] || {}),
      ...config,
    };
  }
  return merged;
}

function mergeRouteConfigs(base, override) {
  if (!override) return cloneJson(base);
  return {
    ...cloneJson(base),
    ...cloneJson(override),
    version: 2,
    strict: Object.prototype.hasOwnProperty.call(override, "strict") ? override.strict === true : base.strict === true,
    defaults: mergeDefaults(base.defaults, override.defaults),
    executor_defaults: mergeExecutorDefaults(base.executor_defaults, override.executor_defaults),
    routes: [...(base.routes || []), ...(override.routes || [])],
    denied_routes: [...(base.denied_routes || []), ...(override.denied_routes || [])],
    presets: {
      ...(base.presets || {}),
      ...(override.presets || {}),
    },
  };
}

function resolveGlobalRoutesPath({ relayHome } = {}) {
  const home = relayHome || process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  return path.join(home, GLOBAL_ROUTES_FILE);
}

function loadRouteConfig({ repoRoot, relayHome, globalPath, projectPath, globalRoutes, projectRoutes } = {}) {
  const resolvedGlobalPath = globalPath || resolveGlobalRoutesPath({ relayHome });
  let resolvedProjectPath = projectPath || null;
  if (!resolvedProjectPath && repoRoot) {
    try {
      resolvedProjectPath = getProjectRoutesPath(repoRoot, { relayHome });
    } catch {
      resolvedProjectPath = null;
    }
  }
  const sources = {
    global: resolvedGlobalPath,
    project: resolvedProjectPath,
  };

  let globalConfig = null;
  try {
    if (globalRoutes !== undefined) {
      globalConfig = validateRouteConfig(globalRoutes, "injected global routes");
    } else if (resolvedGlobalPath && fs.existsSync(resolvedGlobalPath)) {
      globalConfig = validateRouteConfig(readProjectRoutesFile(resolvedGlobalPath), resolvedGlobalPath);
    }
  } catch (error) {
    return { ok: false, status: "error", config: null, errors: [{ source: resolvedGlobalPath, message: error.message }], sources };
  }

  // DC #781 A1 §3: without the global routes file the routes-config world is
  // entirely inert — do not even parse the project file, so legacy
  // policy.json/executors.json loading can never be broken by its contents.
  if (!globalConfig) {
    return { ok: true, status: "absent", config: null, errors: [], sources };
  }

  let effectiveConfig = globalConfig;
  try {
    let projectConfig = null;
    let projectConfigVersion = null;
    if (projectRoutes !== undefined) {
      projectConfigVersion = projectRoutes?.version;
      if (projectConfigVersion === 2) {
        projectConfig = validateRouteConfig(projectRoutes, "injected project routes", { project: true });
      } else if (projectConfigVersion === 1) {
        if (globalConfig) {
          projectConfig = {
            version: 2,
            // v1 has no strict concept; omit the key so it cannot override global strict at merge.
            defaults: validateProjectRoutes(projectRoutes, "injected project routes").defaults,
            executor_defaults: {},
            routes: [],
            denied_routes: [],
            presets: {},
          };
        }
      } else {
        projectConfig = validateRouteConfig(projectRoutes, "injected project routes", { project: true });
      }
    } else if (resolvedProjectPath && fs.existsSync(resolvedProjectPath)) {
      const parsed = readProjectRoutesFile(resolvedProjectPath);
      projectConfigVersion = parsed?.version;
      if (parsed?.version === 2) {
        projectConfig = validateRouteConfig(parsed, resolvedProjectPath, { project: true });
      } else if (parsed?.version === 1) {
        if (globalConfig) {
          projectConfig = {
            version: 2,
            // v1 has no strict concept; omit the key so it cannot override global strict at merge.
            defaults: validateProjectRoutes(parsed, resolvedProjectPath).defaults,
            executor_defaults: {},
            routes: [],
            denied_routes: [],
            presets: {},
          };
        }
      } else {
        projectConfig = validateRouteConfig(parsed, resolvedProjectPath, { project: true });
      }
    }
    // DC #781 A1 §3: routes config becomes the source of truth only when the
    // GLOBAL routes.json exists. A project-only routes file must not bypass
    // legacy policy.json/executors.json precedence.
    if (globalConfig && projectConfig) {
      effectiveConfig = mergeRouteConfigs(globalConfig, projectConfig);
    }
  } catch (error) {
    return { ok: false, status: "error", config: null, errors: [{ source: resolvedProjectPath, message: error.message }], sources };
  }

  if (!effectiveConfig) {
    return { ok: true, status: "absent", config: null, errors: [], sources };
  }

  return {
    ok: true,
    status: "ok",
    config: effectiveConfig,
    errors: [],
    sources,
  };
}

function readProjectRoutesFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`failed to read project routes at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse project routes at ${filePath}: ${error.message}`);
  }
}

function loadProjectRoutes({ repoRoot, relayHome } = {}) {
  let filePath;
  try {
    filePath = getProjectRoutesPath(repoRoot, { relayHome });
  } catch (error) {
    return { ok: false, status: "error", path: null, routes: null, error: error.message };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: true, status: "absent", path: filePath, routes: null, error: null };
  }
  try {
    return {
      ok: true,
      status: "ok",
      path: filePath,
      routes: validateProjectRoutes(readProjectRoutesFile(filePath), filePath),
      error: null,
    };
  } catch (error) {
    return { ok: false, status: "error", path: filePath, routes: null, error: error.message };
  }
}

const ROUTE_PHASES = ["dispatch", "review", "advisory_review"];

function actorFieldForPhase(phase) {
  return phase === "review" || phase === "advisory_review" ? "reviewer" : "executor";
}

function defaultForPhase(policy, phase) {
  const policyDefault = policy?.defaults?.[phase];
  if (policyDefault !== undefined) return cloneJson(policyDefault);
  return cloneJson(buildDefaultRelayPolicy().defaults[phase]);
}

function pickField({ phase, field, runIntent, projectRoutes, policy }) {
  const runPhase = runIntent?.[phase];
  if (isPlainObject(runPhase) && Object.prototype.hasOwnProperty.call(runPhase, field)) {
    return { value: nonEmptyString(runPhase[field]), source: "run_intent" };
  }
  const projectPhase = projectRoutes?.defaults?.[phase];
  if (isPlainObject(projectPhase) && Object.prototype.hasOwnProperty.call(projectPhase, field)) {
    return { value: nonEmptyString(projectPhase[field]), source: "project_routes" };
  }
  const policyDefault = defaultForPhase(policy, phase);
  if (isPlainObject(policyDefault) && Object.prototype.hasOwnProperty.call(policyDefault, field)) {
    return { value: nonEmptyString(policyDefault[field]), source: "policy_defaults" };
  }
  return { value: null, source: "unresolved" };
}

function resolveModelForActor({ phase, actor, runIntent, projectRoutes, policy, relayHome, repoRoot, executorModelResolver }) {
  const explicit = pickField({ phase, field: "model", runIntent, projectRoutes, policy });
  if (explicit.source !== "unresolved") return explicit;
  if (actor) {
    const routeConfigDefault = nonEmptyString(policy?.executor_defaults?.[actor]?.model);
    if (routeConfigDefault) return { value: routeConfigDefault, source: "executor_defaults" };
    const resolver = executorModelResolver || resolveExecutorDefaultModel;
    const model = resolver(actor, { relayHome, repoRoot });
    if (model) return { value: model, source: "executor_defaults" };
  }
  return { value: null, source: "unresolved" };
}

function resolvePhaseRoute({ phase, runIntent, projectRoutes, policy, relayHome, repoRoot, executorModelResolver }) {
  const actorField = actorFieldForPhase(phase);
  const selected = pickField({ phase, field: actorField, runIntent, projectRoutes, policy });
  if (!selected.value && phase === "advisory_review") {
    return null;
  }

  const model = resolveModelForActor({
    phase,
    actor: selected.value,
    runIntent,
    projectRoutes,
    policy,
    relayHome,
    repoRoot,
    executorModelResolver,
  });
  const resolved = {
    phase,
    [actorField]: selected.value,
    model: model.value,
    source: selected.source,
    sources: {
      [actorField]: selected.source,
      model: model.source,
    },
  };

  if (phase === "advisory_review") {
    const profile = pickField({ phase, field: "profile", runIntent, projectRoutes, policy });
    if (profile.value) {
      resolved.profile = profile.value;
      resolved.sources.profile = profile.source;
    }
  }

  const policyTuple = actorField === "reviewer"
    ? { phase, reviewer: selected.value, model: model.value }
    : { phase, executor: selected.value, model: model.value };
  resolved.policy_decision = evaluateRelayRoute(policy, policyTuple);
  return resolved;
}

function resolveRouteIntent({
  runIntent = null,
  projectRoutes = null,
  policy = buildDefaultRelayPolicy(),
  relayHome = process.env.RELAY_HOME,
  repoRoot = null,
  executorModelResolver = null,
} = {}) {
  const normalizedProjectRoutes = projectRoutes ? validateProjectRoutes(projectRoutes, "project routes") : null;
  const phases = {};
  for (const phase of ROUTE_PHASES) {
    phases[phase] = resolvePhaseRoute({
      phase,
      runIntent,
      projectRoutes: normalizedProjectRoutes,
      policy,
      relayHome,
      repoRoot,
      executorModelResolver,
    });
  }
  return {
    version: 1,
    phases,
  };
}

function validateRoutingRules(routingRules = []) {
  const warnings = [];
  const normalizedRules = [];
  const firstNameIndex = new Map();

  if (!Array.isArray(routingRules)) {
    return {
      rules: [],
      warnings: [{ code: "invalid_routing_rules", reason: "expected_array" }],
    };
  }

  routingRules.forEach((rule, index) => {
    if (!isPlainObject(rule)) {
      warnings.push({ code: "invalid_rule", index, reason: "expected_object" });
      return;
    }

    const name = normalizeRuleName(rule, index);
    if (firstNameIndex.has(name)) {
      warnings.push({
        code: "duplicate_rule_name",
        name,
        first_index: firstNameIndex.get(name),
        duplicate_index: index,
      });
    } else {
      firstNameIndex.set(name, index);
    }

    const match = normalizeMatch(rule);
    if (!match.any_tags.length && !match.all_tags.length) {
      warnings.push({ code: "rule_without_tag_match", name, index });
    }

    const defaults = isPlainObject(rule.defaults) ? rule.defaults : {};
    normalizedRules.push({
      name,
      index,
      match,
      advisory_review: normalizeSelection(rule.advisory_review ?? defaults.advisory_review, "advisory_review", index, warnings),
      ignored_primary_review: normalizeSelection(rule.review ?? defaults.review, "review", index, warnings),
    });
  });

  return { rules: normalizedRules, warnings };
}

function ruleMatches(rule, effectiveTags) {
  const tagSet = new Set(effectiveTags || []);
  if (rule.match.all_tags.length && !rule.match.all_tags.every((tag) => tagSet.has(tag))) {
    return false;
  }
  if (rule.match.any_tags.length) {
    return rule.match.any_tags.some((tag) => tagSet.has(tag));
  }
  return rule.match.all_tags.length > 0;
}

function resolveRoutingDecision({
  policy = {},
  cliTags = [],
  issueLabels = [],
  labels = [],
  taskProfile = null,
  promptText = null,
  rubric = null,
  rubricText = null,
  changedFiles = [],
  testCommands = [],
} = {}) {
  const tagSources = collectRoutingTagSources({
    cliTags,
    issueLabels,
    labels,
    taskProfile,
    promptText,
    rubric,
    rubricText,
    changedFiles,
    testCommands,
  });
  const { rules, warnings } = validateRoutingRules(policy?.routing_rules || []);
  const matchedRule = rules.find((rule) => ruleMatches(rule, tagSources.effective_tags)) || null;

  const base = {
    version: 1,
    source_tags: tagSources.source_tags,
    effective_source: tagSources.effective_source,
    effective_tags: tagSources.effective_tags,
    warnings,
    selected: {
      advisory_review: null,
    },
    ignored_primary_review: null,
  };

  if (!matchedRule) {
    return {
      ...base,
      matched: false,
      matched_rule: null,
      no_match_reason: "no_routing_rule_matched",
    };
  }

  return {
    ...base,
    matched: true,
    matched_rule: {
      name: matchedRule.name,
      index: matchedRule.index,
      match: cloneJson(matchedRule.match),
    },
    selected: {
      advisory_review: cloneJson(matchedRule.advisory_review) || null,
    },
    ignored_primary_review: cloneJson(matchedRule.ignored_primary_review) || null,
    no_match_reason: null,
  };
}

module.exports = {
  classifyChangedFiles,
  collectRoutingTagSources,
  loadRouteConfig,
  loadProjectRoutes,
  normalizeTags,
  resolveRouteIntent,
  resolveRoutingDecision,
  resolveGlobalRoutesPath,
  validateRouteConfig,
  validateProjectRoutes,
  validateRoutingRules,
};
