---
id: RELAY-138
title: 'relay-plan/dispatch: make anchor.rubric_path mandatory and visible end-to-end'
status: To Do
labels:
  - enhancement
priority: medium
milestone: Agentic Patterns Phase 0 — Wire What Exists
created_date: '2026-04-12'
---
## Description
## Summary

Make rubric persistence a required, visible step in the relay lifecycle. Today it's optional and not surfaced in plan/review, which caused the `rubric-lifecycle-gap` issue (prior learning, 2026-04-07): rubric generated in orchestrator context, embedded in dispatch prompt, lost after. Reviewer never sees what was used.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 0.1. This is load-bearing — everything downstream (rejection log, retrospective integration, quality signal consumption) depends on the reviewer being anchored to the same rubric the executor iterated against.

Codex (outside voice) independently confirmed: "The real gap is source-of-truth quality, not event type count. Fix rubric transport and consumption first."

## Current State

- `dispatch.js:557-571` persists rubric when `--rubric-file` is provided (optional)
- `review-runner.js:266-274` loads rubric when `anchor.rubric_path` is present
- Planner can forget `--rubric-file` and dispatch still succeeds
- Reviewer silently falls back to Done Criteria only
- `gate-check.js` does not require `anchor.rubric_path`

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `relay-plan` SKILL.md: rubric persistence is a required step, not optional
- [ ] `dispatch.js` refuses to dispatch without `--rubric-file` (or equivalent)
- [ ] Manifest `anchor.rubric_path` required for `dispatched → review_pending` transition
- [ ] Review prompt (`reviewer-prompt.md` / generated) includes rubric content, not just Done Criteria
- [ ] `gate-check.js` rejects merge when `anchor.rubric_path` is absent (with grandfather flag for old runs — see #TODO grandfathering)
- [ ] Regression test: existing dispatch/review flows still pass with rubric_file provided
- [ ] Regression test: new dispatch without rubric_file surfaces clear error
<!-- AC:END -->

## Touchpoints

- `skills/relay-dispatch/scripts/dispatch.js`
- `skills/relay-dispatch/scripts/relay-manifest.js` (state machine transition validation)
- `skills/relay-review/scripts/review-runner.js` (verify rubric load is always triggered)
- `skills/relay-merge/scripts/gate-check.js`
- `skills/relay-plan/SKILL.md`
- Tests: `dispatch.test.js`, `review-runner.test.js`, `gate-check.test.js`

## Failure Modes

**Critical**: If `anchor.rubric_path` becomes mandatory without grandfathering, existing in-flight runs predating this change get stuck. See TODOS.md: "Rubric grandfathering for runs predating mandatory rubric_path."

## Context

- Prior learning: `rubric-lifecycle-gap` (confidence 9/10, cross-project) — "Root fix is persisting rubric.yaml to run dir via dispatch.js --rubric-file, not adding enforcement layers on top of a missing artifact."
- Design doc: `docs/agentic-patterns-adoption.md` Phase 0.1
- Related: #15 (self-improving rubrics) depends on this — can't self-improve rubrics that don't reach the reviewer
