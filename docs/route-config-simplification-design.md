# Route Config Simplification — Design / PRD

Status: proposal (2026-07-05)
Supersedes in part: `docs/model-route-policy.md` (default posture, storage layout, config UX). The policy gate evaluation semantics in that doc remain valid for strict mode.

## Problem

dev-relay can already route dispatch/review/advisory work to codex, claude, opencode, pi, antigravity, and cursor. The plumbing exists at four layers (policy gate, defaults precedence, tag routing rules, task profile), but choosing an agent per run is still hard in practice:

1. **Config skills are never invoked spontaneously.** `relay-config` exists and covers policy setup, yet nothing in the operational surfaces points to it: `relay`, `relay-plan`, `relay-dispatch`, `relay-review` SKILL.md files and the dispatch/review error paths contain zero references to it. Evidence: the skill's own author asked for "a config skill" without remembering it exists.
2. **Config drifts into a half-finished state and nothing surfaces it.** Observed live state: a personal policy with opencode routes registered, but no default model (`~/.relay/executors.json` absent, so every opencode dispatch needs an explicit `--model`), pi installed but `policy-disallowed`, advisory review unset, model probes timing out.
3. **The fail-closed default punishes the common case.** With no config, unmanaged executors are denied before spawn. For a personal setup, an explicit "use pi for this" request being blocked by a local JSON file is friction, not protection. `policy.json` is not a real security boundary (same-user local file); its honest role is an accident guard.
4. **Per-run expression is three flags.** `--executor opencode --model openai/... --advisory-reviewer pi` must be remembered; there is no one-word unit for a routing intent like "cheap" or "diverse review".
5. **Two files, two schemas, five-deep precedence.** `~/.relay/policy.json` (global policy), `~/.relay/projects/<slug>/routes.json` (project defaults), plus `~/.relay/executors.json` (default models) each hold a slice of one mental model: "which agent runs what".

## Goals

- One user-facing concept: **routes**. Registering a route is allowing it. No separate "policy" vocabulary in any user-facing surface.
- Open by default: an explicitly requested executor + explicit model runs even when unregistered, with a warning event and route-plan snapshot. Fail-closed becomes opt-in (`strict: true`).
- One file schema across scopes: global `~/.relay/routes.json` and project `~/.relay/projects/<slug>/routes.json` share a schema; project overrides global per field.
- Presets: named route bundles selectable with one word (`--route-preset light`) and by natural language through `/relay`.
- Friction-point wiring: every route denial, unresolved model, or uninstalled executor error points to `relay-config`.
- Revise mode: "점검해줘" produces a gap report (config ↔ installed CLIs ↔ usage) with interactive amendment proposals.
- Fold `~/.relay/executors.json` (default models) into routes config: three files become one.

## Non-goals

- Automatic difficulty-based primary routing (tag → executor). Deferred to Phase D, observe-gated.
- Multi-reviewer consensus / vote mechanics. Advisory lane stays as-is.
- Treating routes config as a security boundary. Strict mode is an accident guard; real enforcement is credentials/network.
- Changing adapter capability checks, manifest role bindings, or the review state machine.

## Design

### The routes file

One schema, two scopes. Global: `~/.relay/routes.json`. Project: `~/.relay/projects/<slug>/routes.json` (existing path, schema upgraded). Project values override global per field; arrays (`routes`, `denied_routes`) concatenate; `presets` merge by name with project winning.

```jsonc
{
  "version": 2,
  "strict": false,                      // true = fail-closed gate (company mode)
  "defaults": {
    "dispatch":        { "executor": "codex" },
    "review":          { "reviewer": "codex" },
    "advisory_review": null
  },
  "executor_defaults": {                // subsumes ~/.relay/executors.json
    "opencode": { "model": "openai/gpt-5.3-codex-spark" }
  },
  "routes": [                           // registered = allowed
    { "route": "openai/gpt-5.3-codex-spark", "phases": ["dispatch"], "executors": ["opencode"] },
    { "route": "opencode-go/*",              "phases": ["review"],   "reviewers": ["opencode"] }
  ],
  "denied_routes": [],                  // always enforced, even when strict=false
  "presets": {
    "light":    { "dispatch": { "executor": "opencode", "model": "openai/gpt-5.3-codex-spark" } },
    "diverse":  { "advisory_review": { "reviewer": "pi", "profile": "blindspot" } },
    "hardened": { "review_assurance": "hardened",
                  "advisory_review": { "reviewer": "opencode" } }
  }
}
```

Notes:

- `version: 2` distinguishes the unified schema from the existing project routes `version: 1`. The loader accepts `version: 1` project files (current shape is a subset).
- Route entries keep the `allowed_model_routes` field shape (`route`, `phases`, `executors`/`reviewers`) so the in-memory mapping to the existing gate is mechanical.
- `presets` values use the same phase-selection shape as `defaults`, plus optional `review_assurance`.

### Engine: no derived file

`relay-policy.js` gains a loader path that reads routes files directly and produces the policy-shaped object **in memory**:

- `routes[]` → `allowed_model_routes`
- `strict` → `deny_unknown_model_routes`
- `defaults` → `defaults`
- `denied_routes` → `denied_model_routes`

`evaluateRelayRoute()` is unchanged. No generated `policy.json` on disk — generation would reintroduce drift between two files, which is the disease being treated.

**Open-mode gate semantics.** When `strict: false` and the effective tuple does not match a registered route:

- the run proceeds;
- `policy_decision` records `allowed: true, reason: "unregistered_route_open_mode"`;
- dispatch/review append an `UNREGISTERED_ROUTE_USED` event (added to the frozen EVENTS enum; consumers: the revise-mode gap report and `reliability-report`);
- the route-plan snapshot records the unregistered tuple as today.

`denied_routes` and adapter capability checks are enforced in both modes. `strict: true` reproduces today's fail-closed behavior exactly.

**Legacy loading order.**

1. `~/.relay/routes.json` exists → it is the source of truth; `policy.json` and `executors.json` are ignored (revise mode flags them for deletion).
2. Otherwise `~/.relay/policy.json` (and repo `.relay/policy.json`) load with current semantics — existing users keep fail-closed behavior until they migrate.
3. Neither exists → built-in open default: managed CLIs (`codex`, `claude`, `cursor`) model-less, `defaults.dispatch.executor: codex`, `strict: false`.

Step 3 is a **behavior change**: today's no-config default denies unmanaged executors; the new default allows an explicitly requested executor + model with a warning. Recorded as ADR 0007.

### Precedence (full chain, after this change)

```text
explicit CLI flags (--executor/--model/--reviewer/...)
  → --route-preset expansion (fills only unset fields)
  → run-intent file / manifest model_hints
  → project routes.json (defaults, executor_defaults)
  → global routes.json (defaults, executor_defaults)
  → built-in default (codex)
  → gate: denied_routes always; registration check only when strict
```

One new link (`--route-preset`); everything else is today's chain with policy defaults replaced by routes defaults.

## Phase A — routes single concept + open/strict

Deliverables:

1. `relay-routing.js` / `relay-policy.js`: unified schema loader, scope merge, in-memory gate mapping, open-mode gate result, legacy fallback order.
2. `dispatch.js` + `review-runner.js`: `UNREGISTERED_ROUTE_USED` event emission (EVENTS enum addition + write-time validation test); denial/unresolved errors gain `hint: "run relay-config to register this route"` in both text and JSON (`hint` field).
3. `relay-config` rewrite of user-facing vocabulary: `init`, `allow-route` → `add-route`, `show`, `doctor`, `check` operate on routes.json; "policy" disappears from SKILL.md and help text. `init company` → writes `strict: true` + prompts for routes; `init personal` → `strict: false`.
4. Friction wiring: one-line pointers to `relay-config` in `relay`, `relay-plan`, `relay-dispatch`, `relay-review`, `relay-fleet` SKILL.md (route-related failure sections), and in `/relay`'s dispatch step: if the user names an executor whose route/model cannot resolve, invoke relay-config inline (one question → write → continue) instead of failing.
5. Docs: ADR `docs/decisions/0007-routes-single-concept.md` (posture flip + one-concept rationale); `docs/model-route-policy.md` gains a superseded-in-part banner pointing here.

Acceptance sketch:

- No config: `dispatch --executor pi --model <route>` runs, emits `UNREGISTERED_ROUTE_USED`, snapshot records the tuple.
- `strict: true`: same invocation is denied before spawn with the relay-config hint (byte-parity with today's denial JSON plus `hint`).
- Legacy `policy.json` only (no routes.json): today's behavior preserved verbatim.
- Project `strict: true` overrides global `strict: false` (company repo on a personal machine).
- Full repo test suite passes — `tests/relay-plan` and siblings pin SKILL.md prose (see PR #746 incident); SKILL.md rewording requires the full run.

## Phase B — presets + natural language + model catalog

Deliverables:

1. `dispatch.js --route-preset <name>`: expands the named preset from merged routes config into unset run-intent fields. Unknown preset → error listing available presets. Explicit flags always win. `review_assurance` in a preset maps to the existing `--review-assurance` path.
2. `review-runner.js` reads preset-provided `advisory_review` selection via the existing routing-decision channel (no new reviewer flags).
3. `relay` SKILL.md: natural-language mapping table — "가볍게/싸게/light" → `--route-preset light`, "리뷰 다양하게/diverse" → `diverse`, "하드하게/hardened" → `hardened`; instructs listing presets from routes config when the user's word matches nothing.
4. `relay-config` preset CRUD: `preset add|remove|show` plus conversational flow ("light preset 만들어줘: opencode + spark"). Preset creation validates that referenced routes resolve (warn when the executor CLI is not installed or, under strict, the route is unregistered).
5. `skills/relay-config/references/model-catalog.md` following the delegate skill's convention: `Last checked:` date, "treat as stale after 60 days", cost-hint column, explicit non-authority note. Consulted only when live model-list probes fail or the user asks for a recommendation. (Convention copied, not referenced — dev-relay installs must stay self-contained.)

Acceptance sketch:

- `--route-preset light` alone dispatches opencode with the preset model; `--route-preset light --executor codex` dispatches codex (flag wins).
- Preset expansion appears in the route-plan snapshot with `source: "preset:light"` per field.
- `/relay` with "이거 가볍게 처리해줘" reaches dispatch with `--route-preset light` (SKILL.md contract test keeps the mapping table present).

## Phase C — revise mode

Deliverables:

1. `relay-config gaps --json` (deterministic core): emits a machine-readable gap list comparing merged routes config, installed CLIs (existing inspect probes), and usage evidence (events + reliability-report). Gap types:
   - `installed_cli_unrouted` — CLI on PATH, no route/registration (today's pi).
   - `route_without_cli` — registered route whose executor/reviewer CLI is missing.
   - `executor_missing_default_model` — routes exist but `executor_defaults` lacks a model (every dispatch needs `--model`).
   - `legacy_config_present` — `policy.json` / `executors.json` still loaded or shadowed; migration proposal attached.
   - `preset_broken` — preset references an uninstalled CLI or (strict) unregistered route.
   - `unregistered_route_in_use` — `UNREGISTERED_ROUTE_USED` events seen for a stable tuple; propose registering it.
   - `probe_failure` — model-list probe errored (surfaced, not diagnosed).
2. `relay-config` SKILL.md revise workflow: run `gaps --json` → present each gap with its concrete proposal in plain language → apply accepted ones via existing subcommands (`add-route`, `preset add`, `set-default`, migration write) → `doctor` to verify. Triggered by "설정 점검/리바이즈해줘" or by the `legacy_config_present` migration path.
3. Migration: `relay-config migrate` folds `policy.json` + `executors.json` + project `routes.json` v1 into unified files, prints a diff-style summary, and asks before writing. Legacy files are left in place with a `.migrated` marker note in the summary (deletion is proposed by the next `gaps` run, never automatic).

Acceptance sketch: on the currently observed machine state, `gaps --json` reports at minimum `installed_cli_unrouted` (pi), `executor_missing_default_model` (opencode), `legacy_config_present` (policy.json), and two `probe_failure` entries.

## Phase D — stub (observe-gated)

Direction only; no implementation in this arc:

- `relay-plan` emits `route_recommendation` in the handoff summary (task_profile size/risk + registered routes + reliability history), advisory-only.
- `relay-fleet` planning fills per-leaf `executor`/`model` fields from the same recommendation — the highest-value site for difficulty-mix routing since leaves vary in difficulty and the fields already exist.
- Gate to open: A–C shipped **and** observed preset/route-override usage (≥ ~10 runs using non-default routes over ~4 weeks, from `UNREGISTERED_ROUTE_USED` + route-plan snapshots). The sidecar precedent (#694: six PRs, zero use, deleted) is the reason this is a stub.
- Separate observation: if strict mode shows no adoption after A–C settle, physically remove `policy.json` support and the profile vocabulary in a later cleanup.

## Risks and counterpoints

- **Default-posture flip is a semantic change.** Mitigated: legacy `policy.json` holders keep fail-closed until they migrate; the change applies only to the no-config case; ADR + changelog entry required.
- **Open mode weakens the accident guard.** A hallucinated-but-valid provider route would run. Accepted for personal default: warning event + snapshot preserve auditability, `denied_routes` still hard-blocks, and strict mode exists for environments that need the gate. The realistic failure (typo model id) fails at the provider CLI anyway.
- **Same filename, two schema versions** (`routes.json` v1 project vs v2 unified). Mitigated by the version field, loader acceptance of v1, and a `gaps` migration proposal.
- **SKILL.md prose is pinned by sibling test suites** (PR #746 incident). Every phase that rewords SKILL.md runs the full repo suite, not just the touched skill's tests.
- **relay-config wrapper vs core script split** (`skills/relay-config/scripts/relay-config.js` delegating to `skills/relay-dispatch/scripts/relay-config.js`): vocabulary rename must land in both; cli-schema tests updated together. Deprecated `allow-route` alias kept for one release per the flag-sunset rule.
- **Probe timeouts** (opencode/pi `ETIMEDOUT` at 5s) are a pre-existing defect, filed separately; `gaps` reports them as `probe_failure` rather than blocking on them.

## Delivery order

A → B → C as separate relay-sized issues (A is the substrate; B is the biggest UX win; C depends on A's unified loader). D and the strict-mode sunset are follow-up issues carrying their observation gates in the issue body.
