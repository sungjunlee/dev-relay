---
id: RELAY-141
title: 'relay-review: structured rejection log in redispatch prompt'
status: To Do
labels:
  - enhancement
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Extend `formatPriorVerdictSummary()` in review-runner.js to emit per-factor structured rejection reasoning. Re-dispatch prompt gains "Previously rejected approaches" section so the executor doesn't repeat rejected patterns.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 1.1. Re-dispatch already carries prior-round data, but unstructured narrative loses per-factor granularity. When round 2 rejects a specific approach to error handling, round 3 should know exactly what was tried and why it failed.

**Trustworthy producer**: the reviewer is independent and anchored to rubric, so rejection reasoning is verifiable (unlike a planner emitting "decision rationale" — see the killed #1a in the design doc).

## Depends On

- **#138** (rubric persistence mandatory) — reviewer must have rubric access to emit factor-scoped rejections

## Current State

- `review-runner.js:706-744` (`buildRedispatchPrompt`) calls `readPriorVerdicts()` + `formatPriorVerdictSummary()`
- Format is narrative; factor granularity lost in round-to-round replay

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] review-round-N-verdict.json schema extended with per-factor `issues[]`: `{factor, issue, fix_direction, attempted_approach}`
- [ ] `formatPriorVerdictSummary` emits "Previously rejected approaches" section grouped by factor
- [ ] Re-dispatch prompt shows the last 1-2 rejections per factor (not all history — noise)
- [ ] Regression test: existing single-round review still works
- [ ] Regression test: multi-round re-dispatch preserves factor continuity
<!-- AC:END -->

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 1.1
- Related: cleaner re-dispatch reduces stuck_factor metrics (consumed via #139)
