"use strict";

const CATALOG_LAST_CHECKED = "2026-07-06";
const STALE_AFTER_DAYS = 60;

const MODEL_CATALOG = Object.freeze([
  {
    id: "glm-5.2",
    aliases: ["glm-5.2", "glm"],
    last_checked: CATALOG_LAST_CHECKED,
    cost_hint: "premium",
    notes: "Strong default for harder coding and reasoning routes.",
    actor_routes: {
      cline: "cline-pass/glm-5.2",
      opencode: "opencode-go/glm-5.2",
    },
  },
  {
    id: "kimi-k2.7-code",
    aliases: ["kimi-k2.7-code", "kimi"],
    last_checked: CATALOG_LAST_CHECKED,
    cost_hint: "premium",
    notes: "Large implementation tasks when GLM is unavailable.",
    actor_routes: {
      cline: "cline-pass/kimi-k2.7-code",
      opencode: "openrouter/kimi-k2.7-code",
    },
  },
  {
    id: "deepseek-v4-pro",
    aliases: ["deepseek-v4-pro", "deepseek-pro"],
    last_checked: CATALOG_LAST_CHECKED,
    cost_hint: "pro value",
    notes: "Larger changes with strong cost/performance balance.",
    actor_routes: {
      cline: "cline-pass/deepseek-v4-pro",
      opencode: "openrouter/deepseek-v4-pro",
    },
  },
  {
    id: "minimax-m3",
    aliases: ["minimax-m3", "minimax"],
    last_checked: CATALOG_LAST_CHECKED,
    cost_hint: "mid",
    notes: "General coding when a capable mid-cost route is desired.",
    actor_routes: {
      cline: "cline-pass/minimax-m3",
      opencode: "openrouter/minimax-m3",
    },
  },
  {
    id: "deepseek-v4-flash",
    aliases: ["deepseek-v4-flash", "deepseek-flash"],
    last_checked: CATALOG_LAST_CHECKED,
    cost_hint: "cheap",
    notes: "Fast iteration and low-cost preset experiments.",
    actor_routes: {
      cline: "cline-pass/deepseek-v4-flash",
      opencode: "openrouter/deepseek-v4-flash",
    },
  },
]);

function daysSince(dateString, now = new Date()) {
  const checked = Date.parse(`${dateString}T00:00:00Z`);
  const current = now instanceof Date ? now.getTime() : Date.now();
  if (!Number.isFinite(checked) || !Number.isFinite(current)) return null;
  return Math.floor((current - checked) / 86400000);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function catalogWarnings(lastChecked = CATALOG_LAST_CHECKED, now) {
  const warnings = [
    "catalog fallback used; verify provider/model availability before relying on this route",
  ];
  const checked = nonEmptyString(lastChecked) || CATALOG_LAST_CHECKED;
  const ageDays = daysSince(checked, now);
  if (ageDays !== null && ageDays > STALE_AFTER_DAYS) {
    warnings.push(`stale catalog metadata: last_checked=${checked}, age_days=${ageDays}`);
  }
  return warnings;
}

function catalogFreshnessReport({ now = new Date() } = {}) {
  const generatedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const entries = MODEL_CATALOG.map((entry) => {
    const lastChecked = nonEmptyString(entry.last_checked) || CATALOG_LAST_CHECKED;
    const ageDays = daysSince(lastChecked, now);
    const actorRoutes = entry.actor_routes || {};
    return {
      id: entry.id,
      aliases: [...(entry.aliases || [])],
      last_checked: lastChecked,
      age_days: ageDays,
      stale: ageDays !== null ? ageDays > STALE_AFTER_DAYS : null,
      actor_routes: { ...actorRoutes },
      actors: Object.keys(actorRoutes).sort(),
      cost_hint: entry.cost_hint || null,
      notes: entry.notes || null,
    };
  });
  const summary = entries.reduce((acc, entry) => {
    acc.total += 1;
    if (entry.stale === true) acc.stale += 1;
    else if (entry.stale === false) acc.fresh += 1;
    else acc.unknown_age += 1;
    return acc;
  }, { total: 0, fresh: 0, stale: 0, unknown_age: 0 });
  return {
    generated_at: generatedAt,
    stale_after_days: STALE_AFTER_DAYS,
    catalog_last_checked: CATALOG_LAST_CHECKED,
    summary,
    entries,
  };
}

module.exports = {
  CATALOG_LAST_CHECKED,
  MODEL_CATALOG,
  STALE_AFTER_DAYS,
  catalogFreshnessReport,
  catalogWarnings,
  daysSince,
};
