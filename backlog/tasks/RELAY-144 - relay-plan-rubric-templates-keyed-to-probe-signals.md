---
id: RELAY-144
title: 'relay-plan: rubric templates keyed to probe signals'
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

Use probe signals (#140) to drive deterministic rubric templates. Project has playwright + jest + tsc strict → apply corresponding factor template. No LLM "autonomy scoring" — template matching only.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 2.2. Codex: "Replace #3 autonomy scoring with rubric templates keyed off actual executable checks present in the repo. Fewer abstractions, more determinism."

## Depends On

- **#140** (probe quality signals in rubric design) — template matching needs signals exposed to planner first
- **#139** (reliability-report consumption) — templates should be informed by historical performance of similar rubrics

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] Template catalog: `skills/relay-plan/references/rubric-templates/` with one file per detected signal combo (e.g., `jest-tsc-strict.yaml`, `pytest-mypy-strict.yaml`)
- [ ] `relay-plan` SKILL.md: after probe, match detected signals to nearest template and offer it as a starting point
- [ ] Planner can accept, modify, or reject the template
- [ ] No auto-apply — template is a suggestion
- [ ] At least 3 templates shipped initially (jest/tsc, pytest/mypy, go-test)
<!-- AC:END -->

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 2.2
