---
id: RELAY-816
title: 'Full-suite node --test file concurrency flakes relay-fleet condition waits'
status: Done
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

- [x] Rebaseline current `main`: relay-fleet solo and at least one canonical parallel full-suite attempt, with fixture-process pgrep before/after.
- [x] If no failure reproduces, comment evidence and close without code changes. (N/A: fleet waits did not reproduce, but the same parallel run reproduced the tracked advisory audit race.)
- [x] Any widened wait window has a short deflake justification. (N/A: no fleet/advisory timeout was widened.)
- [x] Document command shape only if it changes. (No command-shape change.)
- [x] Final evidence confirms no `relay-codex` / `relay-final-gate` / `relay-child` fixture processes survive.

## Completion Evidence

- Environment/time: 2026-07-19, clean WSL2 Linux ext4 clone at `edcff70`, Node v22.22.3.
- Solo command: `node --test tests/relay-fleet/scripts/*.test.js` → 89 passed, 0 failed.
- Parallel command: the current CI test globs with Node's default file concurrency → 2,555 tests, 2,553 passed, 0 failed, 2 skipped.
- Fixture checks before and after found 0 matching `relay-codex`, `relay-final-gate`, or `relay-child` processes.
- No relay-fleet condition-wait failure reproduced. The parallel run separately reproduced the standard gating advisory audit race tracked as #1039 and fixed by PR #1038.
- Durable evidence: [GitHub issue #816 closeout comment](https://github.com/sungjunlee/dev-relay/issues/816#issuecomment-5015561410).
