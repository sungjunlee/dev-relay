---
id: RELAY-140
title: 'relay-plan: consume probe quality signals in rubric design'
status: To Do
labels:
  - enhancement
priority: medium
milestone: Agentic Patterns Phase 0 — Wire What Exists
created_date: '2026-04-12'
---
## Description
## Summary

Surface `probe-executor-env.js` signals to the planner during rubric design. The probe already detects 20+ signals (test frameworks, linters, bundlers, type strictness, CI). None of it reaches the planner's decision-making.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 0.3. Detection exists; consumption doesn't.

**Not** in scope: autonomy scoring (e.g., "strict tsconfig = high autonomy"). Codex flagged this as a "bad proxy." Expose signals as data, not as inferred behavior.

## Current State

- `skills/relay-plan/scripts/probe-executor-env.js:76-158` detects signals across package.json, Makefile, pyproject.toml
- Output consumed by dispatch infra (tool availability) but not rubric design
- `relay-plan` SKILL.md probe step focuses on executor capability, not codebase quality

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `relay-plan` SKILL.md: probe output includes quality signals section
- [ ] Rubric Quality Card surfaces detected signals ("test infra: jest, tsc --noEmit", "lint: eslint, prettier", "CI: GitHub Actions")
- [ ] Planner can reference signals when designing prerequisites (e.g., use `tsc --noEmit` as a prerequisite if detected)
- [ ] No autonomy scoring, no auto-calibration of rubric depth — data exposure only
- [ ] If no signals detected, falls back to "no quality infra detected" message (acceptable, not an error)
<!-- AC:END -->

## Touchpoints

- `skills/relay-plan/scripts/probe-executor-env.js` (extend output structure if needed)
- `skills/relay-plan/SKILL.md` (new probe consumption step)
- Tests: `probe-executor-env.test.js` (if extensions made)

## Design Notes

- Extension: add tsconfig strict detection, mypy strict detection (currently only via dep lists)
- Keep output format backward compatible — dispatch infra consumes it today
- Signals drive **templates** (Phase 2.2), not runtime behavior in this phase

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 0.3
- Codex critique on autonomy scoring: "strict tsconfig + workflow file = high autonomy is a bad proxy." This issue intentionally stops at signal exposure.
