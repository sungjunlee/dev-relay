# Model catalog

Last checked: 2026-07-06. Treat as stale after 60 days.

Use only when live model-list probes fail or the user asks for a recommendation. Prefer provider CLI model lists from `relay-config doctor` when available. The executable catalog data lives in `skills/relay-dispatch/scripts/model-catalog.js`; this note is operator-facing context, not a runtime allow-list.

| Model | Actor routes | Use when | Cost hint |
| --- | --- | --- | --- |
| `glm-5.2` | `cline` -> `cline-pass/glm-5.2`; `opencode` -> `opencode-go/glm-5.2` | Strong default for harder coding and reasoning routes. | premium |
| `kimi-k2.7-code` | `cline` -> `cline-pass/kimi-k2.7-code`; `opencode` -> `openrouter/kimi-k2.7-code` | Large implementation tasks when GLM is unavailable. | premium |
| `deepseek-v4-pro` | `cline` -> `cline-pass/deepseek-v4-pro`; `opencode` -> `openrouter/deepseek-v4-pro` | Larger changes with strong cost/performance balance. | pro value |
| `minimax-m3` | `cline` -> `cline-pass/minimax-m3`; `opencode` -> `openrouter/minimax-m3` | General coding when a capable mid-cost route is desired. | mid |
| `deepseek-v4-flash` | `cline` -> `cline-pass/deepseek-v4-flash`; `opencode` -> `openrouter/deepseek-v4-flash` | Fast iteration and low-cost preset experiments. | cheap |

These are selection hints, not an authority. Model quality, availability, and prices change quickly.

## Freshness report

Run a read-only freshness report without requiring a failed live probe:

```bash
node skills/relay-config/scripts/relay-config.js catalog-report --json
```

The report exits successfully and includes each catalog entry's `actor_routes`, `last_checked`, `age_days`, and `stale` status. Use this for scheduled visibility or preflight checks; do not treat catalog fallback as an allow-list.

## Updating parser fixtures and catalog dates

Live model-list parser fixtures live under `tests/relay-dispatch/fixtures/model-lists/`. When a provider CLI changes output shape, add or update the smallest representative fixture and cover it through `tests/relay-dispatch/scripts/model-resolver.test.js`. Keep headers, separators, provider/model split columns, direct provider/model rows, and extra metadata columns in fixtures when those shapes are observed.

Only update `last_checked` in `skills/relay-dispatch/scripts/model-catalog.js` after verifying availability through a current provider CLI model list or equivalent authoritative provider evidence. Record route coverage by actor, keep aliases as convenience inputs, and leave actual route authorization to `routes.json`.
