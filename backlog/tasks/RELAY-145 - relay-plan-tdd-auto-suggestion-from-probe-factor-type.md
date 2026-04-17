---
id: RELAY-145
title: 'relay-plan: TDD auto-suggestion from probe + factor type'
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

When probe detects test infrastructure AND the task has automated contract factors, suggest `tdd_mode: true` in Rubric Quality Card. Planner still decides — no auto-apply.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 2.3. After #142 (TDD mode) ships as opt-in, the planner has to remember to enable it. This issue reduces the forget-factor.

## Depends On

- **#140** (probe quality signals) — need to detect test infra
- **#142** (TDD mode) — `tdd_mode` flag must exist in rubric schema

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] Rubric Quality Card surfaces "TDD suggested: test infra detected (jest) and contract factors have automated checks"
- [ ] Suggestion only — planner explicitly sets `tdd_mode: true` or declines
- [ ] Suggestion is suppressed for S-size tasks (overhead too high)
- [ ] Suggestion is suppressed for non-code tasks (docs, CSS-only)
<!-- AC:END -->

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 2.3
