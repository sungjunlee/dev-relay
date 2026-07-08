"use strict";

const CATALOG_LAST_CHECKED = "2026-07-06";
const STALE_AFTER_DAYS = 60;

const MODEL_CATALOG = Object.freeze([
  {
    id: "glm-5.2",
    aliases: ["glm-5.2", "glm"],
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
    cost_hint: "cheap",
    notes: "Fast iteration and low-cost preset experiments.",
    actor_routes: {
      cline: "cline-pass/deepseek-v4-flash",
      opencode: "openrouter/deepseek-v4-flash",
    },
  },
]);

module.exports = {
  CATALOG_LAST_CHECKED,
  MODEL_CATALOG,
  STALE_AFTER_DAYS,
};
