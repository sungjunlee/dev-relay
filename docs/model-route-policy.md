# Model Route Policy

Route policy answers one operational question: which provider/model route is allowed to run in each relay phase?

Executor and reviewer names such as `codex`, `claude`, `opencode`, and `pi` are harness names. They select a CLI adapter and execution contract. They are not the compliance boundary. The compliance boundary is the provider/model route string, for example `example/opencode-model-fast`, `opencode-go/deepseek-v4-pro`, `deepseek/r1`, or `ollama/qwen3`.

Codex and Claude are the managed CLI defaults. In the default managed profile, a model-less Codex or Claude invocation is allowed because the CLI account and its managed default model are the boundary. Generated company defaults should not pin Codex or Claude model names just to make policy explicit. OpenCode, Pi, and Antigravity are routing harnesses, so managed/company profiles must require an explicit provider/model route and an allow rule before they can run.

## Default Posture

When no policy config exists, relay loads a fail-closed default policy:

```json
{
  "profile": "managed-cli-default",
  "defaults": {
    "dispatch": { "executor": "codex" },
    "review": { "reviewer": "codex" },
    "advisory_review": null
  },
  "managed_cli": ["codex", "claude"],
  "allowed_model_routes": [],
  "denied_model_routes": [],
  "routing_rules": [],
  "deny_unknown_model_routes": true
}
```

That means missing policy config defaults to Codex/Claude managed CLI only. `codex` and `claude` pass the gate without a pinned model route. `opencode`, `pi`, `antigravity`, and any other unmanaged harness fail unless the effective invocation includes a provider/model route and that route matches `allowed_model_routes`.

## Precedence

Use this final precedence order when reasoning about an invocation:

`CLI flags / --route-intent-file -> project routes.json -> routing rules -> defaults -> existing relay defaults -> policy gate`

The policy gate is last and fail-closed. A route selected by a CLI flag, a routing rule, a model hint, an executor default, or an existing relay fallback still has to pass the policy gate. Deny rules win over allow rules, and unknown provider/model routes are denied when `deny_unknown_model_routes` is true.

Adapter capability checks happen before the model-route policy gate. The adapter layer answers whether the selected CLI can safely perform the requested phase and containment mode, such as dispatch vs primary review vs advisory review, read-only requirements, sandbox metadata, and network metadata. The route-policy layer answers only whether the already-capable effective provider/model route is allowed for the active profile.

For example, `--reviewer opencode --reviewer-model openai/gpt-5` reaches the route-policy gate because OpenCode can now represent primary review, then fails as a model-route denial unless that route is allowed for `phase=review`. Likewise, `--advisory-reviewer pi --advisory-reviewer-model openai/gpt-5` reaches the advisory route-policy gate because Pi can represent advisory review. JSON failures expose these layers separately as `adapter_capability` and `policy_decision`.

## Phase Interaction

| Phase | Route selection before the gate | Policy gate tuple |
| --- | --- | --- |
| `dispatch` | `--executor` selects the harness. `--model` wins over `manifest.model_hints.dispatch`, then `--model-hints dispatch=...`, then executor model config such as `~/.relay/executors.json` or bundled OpenCode defaults. Primary dispatch routing rules are not used today; `--tags` only affects advisory review routing selected by dispatch. If no actor is supplied, the existing relay default is `codex`. | `phase=dispatch`, `executor=<name>`, `model=<effective route or null>` |
| `review` | `--reviewer` wins over `RELAY_REVIEWER`, then `roles.reviewer`, then the existing relay default `codex`. `--reviewer-model` wins over `manifest.model_hints.review`; otherwise Codex/Claude normally run as managed CLI with no model route. | `phase=review`, `reviewer=<name>`, `model=<effective route or null>` |
| `advisory_review` | `--advisory-reviewer` and `--advisory-reviewer-model` win. If absent, `routing.selected.advisory_review` from dispatch routing can supply the reviewer, profile, and model. If a reviewer is selected but no model is supplied, `manifest.model_hints.advisory_review` and then executor model config can supply the route. No advisory reviewer runs by default. | `phase=advisory_review`, `reviewer=<name>`, `model=<effective route or null>` |

Policy `defaults` describe configured actor defaults for auditing and future-safe profile shape. Where a current call site does not consume a policy default directly, the existing relay default in the table applies next. The policy gate still evaluates the final effective tuple.

`model_hints` are route hints, not route approval. They can carry provider/model routes for unmanaged harnesses, especially advisory review. They should not be used to pin Codex or Claude defaults in generated company config.

## Organization Setup

After installing skills, prefer the interactive setup skill. Ask in natural language and let it inspect the current policy before writing:

```text
/relay-config 회사 환경으로 relay 설정해줘. opencode는 example/opencode-model-*만 허용해줘.
```

The skill should show the proposed policy, ask for confirmation, apply it, then run `doctor` and representative `check` commands.

From a direct checkout, initialize a company policy with the wrapper:

```bash
node skills/relay-config/scripts/relay-config.js init company
```

The generated company policy intentionally keeps Codex and Claude as managed CLI defaults with no pinned model names. Add organization-approved OpenCode or Pi routes explicitly:

```bash
node skills/relay-config/scripts/relay-config.js allow-route 'example/opencode-model-*' \
  --phase dispatch,advisory_review \
  --executor opencode

node skills/relay-config/scripts/relay-config.js allow-route 'example/pi-*' \
  --phase dispatch,review,advisory_review \
  --executor pi \
  --reviewer pi
```

For routed advisory reviewers, add routing rules to the policy JSON so the selected route is policy-approved:

```json
{
  "version": 1,
  "profile": "company",
  "defaults": {
    "dispatch": { "executor": "codex" },
    "review": { "reviewer": "codex" },
    "advisory_review": null
  },
  "managed_cli": ["codex", "claude"],
  "allowed_model_routes": [
    {
      "route": "example/opencode-model-*",
      "phases": ["dispatch", "advisory_review"],
      "executors": ["opencode"],
      "reviewers": ["opencode"]
    }
  ],
  "denied_model_routes": [],
  "routing_rules": [
    {
      "name": "docs-approved-advisory",
      "match": { "any_tags": ["docs", "docs-only"] },
      "advisory_review": {
        "reviewer": "opencode",
        "profile": "blindspot",
        "model": "example/opencode-model-fast"
      }
    }
  ],
  "deny_unknown_model_routes": true
}
```

Repo-local `.relay/policy.json` files may narrow the global policy but may not widen it. For example, a repo policy can reduce `allowed_model_routes` from `example/*` to `example/opencode-model-*`; it cannot add a new external provider that the global policy did not allow.

Project-local `~/.relay/projects/<repo-slug>/policy.json` is an additional local narrow-only layer after global and repo policy. It is for company or personal machine restrictions that should not be committed. Policy is authorization; `~/.relay/projects/<repo-slug>/routes.json` is only preferences and cannot grant a route.

```text
~/.relay/projects/<repo-slug>/project.json
~/.relay/projects/<repo-slug>/policy.json
~/.relay/projects/<repo-slug>/routes.json
```

Example project preference file:

```json
{
  "version": 1,
  "defaults": {
    "dispatch": { "executor": "pi", "model": "deepseek/deepseek-v4-flash" },
    "review": { "reviewer": "codex" },
    "advisory_review": { "reviewer": "opencode", "model": "opencode-go/deepseek-v4-pro" }
  }
}
```

Preview before dispatch:

```bash
node skills/relay-config/scripts/relay-config.js plan-run --repo . \
  --dispatch pi:deepseek/deepseek-v4-flash \
  --review codex \
  --json
```

For one-off runs, write a route intent JSON and pass `--route-intent-file` to dispatch. Dispatch persists the final audit snapshot as `route-plan.json` next to the run manifest.

## Personal Opt-In Setup

After installing skills, prefer natural-language setup:

```text
$relay-config 집에서는 opencode-go/deepseek-v4-pro를 advisory review에 쓰게 설정해줘.
```

From a direct checkout, initialize a personal policy:

```bash
node skills/relay-config/scripts/relay-config.js init personal
```

Then opt in to the routes you personally allow:

```bash
node skills/relay-config/scripts/relay-config.js allow-route 'opencode-go/*' \
  --phase dispatch,advisory_review \
  --executor opencode

node skills/relay-config/scripts/relay-config.js allow-route 'deepseek/*' \
  --phase dispatch,advisory_review \
  --executor opencode

node skills/relay-config/scripts/relay-config.js allow-route 'ollama/*' \
  --phase dispatch,advisory_review \
  --executor opencode
```

If you want OpenCode to default to a personal route, set the executor model config and allow the matching route:

```json
{
  "executors": {
    "opencode": {
      "default_model": "opencode-go/deepseek-v4-pro",
      "candidate_models": [
        "opencode-go/deepseek-v4-pro",
        "deepseek/r1",
        "ollama/qwen3"
      ]
    }
  }
}
```

This file changes model selection only. It does not grant policy approval. The selected provider/model route must still match `allowed_model_routes`.

Antigravity uses `google/antigravity-cli` as a policy label in V1. Relay does not pass provider/model labels to `agy`; do not assume Gemini variant selection until the CLI exposes a real model-selection flag.

## Doctor And Check

Run `relay-config doctor` after policy changes and before enabling advisory reviewers. Installed operators should use the skill; direct-checkout users can run:

```bash
node skills/relay-config/scripts/relay-config.js doctor
```

Doctor reports whether known CLIs are installed and how policy treats each harness. For OpenCode or Pi, `route-configured (provider_model_route_required)` is expected when an allow rule exists but a specific model was not supplied to doctor. That is a reminder that the harness name alone is not compliant.

Run `relay-config check` for each actual tuple you plan to enable:

```bash
node skills/relay-config/scripts/relay-config.js check dispatch opencode example/opencode-model-fast

node skills/relay-config/scripts/relay-config.js check advisory_review opencode example/opencode-model-fast

node skills/relay-config/scripts/relay-config.js check advisory_review opencode example/opencode-model-fast
```

Check exits non-zero when the tuple would be denied at runtime. Run it before turning on routed advisory review rules because advisory review can start automatically after dispatch.

For pre-planning dispatch probes, run the matching `probe-executor-env` command with the same unmanaged route. The probe evaluates `--executor` plus `--model` as a dispatch policy tuple before invoking the adapter:

```bash
node skills/relay-config/scripts/relay-config.js check dispatch pi opencode-go/deepseek-v4-pro

node skills/relay-plan/scripts/probe-executor-env.js . \
  --executor pi \
  --model opencode-go/deepseek-v4-pro \
  --json
```

If the route is allowed, the probe policy decision reports `reason=allowed_model_route`, `model=opencode-go/deepseek-v4-pro`, and then invokes the Pi adapter probe. If `--model` is omitted and no executor default supplies a provider/model route, unmanaged executors fail closed before adapter invocation: JSON output reports `policy_decision.reason=missing_model_route`, `policy_decision.model=null`, and `agent_tools_raw=null`. This is different from an explicit but unapproved route, which reports `unknown_model_route` with the rejected route in `policy_decision.model`.

## Denial Example

With the company policy above, an external OpenAI route through OpenCode is not allowed:

```bash
$ node skills/relay-config/scripts/relay-config.js check dispatch opencode openai/gpt-5
denied: unknown_model_route
```

If the route is explicitly denied, the reason is stronger and the matched deny route is shown:

```bash
$ node skills/relay-config/scripts/relay-config.js deny-route 'openai/*' \
  --phase dispatch \
  --executor opencode

$ node skills/relay-config/scripts/relay-config.js check dispatch opencode openai/gpt-5
denied: denied_model_route
matched route: openai/*
```

Both failures happen before the harness runs. That is the intended safety property: the provider/model route must be approved before relay invokes an unmanaged CLI.
