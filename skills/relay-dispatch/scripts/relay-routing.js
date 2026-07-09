"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveExecutorDefaultModel } = require("./executor-model-config");
const { getProjectRoutesPath } = require("./manifest/paths");
const { buildDefaultRelayPolicy, evaluateRelayRoute } = require("./relay-policy");

const GLOBAL_ROUTES_FILE = "routes.json";
const ROUTE_INTENT_SOURCES_KEY = "__route_sources";

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

function normalizeAdvisorySelection(value, fieldName, index, warnings) {
  if (value === undefined || value === null) return null;
  try {
    return normalizeAdvisoryLaneList(value, fieldName, `routing_rules[${index}]`);
  } catch (error) {
    warnings.push({
      code: "invalid_selection",
      field: fieldName,
      index,
      reason: error.message,
    });
    return null;
  }
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

const ADVISORY_TRIGGERS = new Set(["every_round", "on_pass"]);
const ADVISORY_PROFILE_DEFAULTS = Object.freeze({
  blindspot: Object.freeze({ trigger: "every_round", gating: false }),
  adversarial: Object.freeze({ trigger: "on_pass", gating: true }),
});

function advisoryProfileDefaults(profile) {
  return ADVISORY_PROFILE_DEFAULTS[profile] || ADVISORY_PROFILE_DEFAULTS.blindspot;
}

function normalizeBoolean(value, fieldName, sourceLabel, { fallback = false } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`invalid project routes at ${sourceLabel}: ${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeAdvisoryTrigger(value, fieldName, sourceLabel, profile) {
  const trigger = nonEmptyString(value) || advisoryProfileDefaults(profile).trigger;
  if (!ADVISORY_TRIGGERS.has(trigger)) {
    throw new Error(`invalid project routes at ${sourceLabel}: ${fieldName} must be one of: ${Array.from(ADVISORY_TRIGGERS).join(", ")}`);
  }
  return trigger;
}

function normalizeAdvisoryLane(lane, fieldName, sourceLabel) {
  if (!isPlainObject(lane)) {
    throw new Error(`invalid project routes at ${sourceLabel}: ${fieldName} must be an object`);
  }
  const reviewer = normalizeOptionalField(lane, "reviewer", sourceLabel, {
    required: true,
    label: `${fieldName}.reviewer`,
  });
  const profile = normalizeOptionalField(lane, "profile", sourceLabel, { label: `${fieldName}.profile` }) || "blindspot";
  const normalized = {
    reviewer,
    profile,
    trigger: normalizeAdvisoryTrigger(lane.trigger, `${fieldName}.trigger`, sourceLabel, profile),
    gating: normalizeBoolean(lane.gating, `${fieldName}.gating`, sourceLabel, {
      fallback: advisoryProfileDefaults(profile).gating,
    }),
  };
  const model = lane.model !== undefined && lane.model !== null
    ? normalizeOptionalField(lane, "model", sourceLabel, { label: `${fieldName}.model` })
    : normalizeOptionalField(lane, "reviewer_model", sourceLabel, { label: `${fieldName}.reviewer_model` });
  if (model !== undefined) normalized.model = model;
  if (isPlainObject(lane.model_resolution)) normalized.model_resolution = cloneJson(lane.model_resolution);
  return normalized;
}

function normalizeAdvisoryLaneList(value, fieldName, sourceLabel) {
  if (value === undefined || value === null) return null;
  const lanes = Array.isArray(value) ? value : [value];
  return lanes.map((lane, index) => normalizeAdvisoryLane(lane, `${fieldName}[${index}]`, sourceLabel));
}

function normalizeRouteDefault(value, phase, sourceLabel, { partial = false } = {}) {
  if (phase === "advisory_review") {
    // Legacy v2 partial defaults ({ model } without reviewer) are per-field
    // overlays applied at lane pick time, not lane selections; a partial
    // source must preserve that shape instead of failing lane validation.
    if (partial && isPlainObject(value) && !nonEmptyString(value.reviewer)) {
      return cloneJson(value);
    }
    return normalizeAdvisoryLaneList(value, "defaults.advisory_review", sourceLabel);
  }
  const routeDefault = requirePhaseObject(value, phase, sourceLabel);
  if (routeDefault === null) return null;

  // Only materialize a field when normalization yields a value: null/omitted
  // optional fields must not create own undefined properties that erase
  // inherited values at merge time.
  const assignIfDefined = (target, field, value) => {
    if (value !== undefined) target[field] = value;
  };
  if (phase === "dispatch") {
    const normalized = {};
    if (routeDefault.executor !== undefined || !partial) {
      assignIfDefined(normalized, "executor", normalizeOptionalField(routeDefault, "executor", sourceLabel, {
        required: !partial,
        label: "defaults.dispatch.executor",
      }));
    }
    if (routeDefault.model !== undefined) {
      assignIfDefined(normalized, "model", normalizeOptionalField(routeDefault, "model", sourceLabel, { label: "defaults.dispatch.model" }));
    }
    return normalized;
  }
  if (phase === "review") {
    const normalized = {};
    if (routeDefault.reviewer !== undefined || !partial) {
      assignIfDefined(normalized, "reviewer", normalizeOptionalField(routeDefault, "reviewer", sourceLabel, {
        required: !partial,
        label: `defaults.${phase}.reviewer`,
      }));
    }
    if (routeDefault.model !== undefined) assignIfDefined(normalized, "model", normalizeOptionalField(routeDefault, "model", sourceLabel, { label: `defaults.${phase}.model` }));
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

function normalizeManagedCli(value, sourceLabel) {
  if (value === undefined) return undefined;
  return assertNonEmptyStringArray(value, "managed_cli", sourceLabel);
}

function normalizePresets(value, sourceLabel) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`invalid routes config at ${sourceLabel}: presets must be an object`);
  }
  const normalized = {};
  for (const [name, preset] of Object.entries(value)) {
    if (!isPlainObject(preset)) {
      throw new Error(`invalid routes config at ${sourceLabel}: presets.${name} must be an object`);
    }
    normalized[name] = cloneJson(preset);
    for (const phase of ["dispatch", "review", "advisory_review"]) {
      if (preset[phase] !== undefined) {
        normalized[name][phase] = normalizeRouteDefault(preset[phase], phase, `preset:${name}`, { partial: true });
      }
    }
  }
  return normalized;
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
    managed_cli: normalizeManagedCli(routes.managed_cli, sourceLabel),
  };
  if (routes.managed_cli === undefined) delete normalized.managed_cli;
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

function mergePhaseDefaults(base = {}, override) {
  if (override === null) return null;
  if (Array.isArray(override)) return cloneJson(override);
  if (Array.isArray(base)) return override === undefined ? cloneJson(base) : cloneJson(override);
  if (base === null) return override === undefined ? null : cloneJson(override);
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(override) ? override : {}),
  };
}

function mergeAdvisoryPhaseDefaults(base, override) {
  const partialOverride = isPlainObject(override) && !nonEmptyString(override.reviewer);
  if (!partialOverride) return mergePhaseDefaults(base, override);
  // Single-lane composition boundary: a legacy partial overlay ({ model })
  // composes onto exactly one inherited lane; multi-lane inheritance fails
  // closed instead of silently replacing or merging.
  const baseLanes = Array.isArray(base) ? base : (isPlainObject(base) && nonEmptyString(base.reviewer) ? [base] : null);
  if (!baseLanes) return mergePhaseDefaults(base, override);
  if (baseLanes.length !== 1) {
    throw new Error(
      "invalid advisory routing: a partial advisory default (project routes) cannot overlay the inherited multi-lane list; specify full advisory lanes instead of a partial override"
    );
  }
  const model = nonEmptyString(override.model || override.reviewer_model);
  return [model ? { ...cloneJson(baseLanes[0]), model } : cloneJson(baseLanes[0])];
}

function mergeDefaults(base = {}, override = {}) {
  const merged = { ...(base || {}) };
  for (const phase of ["dispatch", "review", "advisory_review"]) {
    if (Object.prototype.hasOwnProperty.call(override || {}, phase)) {
      merged[phase] = phase === "advisory_review"
        ? mergeAdvisoryPhaseDefaults(merged[phase], override[phase])
        : mergePhaseDefaults(merged[phase], override[phase]);
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
    const parsed = readProjectRoutesFile(filePath);
    if (isPlainObject(parsed) && parsed.version === 2) {
      // v2 project routes belong to the routes-config world (loadRouteConfig,
      // active only with the global routes file). Legacy route planning
      // ignores them instead of failing the v1 validator.
      return { ok: true, status: "ignored_v2", path: filePath, routes: null, error: null };
    }
    return {
      ok: true,
      status: "ok",
      path: filePath,
      routes: validateProjectRoutes(parsed, filePath),
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

function availablePresetNames(policy) {
  return Object.keys(policy?.presets || {}).sort();
}

function presetError(message, details = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(details)) error[key] = value;
  return error;
}

function normalizePresetName(value) {
  return nonEmptyString(value);
}

function hasRunIntentField(runIntent, phase, field) {
  return isPlainObject(runIntent?.[phase])
    && Object.prototype.hasOwnProperty.call(runIntent[phase], field);
}

function setRunIntentField(target, phase, field, value, source) {
  const normalized = nonEmptyString(value);
  if (!normalized) return false;
  if (!isPlainObject(target[phase])) target[phase] = {};
  target[phase][field] = normalized;
  if (!isPlainObject(target[ROUTE_INTENT_SOURCES_KEY])) target[ROUTE_INTENT_SOURCES_KEY] = {};
  if (!isPlainObject(target[ROUTE_INTENT_SOURCES_KEY][phase])) target[ROUTE_INTENT_SOURCES_KEY][phase] = {};
  target[ROUTE_INTENT_SOURCES_KEY][phase][field] = source;
  return true;
}

function setRunIntentPhase(target, phase, value, source) {
  if (target[phase] !== undefined) return false;
  target[phase] = cloneJson(value);
  if (!isPlainObject(target[ROUTE_INTENT_SOURCES_KEY])) target[ROUTE_INTENT_SOURCES_KEY] = {};
  if (!isPlainObject(target[ROUTE_INTENT_SOURCES_KEY][phase])) target[ROUTE_INTENT_SOURCES_KEY][phase] = {};
  target[ROUTE_INTENT_SOURCES_KEY][phase].lanes = source;
  return true;
}

function runIntentSource(runIntent, phase, field) {
  return nonEmptyString(runIntent?.[ROUTE_INTENT_SOURCES_KEY]?.[phase]?.[field]) || "run_intent";
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return pushUnique([], value.map(nonEmptyString).filter(Boolean));
}

function normalizeModelResolutionMetadata(metadata, { phase, actor, actorField, model } = {}) {
  if (!isPlainObject(metadata)) return null;
  const resolvedRoute = nonEmptyString(metadata.resolved_route);
  const effectiveModel = nonEmptyString(model);
  if (resolvedRoute && effectiveModel && resolvedRoute !== effectiveModel) return null;
  return {
    original_input: nonEmptyString(metadata.original_input) || null,
    actor: nonEmptyString(metadata.actor) || actor || null,
    actor_field: nonEmptyString(metadata.actor_field) || actorField || null,
    phase: nonEmptyString(metadata.phase) || phase || null,
    requested_model: nonEmptyString(metadata.requested_model) || null,
    resolved_route: resolvedRoute || effectiveModel || null,
    source: nonEmptyString(metadata.source) || null,
    candidates: normalizeStringList(metadata.candidates),
    warnings: normalizeStringList(metadata.warnings),
    ...(isPlainObject(metadata.policy_decision) ? { policy_decision: cloneJson(metadata.policy_decision) } : {}),
  };
}

function modelResolutionForPhase(runIntent, phase, { actor, actorField, model } = {}) {
  return normalizeModelResolutionMetadata(runIntent?.model_resolution?.[phase], {
    phase,
    actor,
    actorField,
    model,
  });
}

function modelResolutionForAdvisoryPresetLane(preset, lane, index) {
  const raw = preset?.model_resolution?.advisory_review;
  const laneMetadata = Array.isArray(raw) ? raw[index] : raw;
  return normalizeModelResolutionMetadata(lane.model_resolution, {
    phase: "advisory_review",
    actor: lane.reviewer,
    actorField: "reviewer",
    model: lane.model,
  }) || normalizeModelResolutionMetadata(laneMetadata, {
    phase: "advisory_review",
    actor: lane.reviewer,
    actorField: "reviewer",
    model: lane.model,
  });
}

function attachAdvisoryPresetModelResolution(preset, lanes) {
  return lanes.map((lane, index) => {
    const metadata = modelResolutionForAdvisoryPresetLane(preset, lane, index);
    return metadata ? { ...lane, model_resolution: metadata } : lane;
  });
}

function normalizePresetPhase(preset, presetName, phase) {
  if (preset[phase] === undefined || preset[phase] === null) return null;
  return normalizeRouteDefault(preset[phase], phase, `preset:${presetName}`, { partial: true });
}

function expandRoutePreset({ runIntent = null, policy = {}, routePresetName = null } = {}) {
  const presetName = normalizePresetName(routePresetName);
  if (!presetName) {
    return {
      runIntent: cloneJson(runIntent || {}),
      routePreset: null,
    };
  }

  const presets = policy?.presets || {};
  const available = availablePresetNames(policy);
  if (!available.length) {
    throw presetError(
      `no route presets configured; run relay-config preset add <name> to create one before using --route-preset ${presetName}`,
      { code: "route_preset_unconfigured", availablePresets: [] }
    );
  }
  if (!Object.prototype.hasOwnProperty.call(presets, presetName)) {
    throw presetError(
      `unknown route preset '${presetName}'; available presets: ${available.join(", ")}`,
      { code: "unknown_route_preset", availablePresets: available }
    );
  }

  const preset = presets[presetName];
  if (!isPlainObject(preset)) {
    throw presetError(`route preset '${presetName}' must be an object`, {
      code: "invalid_route_preset",
      availablePresets: available,
    });
  }

  const expanded = cloneJson(runIntent || {});
  const filled = [];
  const source = `preset:${presetName}`;
  for (const phase of ROUTE_PHASES) {
    const presetPhase = normalizePresetPhase(preset, presetName, phase);
    if (!presetPhase) continue;
    if (phase === "advisory_review") {
      if (isPlainObject(presetPhase) && !nonEmptyString(presetPhase.reviewer)) {
        throw presetError(
          `route preset '${presetName}' advisory_review must be a full lane or lane list; a partial object without reviewer is only valid as a project/run-intent overlay`,
          { code: "invalid_route_preset", availablePresets: available }
        );
      }
      const advisoryPresetPhase = attachAdvisoryPresetModelResolution(preset, presetPhase);
      const existing = expanded[phase];
      if (isPlainObject(existing) && !nonEmptyString(existing.reviewer)) {
        // Run intent carries a partial overlay ({ model } without reviewer);
        // the preset supplies the lanes and the overlay composes onto the
        // single lane. Multi-lane composition is ambiguous and fails closed.
        const lanes = Array.isArray(advisoryPresetPhase) ? advisoryPresetPhase : [advisoryPresetPhase];
        if (lanes.length !== 1) {
          throw presetError(
            `run intent advisory overlay (model without reviewer) cannot compose with multi-lane preset '${presetName}'; specify full advisory lanes in run intent`,
            { code: "invalid_route_preset", availablePresets: available }
          );
        }
        const overlayModel = nonEmptyString(existing.model || existing.reviewer_model);
        expanded[phase] = lanes.map((lane) => (overlayModel ? { ...lane, model: overlayModel } : { ...lane }));
        if (!isPlainObject(expanded[ROUTE_INTENT_SOURCES_KEY])) expanded[ROUTE_INTENT_SOURCES_KEY] = {};
        if (!isPlainObject(expanded[ROUTE_INTENT_SOURCES_KEY][phase])) expanded[ROUTE_INTENT_SOURCES_KEY][phase] = {};
        expanded[ROUTE_INTENT_SOURCES_KEY][phase].lanes = source;
        filled.push({ phase, field: "lanes" });
        continue;
      }
      if (setRunIntentPhase(expanded, phase, advisoryPresetPhase, source)) {
        filled.push({ phase, field: "lanes" });
      }
      continue;
    }
    for (const [field, value] of Object.entries(presetPhase)) {
      if (hasRunIntentField(expanded, phase, field)) continue;
      if (setRunIntentField(expanded, phase, field, value, source)) {
        filled.push({ phase, field });
        if (field === "model") {
          const metadata = normalizeModelResolutionMetadata(preset.model_resolution?.[phase], {
            phase,
            actor: presetPhase.executor || presetPhase.reviewer || null,
            actorField: actorFieldForPhase(phase),
            model: value,
          });
          if (metadata) {
            if (!isPlainObject(expanded.model_resolution)) expanded.model_resolution = {};
            expanded.model_resolution[phase] = metadata;
          }
        }
      }
    }
  }

  const reviewAssurance = nonEmptyString(preset.review_assurance);
  // Only claim review_assurance when the preset actually applies it. When the
  // field is already set (e.g. an explicit CLI --review-assurance seeded into the
  // run intent), the preset must not report it as filled/applied.
  let appliedReviewAssurance = null;
  if (reviewAssurance && !Object.prototype.hasOwnProperty.call(expanded, "review_assurance")) {
    expanded.review_assurance = reviewAssurance;
    if (!isPlainObject(expanded[ROUTE_INTENT_SOURCES_KEY])) expanded[ROUTE_INTENT_SOURCES_KEY] = {};
    expanded[ROUTE_INTENT_SOURCES_KEY].review_assurance = source;
    filled.push({ field: "review_assurance" });
    appliedReviewAssurance = reviewAssurance;
  }

  return {
    runIntent: expanded,
    routePreset: {
      name: presetName,
      source,
      filled,
      review_assurance: appliedReviewAssurance,
    },
  };
}

function pickField({ phase, field, runIntent, projectRoutes, policy }) {
  const runPhase = runIntent?.[phase];
  if (isPlainObject(runPhase) && Object.prototype.hasOwnProperty.call(runPhase, field)) {
    return { value: nonEmptyString(runPhase[field]), source: runIntentSource(runIntent, phase, field) };
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

function pickAdvisoryLaneList({ runIntent, projectRoutes, policy }) {
  const candidates = [];
  if (runIntent && Object.prototype.hasOwnProperty.call(runIntent, "advisory_review")) {
    candidates.push({
      value: runIntent.advisory_review,
      fieldName: "advisory_review",
      sourceLabel: "run_intent",
      source: runIntentSource(runIntent, "advisory_review", "lanes"),
    });
  }
  if (projectRoutes?.defaults && Object.prototype.hasOwnProperty.call(projectRoutes.defaults, "advisory_review")) {
    candidates.push({
      value: projectRoutes.defaults.advisory_review,
      fieldName: "defaults.advisory_review",
      sourceLabel: "project routes",
      source: "project_routes",
    });
  }
  const policyDefault = defaultForPhase(policy, "advisory_review");
  if (policyDefault !== undefined && policyDefault !== null) {
    candidates.push({
      value: policyDefault,
      fieldName: "defaults.advisory_review",
      sourceLabel: "policy_defaults",
      source: "policy_defaults",
    });
  }

  // Legacy v2 project defaults supported partial per-field overrides: a
  // higher-priority source may carry a plain object without reviewer (for
  // example { model }) that overlays the lane chosen from a lower-priority
  // source rather than selecting lanes itself.
  const overlays = [];
  for (const candidate of candidates) {
    const { value } = candidate;
    if (isPlainObject(value) && !nonEmptyString(value.reviewer)) {
      overlays.push(candidate);
      continue;
    }
    let lanes = normalizeAdvisoryLaneList(value, candidate.fieldName, candidate.sourceLabel) || [];
    if (lanes.length > 1 && overlays.length) {
      throw new Error(
        `invalid advisory routing: a partial advisory default (${overlays.map((o) => o.source).join(", ")}) ` +
        `cannot overlay the multi-lane list from ${candidate.source}; specify full advisory lanes instead of a partial override`
      );
    }
    if (lanes.length === 1 && overlays.length) {
      for (let i = overlays.length - 1; i >= 0; i -= 1) {
        const overlay = overlays[i];
        const model = nonEmptyString(overlay.value.model || overlay.value.reviewer_model);
        if (model) {
          lanes = [{ ...lanes[0], model, modelSource: overlay.source }];
        }
      }
    }
    return { lanes, source: candidate.source };
  }
  return { lanes: [], source: "unresolved" };
}

function pickAdvisoryModelForActor({ actor, runIntent, projectRoutes, policy }) {
  // Advisory defaults normalize to lane arrays, which pickField's plain-object
  // path cannot see; a legacy single-object default's model must still act as
  // the fallback for a higher-priority lane that omits model.
  const candidates = [
    [runIntent?.advisory_review, runIntentSource(runIntent, "advisory_review", "model")],
    [projectRoutes?.defaults?.advisory_review, "project_routes"],
    [defaultForPhase(policy, "advisory_review"), "policy_defaults"],
  ];
  for (const [value, source] of candidates) {
    const lanes = Array.isArray(value) ? value : (isPlainObject(value) ? [value] : []);
    const lane = lanes.find((entry) => isPlainObject(entry) && entry.reviewer === actor);
    const model = nonEmptyString(lane?.model || lane?.reviewer_model);
    if (model) return { value: model, source };
  }
  return { value: null, source: "unresolved" };
}

function resolveAdvisoryPhaseRoute({ runIntent, projectRoutes, policy, relayHome, repoRoot, executorModelResolver }) {
  const picked = pickAdvisoryLaneList({ runIntent, projectRoutes, policy });
  if (!picked.lanes.length) return null;
  return picked.lanes.map((lane) => {
    const actorField = "reviewer";
    const explicitModel = nonEmptyString(lane.model);
    let model = explicitModel
      ? { value: explicitModel, source: lane.modelSource || picked.source }
      : pickAdvisoryModelForActor({ actor: lane.reviewer, runIntent, projectRoutes, policy });
    if (!explicitModel && model.source === "unresolved") {
      model = resolveModelForActor({
        phase: "advisory_review",
        actor: lane.reviewer,
        runIntent,
        projectRoutes,
        policy,
        relayHome,
        repoRoot,
        executorModelResolver,
      });
    }
    const resolved = {
      phase: "advisory_review",
      reviewer: lane.reviewer,
      model: model.value,
      source: picked.source,
      sources: {
        reviewer: picked.source,
        model: model.source,
        profile: picked.source,
        trigger: picked.source,
        gating: picked.source,
      },
      profile: lane.profile,
      trigger: lane.trigger,
      gating: lane.gating,
    };
    resolved.policy_decision = evaluateRelayRoute(policy, {
      phase: "advisory_review",
      reviewer: lane.reviewer,
      model: model.value,
    });
    const modelResolution = normalizeModelResolutionMetadata(lane.model_resolution, {
      phase: "advisory_review",
      actor: lane.reviewer,
      actorField,
      model: model.value,
    }) || modelResolutionForPhase(runIntent, "advisory_review", {
      actor: lane.reviewer,
      actorField,
      model: model.value,
    });
    if (modelResolution) resolved.model_resolution = modelResolution;
    return resolved;
  });
}

function resolvePhaseRoute({ phase, runIntent, projectRoutes, policy, relayHome, repoRoot, executorModelResolver }) {
  if (phase === "advisory_review") {
    return resolveAdvisoryPhaseRoute({
      runIntent,
      projectRoutes,
      policy,
      relayHome,
      repoRoot,
      executorModelResolver,
    });
  }
  const actorField = actorFieldForPhase(phase);
  const selected = pickField({ phase, field: actorField, runIntent, projectRoutes, policy });

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

  const policyTuple = actorField === "reviewer"
    ? { phase, reviewer: selected.value, model: model.value }
    : { phase, executor: selected.value, model: model.value };
  resolved.policy_decision = evaluateRelayRoute(policy, policyTuple);
  const modelResolution = modelResolutionForPhase(runIntent, phase, {
    actor: selected.value,
    actorField,
    model: model.value,
  });
  if (modelResolution) resolved.model_resolution = modelResolution;
  return resolved;
}

function resolveRouteIntent({
  runIntent = null,
  routePresetName = null,
  projectRoutes = null,
  policy = buildDefaultRelayPolicy(),
  relayHome = process.env.RELAY_HOME,
  repoRoot = null,
  executorModelResolver = null,
} = {}) {
  const normalizedProjectRoutes = projectRoutes ? validateProjectRoutes(projectRoutes, "project routes") : null;
  const presetExpansion = expandRoutePreset({ runIntent, policy, routePresetName });
  const effectiveRunIntent = presetExpansion.runIntent;
  const phases = {};
  for (const phase of ROUTE_PHASES) {
    phases[phase] = resolvePhaseRoute({
      phase,
      runIntent: effectiveRunIntent,
      projectRoutes: normalizedProjectRoutes,
      policy,
      relayHome,
      repoRoot,
      executorModelResolver,
    });
  }
  return {
    version: 1,
    ...(presetExpansion.routePreset ? { route_preset: presetExpansion.routePreset } : {}),
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
      advisory_review: normalizeAdvisorySelection(rule.advisory_review ?? defaults.advisory_review, "advisory_review", index, warnings),
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
