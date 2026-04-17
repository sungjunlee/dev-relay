---
id: RELAY-143
title: 'relay-plan: retrospective integration with qualitative annotations'
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

Build on #139 (reliability-report consumption) by adding qualitative annotations to run retros — which rubric design choices correlated with fast convergence, which factor types stall most, what fix_hints actually helped.

## Motivation

From \`docs/agentic-patterns-adoption.md\` Phase 2.1. #139 exposes quantitative data; this issue adds interpretable signal on top.

Codex correctly warned: "Adding run_retro.notable mostly creates unstructured sludge." The mitigation: only emit retro annotations when the data supports a specific interpretation (e.g., "fix_hint on error-recovery correlated with -2 rounds to green across 5 runs this sprint") — no free-text sludge.

## Depends On

- **#139** (reliability-report consumption) — qualitative layer sits on top of quantitative data

## Related

- **#15** (rubric-builder: self-improving rubrics via autoloop) — longer-term vision this feeds into

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] \`finalize-run.js\` emits structured retro event on merge (schema: review_rounds, rubric_grade, stuck_factors, fix_hint_effectiveness)
- [ ] reliability-report.js aggregates retro events into "qualitative signals" section
- [ ] Signals gated on minimum sample size (N>=3 runs) — no single-run inferences
- [ ] No LLM-generated free-text narrative — structured fields only
- [ ] Consumed by relay-plan via #139's consumption path — planner sees qualitative signals alongside raw metrics
<!-- AC:END -->

## Context

- Design doc: \`docs/agentic-patterns-adoption.md\` Phase 2.1
- Replaces (and absorbs) the original doc's Proposal #4
