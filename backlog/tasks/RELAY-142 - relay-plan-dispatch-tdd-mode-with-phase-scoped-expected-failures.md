---
id: RELAY-142
title: 'relay-plan/dispatch: TDD mode with phase-scoped expected failures'
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

Add optional `tdd_mode: true` to rubric schema. When enabled, iteration protocol gains Step 0: write failing test → commit → verify red → proceed to implementation. Prerequisite runner temporarily excludes `tdd_anchor` paths during Step 0.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 1.2. Willison: "Every good model understands 'red/green TDD' as shorthand." Current iteration protocol allows tests and implementation to be written together, producing tests shaped around the implementation rather than the spec.

**Effort upgraded to M** after Codex flagged that phase-scoped expected failures affect CI, review timing, and commit history — this is not a prompt-template-only change.

## Depends On

- **#138** (rubric persistence mandatory) — reviewer must see `tdd_mode` flag in rubric to correctly interpret the branch's intentional red commits

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] Rubric schema accepts `tdd_mode: boolean` and `tdd_anchor: string` per factor
- [ ] Dispatch prompt template gains Step 0 (test-first) block when `tdd_mode: true`
- [ ] Prerequisite runner excludes `tdd_anchor` paths during Step 0 (TDD-aware prerequisite)
- [ ] Step 0's red commit is squashed into final commit on branch history
- [ ] Reviewer prompt explains TDD mode so expected-red commits aren't flagged as broken
- [ ] Opt-in only — planner sets `tdd_mode: true` explicitly (no auto-suggestion here; that's Phase 2.3 / #144)
- [ ] S-size tasks: `tdd_mode: false` by default (red-confirmation overhead too high)
- [ ] Regression test: non-TDD rubrics behave identically to today
- [ ] Integration test: TDD rubric produces red commit → green commit → reviewer passes
<!-- AC:END -->

## Failure Modes

**Critical**: if prerequisite runner exclusion is wrong, TDD's intentionally-failing test breaks the prereq gate silently → wastes an iteration. Integration test must cover this end-to-end with real npm test invocation.

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 1.2
- Codex: "Introduces a temporary known-bad branch state and asks the system to bless failing commits. Affects prerequisite semantics, review timing, CI expectations, and commit-history hygiene."
