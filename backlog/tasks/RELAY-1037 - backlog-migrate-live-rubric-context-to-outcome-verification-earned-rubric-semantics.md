---
id: RELAY-1037
title: 'backlog: migrate live rubric context to Outcome/Verification/Earned Rubric semantics'
status: To Do
labels:
  - documentation
  - enhancement
  - backlog
  - workflow
priority: medium
milestone: 2026-07 Assurance and Calibration Integrity
created_date: '2026-07-19'
---
## Description
## Problem

The live backlog context still carries pre-#1025 assumptions that treat a rubric as a mandatory shared planner/executor/reviewer contract. GitHub issues #138–#146 are closed, but their local task mirrors remain under `backlog/tasks/` with `status: To Do`. This can steer future agents back toward mandatory rubric transport, Quality Card machinery, forced templates, and TDD suggestions that the risk-adaptive redesign deliberately replaced or narrowed.

## Direction

Migrate only live operator/backlog context to the current three-channel model. Preserve historical documents as history.

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] `backlog/sprints/_context.md` states that Outcome Contract and Verification are the mandatory execution contract.
- [ ] The context states that Earned Rubric is optional, observation-derived, and scored only by the independent reviewer.
- [ ] The context no longer describes executor self-scoring, mandatory rubric factor counts, Quality Card output, or test/build success as quality value.
- [ ] Local task mirrors for closed GitHub issues #138–#146 are moved from `backlog/tasks/` to `backlog/completed/` with their historical content preserved.
- [ ] Any live cross-reference to removed `quality-card.js` or mandatory `anchor.rubric_path` semantics is corrected; archived design/history files are not rewritten merely to match current policy.
- [ ] Exactly one active sprint remains and its plan/progress are not silently broadened.
- [ ] Backlog status/objective/component checks and skill reachability/lint checks remain green.
<!-- AC:END -->

## Verification

- Confirm GitHub #138–#146 are closed before moving mirrors.
- Search live (non-archive) context for stale mandatory-rubric and Quality Card claims.
- Run the dev-backlog status/consistency checks and relevant documentation contract tests.

## Context

- Follows #1025–#1033.
- This is a small context-hygiene change, not a rewrite of historical rationale or a new rubric implementation.
