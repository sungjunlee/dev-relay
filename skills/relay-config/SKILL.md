---
name: relay-config
argument-hint: "[setup request or command]"
description: Interactive setup for relay routes. Use when the user asks to set up relay, configure company/personal relay routing, enable OpenCode or Pi, add provider/model routes, check advisory-review routing, or run relay-config doctor/check.
compatibility: Requires Node.js 18+ and the sibling relay-dispatch skill.
metadata:
  related-skills: "relay, relay-dispatch, relay-review"
  keywords: "relay setup, relay config, route config, model route, opencode, pi, advisory review, 릴레이 설정, 회사 설정, 개인 설정"
  entry: scripts/relay-config.js
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; writes go to `${RELAY_HOME:-~/.relay}/routes.json`; legacy `~/.relay/policy.json`, repo `.relay/policy.json`, and `~/.relay/executors.json` are read fallback only when routes.json is absent; optional `RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS` defaults model-list probes to `20000` ms.
- Files: effective relay routes, optional repo `.relay/routes.json`, legacy fallback files listed above.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/relay-config.js`.

# Relay Config

Set up relay routes interactively. The user should not have to memorize command flags.

## Use when

- The user asks to set up or configure relay
- The user wants company-safe strict mode, personal open mode, OpenCode/Pi opt-in, or advisory-review routing
- The user asks whether a provider/model route such as `example/opencode-model-*` or `openai/*` is available
- The user asks to run relay doctor/check

## Do not use when

- Dispatching implementation work - use `relay-dispatch`
- Reviewing PRs - use `relay-review`
- Coordinating parallel implementation leaves - use `relay-fleet`

## Workflow

### 1. Inspect current state

Always start with:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" inspect --json
```

Use the output to identify the effective routes, source paths, installed harnesses, and whether `~/.relay/executors.json` exists as a legacy fallback.

### 2. Infer the setup intent

Infer from the user's words before asking questions:

- `company`, `work`, `회사` -> strict company profile
- `personal`, `home`, `집`, `개인` -> open personal profile
- `managed only`, `codex/claude only` -> no unmanaged provider/model route opt-in
- routes containing `/`, such as `example/opencode-model-*`, `example/pi-*`, `openai/*`, or `ollama/*` -> provider/model route patterns
- `advisory`, `reviewer`, `documentation`, `docs` -> likely advisory-review phases

Ask only for missing decisions, one at a time. Use plain language and wait for the user's answer. Do not use host-specific question primitives as the only path; this skill must work in both Claude Code and Codex.

### 3. Propose before writing

Before mutating routes, show a concise proposal:

- profile to initialize or keep (`company` writes `strict: true`; `personal` writes `strict: false`)
- managed CLIs that remain model-less (`codex`, `claude`)
- provider/model routes to add
- phases and actors for each route
- default actors to set, if any

Ask for confirmation. If the user already explicitly approved the exact route changes in the same request, proceed and state what will be written.

### 4. Apply with deterministic commands

Use the wrapper for shorthand, or pass through full flags:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" init company
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" add-route 'example/opencode-model-*' --phase dispatch,advisory_review --executor opencode
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" set-default advisory_review.reviewer opencode
```

Generated company and personal profiles must not pin Codex or Claude model names. Do not hardcode company-specific route defaults; use the user's supplied provider/model route patterns.

### 5. Verify

After changes, run:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" doctor
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" check dispatch opencode example/opencode-model-fast
node "${RELAY_SKILL_ROOT:-skills}/relay-config/scripts/relay-config.js" check review opencode example/opencode-model-fast
```

Adjust the `check` tuple to match the actual actor, phase, and route that was enabled. Report denied tuples clearly and do not treat a denied OpenCode/Pi route as configured.

## Power-user shorthand

The wrapper accepts common shorthand and delegates to `relay-dispatch/scripts/relay-config.js`:

| User form | Core command |
| --- | --- |
| `init company` | `init --profile company` |
| `init personal` | `init --profile personal` |
| `show` | `show --effective` |
| `doctor` | `doctor` |
| `add-route example/opencode-model-* --phase dispatch --executor opencode` | `add-route example/opencode-model-* --phase dispatch --executor opencode` |
| `check dispatch opencode example/opencode-model-fast` | `check --phase dispatch --executor opencode --model example/opencode-model-fast` |
| `check review opencode example/opencode-model-fast` | `check --phase review --reviewer opencode --model example/opencode-model-fast` |
| `check advisory_review pi example/pi-model-fast` | `check --phase advisory_review --reviewer pi --model example/pi-model-fast` |

Full flag forms continue to pass through. Route semantics live in the sibling `relay-dispatch` script, not this wrapper.
