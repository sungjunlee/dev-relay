---
id: RELAY-782
title: 'Route presets: --route-preset, /relay natural-language mapping, model catalog (Phase B)'
status: To Do
labels:
  - enhancement
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Context

Design: [docs/route-config-simplification-design.md](../blob/main/docs/route-config-simplification-design.md) (Phase B). Depends on Phase A (#781: unified routes.json with `presets`).

Per-run routing intent today costs three remembered flags (`--executor --model --advisory-reviewer ...`). Presets make it one word, and `/relay` maps natural language onto that word.

## Scope

1. **`dispatch.js --route-preset <name>`.** Expands the named preset from merged routes config into *unset* run-intent fields; explicit flags always win. Unknown preset → error listing available presets. Preset `review_assurance` maps to the existing `--review-assurance` path. Route-plan snapshot records `source: "preset:<name>"` per filled field.
2. **Advisory selection via preset.** `review-runner.js` consumes preset-provided `advisory_review` through the existing routing-decision channel — no new reviewer flags.
3. **`/relay` natural-language mapping.** SKILL.md table: "가볍게/싸게/light" → `--route-preset light`, "리뷰 다양하게/diverse" → `diverse`, "하드하게/hardened" → `hardened`; when no word matches, list presets from routes config instead of guessing.
4. **relay-config preset CRUD.** `preset add|remove|show` + conversational flow ("light preset 만들어줘: opencode + spark"). Creation validates referenced routes: warn when the executor CLI is missing or (strict) the route is unregistered.
5. **`skills/relay-config/references/model-catalog.md`.** Delegate-skill convention, copied not referenced: `Last checked:` date, stale-after-60-days note, cost-hint column, explicit non-authority disclaimer. Consulted only when live model-list probes fail or the user asks for a recommendation.

## Acceptance Criteria

- [ ] `--route-preset light` alone dispatches the preset executor+model; `--route-preset light --executor codex` dispatches codex (flag precedence).
- [ ] Preset expansion visible in route-plan snapshot with per-field `source: "preset:light"`.
- [ ] Unknown preset name fails with the available-preset list (no partial dispatch).
- [ ] A preset carrying `advisory_review` causes review-runner to start the advisory lane without extra flags.
- [ ] `/relay` SKILL.md contains the natural-language → preset mapping table (full repo suite guards prose contracts).
- [ ] model-catalog.md carries date, staleness note, and non-authority disclaimer.

## Dependencies

Blocked by Phase A (#781). Related: #109 (per-phase model hints — presets deliver the per-run cost/quality intent it described at the bundle level).

