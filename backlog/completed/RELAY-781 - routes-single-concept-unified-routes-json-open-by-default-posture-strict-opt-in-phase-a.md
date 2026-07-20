---
id: RELAY-781
title: 'Routes single concept: unified routes.json, open-by-default posture, strict opt-in (Phase A)'
status: Done
labels:
  - enhancement
  - epic
  - workflow
priority: high
milestone: Route Config Simplification
created_date: '2026-07-05'
---
## Description
## Context

Design: [docs/route-config-simplification-design.md](../../docs/route-config-simplification-design.md) (Phase A). Supersedes in part `docs/model-route-policy.md`.

The route plumbing exists at four layers, but the user-facing model is fragmented across `~/.relay/policy.json`, `~/.relay/projects/<slug>/routes.json`, and `~/.relay/executors.json`, and the no-config default is fail-closed for unmanaged executors — which is why a live machine ended up with pi installed but `policy-disallowed` and opencode routes registered but model-less. Nothing in the operational surfaces points to `relay-config` (zero references outside the skill itself).

## Scope

1. **Unified routes schema (v2), two scopes.** Global `~/.relay/routes.json` + project `~/.relay/projects/<slug>/routes.json` share one schema: `strict`, `defaults`, `executor_defaults` (subsumes `executors.json`), `routes` (registered = allowed), `denied_routes`, `presets` (consumed in Phase B). Project overrides global per field; arrays concatenate; loader accepts existing project v1 files.
2. **Engine reads routes directly — no derived file.** `relay-policy.js`/`relay-routing.js` map routes config to the policy-shaped object in memory (`routes[]` → `allowed_model_routes`, `strict` → `deny_unknown_model_routes`). `evaluateRelayRoute()` unchanged.
3. **Open-by-default posture.** `strict: false`: an unregistered effective tuple proceeds with `policy_decision.reason = "unregistered_route_open_mode"`, an `UNREGISTERED_ROUTE_USED` event (frozen EVENTS enum addition; consumers: Phase C gaps report, reliability-report), and the usual route-plan snapshot. `denied_routes` and adapter capability checks enforced in both modes. `strict: true` reproduces today's fail-closed behavior.
4. **Legacy loading order.** routes.json present → single source of truth. Else policy.json (global + repo) with current semantics — existing holders keep fail-closed until migrating. Neither → built-in open default (managed CLIs, codex defaults, `strict: false`).
5. **relay-config vocabulary rewrite.** `add-route` (keep `allow-route` alias one release), `show`, `doctor`, `check`, `init company|personal` (company = `strict: true`) operate on routes.json; "policy" disappears from user-facing text. Both wrapper and core script.
6. **Friction wiring.** Route denial / unresolved-model / uninstalled-executor errors in `dispatch.js` and `review-runner.js` gain a `hint` ("run relay-config to register this route") in text + JSON. One-line relay-config pointers in `relay`, `relay-plan`, `relay-dispatch`, `relay-review`, `relay-fleet` SKILL.md failure sections. `/relay`: when a named executor's route/model cannot resolve, invoke relay-config inline instead of failing.
7. **Docs.** ADR `docs/decisions/0007-routes-single-concept.md` (posture flip rationale); superseded-in-part banner on `docs/model-route-policy.md`.

## Acceptance Criteria

- [x] No config: `dispatch --executor pi --model <route>` runs, emits `UNREGISTERED_ROUTE_USED`, route-plan snapshot records the tuple.
- [x] `strict: true`: same invocation denied before spawn, denial JSON byte-parity with today plus `hint` field.
- [x] Legacy `policy.json` only (no routes.json): current behavior preserved verbatim (existing policy tests pass unmodified).
- [x] Project `strict: true` overrides global `strict: false`.
- [x] `executor_defaults` supplies the model where `~/.relay/executors.json` used to (and wins over it when both exist... routes.json presence ignores executors.json entirely per loading order).
- [x] EVENTS enum addition has write-time validation coverage.
- [x] Full repo test suite passes (sibling suites pin SKILL.md prose — PR #746 incident).

## Dependencies

Blocks #782 (Phase B presets) and #783 (Phase C revise mode). Probe timeout defect tracked separately in #784. Related prior art: #109 (per-phase model hints — partially shipped as `model_hints`), #22 (cross-model review).

Completion evidence: Phase A shipped through PRs #792, #804, and #811; GitHub issue #781 is closed.

