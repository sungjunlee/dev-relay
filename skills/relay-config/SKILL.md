---
name: relay-config
description: Inspect relay adapters and validate explicit dispatch or primary-review selections.
compatibility: Requires Node.js 18+.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-review"
  keywords: "설정, 어댑터, 모델, config, adapter, model"
---

# Relay Config

## Use when

- Inspecting installed adapter availability
- Checking whether an explicit executor/reviewer selection supports a phase
- Recording an explicit model selection without resolving aliases or catalogs

## Commands

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" doctor --json
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" \
  check --phase dispatch --executor opencode --model provider/model --json
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" \
  check --phase review --reviewer codex --json
```

Valid operator phases are `dispatch` and `review`. This command does not mutate
configuration: runtime selection comes only from explicit CLI input followed by
the immutable run binding and the adapter provider default.

## Safety

- Keep executor/reviewer and model selections explicit.
- Run `doctor --json` to inspect CLI availability.
- `doctor` checks all seven built-in adapters by running each CLI's `--version` probe.
- Neither command reads or writes runtime policy, routes, presets, or defaults.
