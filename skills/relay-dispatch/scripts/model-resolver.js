"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { MODEL_CATALOG, CATALOG_LAST_CHECKED, catalogWarnings } = require("./model-catalog");
const { evaluateRelayRoute } = require("./relay-policy");

const PROVIDER_COLUMN_VALUES = new Set([
  "anthropic",
  "cline-pass",
  "deepseek",
  "google",
  "groq",
  "mistral",
  "openai",
  "openrouter",
  "xai",
  "zai",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasProviderModelRoute(model) {
  const normalized = nonEmptyString(model);
  if (!normalized) return false;
  const separator = normalized.indexOf("/");
  return separator > 0 && separator < normalized.length - 1;
}

function pathEntries() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function findOnPath(binaryName) {
  const normalized = nonEmptyString(binaryName);
  if (!normalized) return null;
  for (const dir of pathEntries()) {
    const candidate = path.join(dir, normalized);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return null;
}

function modelProbeTimeoutMs() {
  const raw = Number(process.env.RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS || 20000);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 20000;
}

function normalizeModelLine(line) {
  const stripped = String(line || "")
    .trim()
    .replace(/^[-*\u2022]\s*/, "")
    .trim();
  if (!stripped) return null;
  if (/^-+$/.test(stripped.replace(/\s+/g, ""))) return null;
  const tokens = stripped.split(/\s+/).map((token) => token.replace(/,$/, ""));
  const [first, second] = tokens;
  if (first === "provider" && second === "model") return null;
  if (first && second && isProviderColumn(first) && !first.includes("/") && !second.includes("/")) {
    return nonEmptyString(`${first}/${second}`);
  }
  return nonEmptyString(first);
}

function isProviderColumn(value) {
  return PROVIDER_COLUMN_VALUES.has(String(value || "").toLowerCase());
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values || []) {
    const normalized = nonEmptyString(value);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function probeModels(name, executable = findOnPath(name)) {
  if (!executable || !["opencode", "pi"].includes(name)) {
    return { status: "not_applicable", models: [], warning: null };
  }
  const args = name === "opencode" ? ["models"] : ["--list-models"];
  const timeoutMs = modelProbeTimeoutMs();
  try {
    const output = execFileSync(executable, args, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: timeoutMs,
    });
    const models = uniqueStrings(output.split("\n").map(normalizeModelLine));
    return { status: "ok", models, warning: null };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).split("\n")[0];
    const command = `${path.basename(executable)} ${args.join(" ")}`;
    return {
      status: "warning",
      models: [],
      warning: `optional model-list probe failed for ${name} (${command}) after ${timeoutMs}ms: ${detail} (set RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS to adjust)`,
    };
  }
}

function actorTuple({ phase, actor, actorField, model }) {
  if (actorField === "reviewer" || phase === "review" || phase === "advisory_review") {
    return { phase, reviewer: actor, model };
  }
  return { phase, executor: actor, model };
}

function policyDecision({ policy, phase, actor, actorField, model }) {
  return evaluateRelayRoute(policy, actorTuple({ phase, actor, actorField, model }));
}

function routeBasename(route) {
  const normalized = nonEmptyString(route);
  if (!normalized) return "";
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? normalized : normalized.slice(separator + 1);
}

function liveCandidates(models, request) {
  const wanted = nonEmptyString(request);
  if (!wanted) return [];
  const exact = uniqueStrings(models).filter((model) => model === wanted || routeBasename(model) === wanted);
  if (exact.length) return exact;
  const lower = wanted.toLowerCase();
  return uniqueStrings(models).filter((model) => {
    const route = model.toLowerCase();
    return route.includes(lower) || routeBasename(route).includes(lower);
  });
}

function catalogCandidateRecords({ actor, model }) {
  const actorName = nonEmptyString(actor);
  const wanted = nonEmptyString(model);
  if (!actorName || !wanted) return [];
  const lower = wanted.toLowerCase();
  const candidates = [];
  for (const entry of MODEL_CATALOG) {
    const route = nonEmptyString(entry.actor_routes?.[actorName]);
    if (!route) continue;
    const aliases = uniqueStrings([entry.id, ...(entry.aliases || [])]).map((value) => value.toLowerCase());
    if (aliases.includes(lower) || routeBasename(route).toLowerCase() === lower) {
      candidates.push({
        route,
        last_checked: nonEmptyString(entry.last_checked) || CATALOG_LAST_CHECKED,
        notes: nonEmptyString(entry.notes),
      });
    }
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.route)) return false;
    seen.add(candidate.route);
    return true;
  });
}

function baseResult({ phase, actor, actorField, model }) {
  return {
    ok: false,
    error: null,
    original_input: nonEmptyString(model),
    actor: nonEmptyString(actor),
    actor_field: actorField,
    phase: nonEmptyString(phase),
    requested_model: nonEmptyString(model),
    resolved_route: null,
    source: null,
    candidates: [],
    warnings: [],
    probe: null,
    policy_decision: null,
  };
}

function withPolicy(result, policy, model) {
  const decision = policyDecision({
    policy,
    phase: result.phase,
    actor: result.actor,
    actorField: result.actor_field,
    model,
  });
  return {
    ...result,
    policy_decision: decision,
    ok: decision.allowed === true,
    error: decision.allowed === true ? null : decision.reason || "route_policy_denied",
  };
}

function resolvedResult({ base, policy, route, source, candidates = [route], warnings = [], probe = null }) {
  return withPolicy({
    ...base,
    resolved_route: route,
    source,
    candidates: uniqueStrings(candidates),
    warnings: uniqueStrings([...(base.warnings || []), ...warnings]),
    probe,
  }, policy, route);
}

function resolveModelRequest({
  phase,
  actor,
  actorField,
  model = null,
  policy,
  fallback = "none",
  now = new Date(),
  probeModels: probe = probeModels,
  findExecutable = findOnPath,
} = {}) {
  const base = baseResult({ phase, actor, actorField, model });
  if (!base.phase) return { ...base, error: "missing_phase" };
  if (!base.actor) return { ...base, error: "missing_actor_context" };

  if (!base.requested_model) {
    const decision = policyDecision({
      policy,
      phase: base.phase,
      actor: base.actor,
      actorField: base.actor_field,
      model: null,
    });
    if (decision.allowed === true && decision.reason === "managed_cli") {
      return {
        ...base,
        ok: true,
        source: "model_less",
        resolved_route: null,
        policy_decision: decision,
      };
    }
    return {
      ...base,
      error: "missing_model",
      resolved_route: null,
    };
  }

  if (hasProviderModelRoute(base.requested_model)) {
    return resolvedResult({
      base,
      policy,
      route: base.requested_model,
      source: "explicit_route",
      candidates: [base.requested_model],
    });
  }

  const executable = findExecutable(base.actor);
  const probeResult = probe(base.actor, executable);
  const candidates = probeResult?.status === "ok"
    ? liveCandidates(probeResult.models, base.requested_model)
    : [];
  if (candidates.length === 1) {
    return resolvedResult({
      base,
      policy,
      route: candidates[0],
      source: "live_probe",
      candidates,
      probe: probeResult,
    });
  }
  if (candidates.length > 1) {
    return {
      ...base,
      error: "ambiguous_model",
      candidates,
      probe: probeResult,
    };
  }
  if (probeResult?.status === "ok") {
    return {
      ...base,
      error: "unknown_model",
      candidates: [],
      probe: probeResult,
    };
  }

  if (fallback === "catalog") {
    const catalogRecords = catalogCandidateRecords({ actor: base.actor, model: base.requested_model });
    const catalog = catalogRecords.map((candidate) => candidate.route);
    if (catalog.length === 1) {
      return resolvedResult({
        base,
        policy,
        route: catalog[0],
        source: "catalog_fallback",
        candidates: catalog,
        warnings: [
          probeResult?.warning,
          ...catalogWarnings(catalogRecords[0]?.last_checked, now),
        ],
        probe: probeResult,
      });
    }
    if (catalog.length > 1) {
      return {
        ...base,
        error: "ambiguous_model",
        candidates: catalog,
        warnings: uniqueStrings([probeResult?.warning]),
        probe: probeResult,
      };
    }
  }

  return {
    ...base,
    error: probeResult?.status === "warning" ? "model_probe_failed" : "model_probe_unavailable",
    warnings: uniqueStrings([probeResult?.warning]),
    probe: probeResult,
  };
}

function resolutionMetadata(result, { originalInput } = {}) {
  if (!result || result.ok !== true) return null;
  return {
    original_input: nonEmptyString(originalInput) || result.original_input || null,
    actor: result.actor,
    actor_field: result.actor_field,
    phase: result.phase,
    requested_model: result.requested_model || null,
    resolved_route: result.resolved_route || null,
    source: result.source,
    candidates: result.candidates || [],
    warnings: result.warnings || [],
    policy_decision: result.policy_decision || null,
  };
}

module.exports = {
  findOnPath,
  hasProviderModelRoute,
  probeModels,
  resolveModelRequest,
  resolutionMetadata,
};
