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
