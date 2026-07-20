---
id: RELAY-139
title: 'relay-plan: consume reliability-report output before rubric design'
status: To Do
labels:
  - enhancement
priority: medium
milestone: Agentic Patterns Phase 0 — Wire What Exists
created_date: '2026-04-12'
---
## Description
## Summary

Make `reliability-report.js` output an input to rubric design. The analytics exist (factor met_rate, avg_rounds_to_met, stuck_factor, grade distribution, tier effectiveness, divergence hotspots) but no one reads them during planning. Close the consumption gap.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 0.2. Write-only analytics is waste. The planner should know "factors of type X historically stall at round 3+" before designing a new rubric with similar factors.

Codex: "Proposal #4 duplicates analytics the repo already computes. Adding run_retro.notable mostly creates unstructured sludge." The fix is to consume what exists, not add more.

## Current State

- `skills/relay-dispatch/scripts/reliability-report.js` computes per-factor and aggregate metrics
- Output is JSON or text, callable on demand via `--json`
- No consumer invokes it during planning
- `relay-plan` SKILL.md does not reference it

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `relay-plan` SKILL.md adds a step: run `reliability-report.js --json` before rubric design
- [ ] Report output surfaces "factors that historically stall" and "divergence hotspots" to the planner
- [ ] Rubric Quality Card includes a "historical signal" section (best-effort, no gate)
- [ ] If reliability-report fails (e.g., no prior runs), planner gets clear fallback message, not an error
- [ ] Informational only — does not change rubric structure or gate dispatch
<!-- AC:END -->

## Touchpoints

- `skills/relay-plan/SKILL.md` (new step in process, update Rubric Quality Card schema)
- `skills/relay-dispatch/scripts/reliability-report.js` (verify `--json` output is stable for consumption)
- Tests: reliability-report.test.js (add schema stability test)

## Design Notes

- No automation / auto-suggestion in this issue. Just expose the data. (Auto-suggestion is Phase 2.1.)
- If zero prior runs exist for this repo, report surfaces "no history" cleanly — don't block dispatch.
- Consider: does this call `reliability-report.js` every plan? Cache for 1 hour? No cache initially — runs are infrequent enough.

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 0.2
- Complements #15 (self-improving rubrics) by first making the data accessible to planning
