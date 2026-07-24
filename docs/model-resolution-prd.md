# Model Resolution PRD

Status: proposal (2026-07-07)
Related: `docs/route-config-simplification-design.md` Phase B/C, ADR-0007 routes single concept

## Summary

Relay should resolve user-facing model names like `glm-5.2` through the same route-first discipline used by the delegate skill: choose the actor/provider context first, prefer live model-list data when available, use a stale-prone catalog only as a fallback hint, and persist only explicit provider/model routes into relay route config or run intent.

The goal is not to add a runtime alias table. Runtime dispatch and review should consume explicit provider/model routes. Model resolution belongs at the configuration and intent-shaping boundary: `relay-config`, preset creation, `/relay` natural-language setup, and route-intent preparation.

## Problem

Operators naturally say things like:

```text
review this with glm-5.2
make a light preset with opencode + glm-5.2
use cline-pass glm for advisory review
```

Relay currently treats the model field as a provider/model route boundary. That is correct for policy and audit, but it creates a UX gap: `glm-5.2` is a model slug, not a route. Different harnesses need different route strings:

- Cline needs provider plus model, for example `cline-pass/glm-5.2`.
- OpenCode/Pi model probes can report provider/model rows such as `opencode-go/glm-5.2`.
- Some actors have no reliable list-models command.
- Managed Codex/Claude often run model-less and should not be forced into pinned route names.

A hardcoded alias layer such as `glm-5.2 -> cline-pass/glm-5.2` fixes one symptom but creates new drift:

- It bypasses live model-list data.
- It hardcodes provider prefixes in runtime paths.
- It competes with `routes.json`, presets, and `relay-config` as the route source of truth.
- It cannot solve actor selection when the user only says "use glm-5.2" without naming the reviewer or executor.
- It risks turning a stale catalog hint into an authority.

## Goals

- Resolve fuzzy or short model names into explicit provider/model routes before dispatch/review runtime execution.
- Keep `routes.json` as the single durable route concept.
- Follow delegate's resolution order: live list first, stale catalog only when live list is unavailable or the user asks for a recommendation.
- Make resolution auditable in JSON output, route-plan snapshots, and warnings.
- Keep managed Codex/Claude model-less by default.
- Support route preset creation from natural language or compact actor/model syntax.

## Non-goals

- Do not silently rewrite models inside low-level executor/reviewer adapters.
- Do not bless one provider prefix globally for a model slug.
- Do not add automatic difficulty-based model selection.
- Do not make catalog entries a policy allow-list.
- Do not require live model probes to succeed before explicit provider/model routes can run.

## Design Principles

### Provider context first

Model resolution requires an actor or provider context. `glm-5.2` alone is incomplete. Relay can resolve it only after one of these is known:

- dispatch executor, such as `opencode`, `pi`, or `cline`;
- review/advisory reviewer;
- provider route prefix explicitly supplied by the user, such as `cline-pass` or `opencode-go`;
- preset field, such as `dispatch: { executor: "opencode" }`.

If no actor/provider context exists, ask for the actor or show available presets/routes. Do not guess.

### Live list before catalog

For actors with model-list support, resolver should use live model-list data with a bounded timeout:

- `opencode`: `opencode models`
- `pi`: `pi --list-models [search]`
- `cursor`: `agent models`

Actors without reliable list-models, such as Cline today, can use provider conventions plus catalog hints only when the user supplied a fuzzy slug or asked for a recommendation.

### Catalog is a fallback hint

The catalog follows the delegate convention:

- `Last checked: <date>`
- stale after 60 days
- cost/use hints only
- not an authority

It can suggest candidate model slugs, but the resolved route still has to be explicit and still passes route policy/open-mode handling.

### Runtime consumes resolved routes

By the time `dispatch.js`, `review-runner.js`, or advisory worker invokes a CLI, the model field should already be one of:

- `null` for managed model-less actors;
- an explicit provider/model route;
- an operator-supplied raw value that is intentionally passed through with a warning in open mode.

Runtime should not maintain a hidden alias table. If it sees a non-route model for an unmanaged actor in strict mode, the failure should point to `relay-config resolve-model` or preset setup.

## Proposed UX

### CLI: resolve-model

Add a deterministic resolver command:

```bash
node skills/relay-config/scripts/relay-config.js resolve-model \
  --phase review --reviewer opencode --model glm-5.2 --json
```

Example JSON:

```json
{
  "ok": true,
  "phase": "review",
  "actor_field": "reviewer",
  "actor": "opencode",
  "input": "glm-5.2",
  "resolved_model": "opencode-go/glm-5.2",
  "source": "live_model_list",
  "candidates": ["opencode-go/glm-5.2"],
  "warnings": []
}
```

Ambiguous result:

```json
{
  "ok": false,
  "error_code": "ambiguous_model",
  "input": "glm",
  "candidates": ["opencode-go/glm-5.1", "opencode-go/glm-5.2"],
  "next_action": "choose one candidate or pass a provider/model route"
}
```

Probe failure with catalog fallback:

```json
{
  "ok": true,
  "phase": "advisory_review",
  "actor": "cline",
  "input": "glm-5.2",
  "resolved_model": "cline-pass/glm-5.2",
  "source": "catalog_hint",
  "warnings": [
    "cline has no reliable model-list command; catalog hints are stale-prone"
  ]
}
```

### Preset creation

Allow compact preset inputs to resolve before writing:

```bash
node skills/relay-config/scripts/relay-config.js preset add light \
  --dispatch opencode:glm-5.2 \
  --advisory-review cline:glm-5.2 \
  --json
```

Persisted `routes.json` should contain resolved routes:

```json
{
  "presets": {
    "light": {
      "dispatch": { "executor": "opencode", "model": "opencode-go/glm-5.2" },
      "advisory_review": { "reviewer": "cline", "model": "cline-pass/glm-5.2" }
    }
  }
}
```

The command output should include `model_resolution` metadata, but the durable preset stores the explicit route.

### /relay natural language

The top-level relay skill should route model-name requests through configuration/intent shaping:

- If the user names an actor and model, resolve the model before dispatch/review.
- If the user names only a model, ask for actor or list relevant presets.
- If a preset matches the natural-language intent, use `--route-preset`.

Examples:

- "review with opencode glm-5.2" -> resolve `opencode + glm-5.2`, then pass `--reviewer opencode --reviewer-model <resolved route>`.
- "review with glm-5.2" -> ask whether to use opencode, pi, cline advisory, or an existing preset.
- "make a light preset with glm-5.2" -> ask for executor actor unless one is already configured as a default.

## Resolution Algorithm

Inputs:

- phase: `dispatch`, `review`, or `advisory_review`;
- actor field: `executor` or `reviewer`;
- actor name;
- model input;
- optional provider prefix;
- effective routes config and strict/open mode;
- installed CLI probe data.

Steps:

1. If model is empty:
   - managed actor -> return `null`;
   - unmanaged actor -> try configured actor default;
   - otherwise return `missing_model`.
2. If model already contains `/`, treat it as an explicit provider/model route.
3. If the actor has a reliable live model-list command:
   - run a bounded probe, optionally filtered by the model input;
   - normalize comparison case-insensitively and treat spaces, hyphens, and underscores as equivalent;
   - exact normalized match wins;
   - one fuzzy candidate wins only when the match is unambiguous;
   - multiple candidates produce `ambiguous_model`.
4. If live probe fails or is not available:
   - if the user asked for recommendation or supplied a fuzzy slug, consult the catalog;
   - adapt the slug to a provider prefix only when the provider context is known;
   - mark `source: catalog_hint` and include a stale warning.
5. Evaluate the resolved route against route config:
   - strict mode unregistered route -> fail with `route_unregistered`;
   - open mode unregistered route -> allow with warning, preserving existing `UNREGISTERED_ROUTE_USED` behavior;
   - denied route -> fail.
6. Return JSON with source, candidates, warnings, and next action.

## Audit and Observability

Every place that resolves a model should expose:

- original input;
- actor and phase;
- resolved provider/model route;
- source: `explicit_route`, `live_model_list`, `configured_default`, `catalog_hint`, or `operator_choice`;
- candidate list when ambiguous;
- probe warning when a live list failed;
- policy decision or registration status.

Route-plan snapshots should record resolved routes, not fuzzy inputs. If a fuzzy input was resolved during route-intent shaping, include `model_resolution` metadata beside the phase.

## Error Handling

| Error | Meaning | Suggested user-facing action |
| --- | --- | --- |
| `missing_actor_context` | Model slug supplied without executor/reviewer/provider context. | Ask which actor or preset to use. |
| `missing_model` | Unmanaged actor selected without model or default. | Run `relay-config resolve-model` or set an actor default. |
| `probe_failed` | Live model list timed out or errored. | Retry with a higher probe timeout or use catalog hint explicitly. |
| `ambiguous_model` | Fuzzy input matched multiple live candidates. | Ask user to choose one candidate. |
| `unknown_model` | No live/catalog candidate matched. | Ask for explicit provider/model route. |
| `route_unregistered` | Strict mode blocks the resolved route. | Add the route or use an allowed preset. |

## Issue Breakdown

### Issue 1: Core model resolver module and CLI

Add a shared resolver under relay-config/relay-dispatch scripts and expose `relay-config resolve-model`.

Acceptance criteria:

- Resolves explicit provider/model routes as pass-through.
- Resolves `glm-5.2` for `opencode`/`pi` from live probe fixtures.
- Reports ambiguity with candidate list.
- Reports probe failure without hiding installed CLI status.
- Does not consult catalog for managed Codex/Claude or Reasonix-style direct routes.
- JSON output includes `source`, `warnings`, and `policy_decision` or registration status.

### Issue 2: Catalog fallback following delegate convention

Add an install-carried model catalog for relay-config with strict fallback rules.

Acceptance criteria:

- Catalog has `Last checked:` and 60-day stale warning.
- Catalog is used only when live probe is unavailable/failed or the user asks for recommendation.
- Cline `glm-5.2` can resolve to `cline-pass/glm-5.2` with `source: catalog_hint` and warning.
- Catalog suggestions never auto-register routes.

### Issue 3: Preset creation resolves compact actor:model input

Teach `relay-config preset add` to accept short model slugs and persist resolved routes.

Acceptance criteria:

- `--dispatch opencode:glm-5.2` writes a provider/model route, not the slug.
- `--advisory-review cline:glm-5.2` writes the ClinePass provider/model route with catalog warning.
- Strict mode warns or fails according to existing preset validation rules.
- Command output includes model resolution metadata.
- Existing explicit provider/model preset inputs remain unchanged.

### Issue 4: /relay natural-language model handling

Update relay skill instructions so natural-language model requests go through resolver/preset flow.

Acceptance criteria:

- Actor plus model request becomes explicit dispatch/review flags with resolved route.
- Model-only request asks for actor or lists presets; it does not guess.
- Existing route-preset mapping remains the preferred path for named intents like light/diverse/hardened.
- SKILL.md stays under 150 lines.

### Issue 5: Route-plan and event observability

Record model resolution provenance where route intent is shaped.

Acceptance criteria:

- Route-plan phase snapshot stores resolved model route.
- `model_resolution` metadata includes input, source, candidates, and warnings.
- `UNREGISTERED_ROUTE_USED` continues to record the resolved provider/model route.
- No low-level executor/reviewer adapter performs hidden aliasing.

## Open Questions

- Should `resolve-model` support provider-only syntax such as `cline-pass:glm-5.2`, or require actor context only?
- Should live model-list results be cached per command invocation, per session, or only inside `relay-config doctor` output?
- Should open mode allow catalog-hint routes without confirmation, or should catalog fallback always require an explicit user acknowledgement?
- Which actor owns Pi routes when the live provider is `opencode-go`? The resolver should report the actor separately from the provider prefix to avoid policy confusion.

## Recommended Delivery Order

1. Core resolver CLI with live probe fixtures.
2. Catalog fallback and Cline no-list behavior.
3. Preset creation integration.
4. /relay instruction update.
5. Route-plan observability.

This order keeps runtime dispatch/review unchanged until route-intent shaping has a deterministic resolver.
