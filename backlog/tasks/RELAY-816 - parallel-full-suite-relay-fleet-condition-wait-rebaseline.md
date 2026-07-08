---
id: RELAY-816
title: 'Full-suite node --test file concurrency flakes relay-fleet condition waits'
status: To Do
labels:
  - bug
  - workflow
priority: high
milestone: Route Config Simplification
created_date: '2026-07-06'
---
## Description

After #819 and #815, rebaseline the parallel full-suite flake report. If current `main` no longer flakes, close with evidence. If relay-fleet condition waits still fail under normal parallel load, widen only the root-caused eventually-consistent waits or split fleet into a serial step.

## Acceptance Criteria

- [ ] Rebaseline current `main`: relay-fleet solo and at least one canonical parallel full-suite attempt, with fixture-process pgrep before/after.
- [ ] If no failure reproduces, comment evidence and close without code changes.
- [ ] Any widened wait window has a short deflake justification.
- [ ] Document command shape only if it changes.
- [ ] Final evidence confirms no `relay-codex` / `relay-final-gate` / `relay-child` fixture processes survive.
