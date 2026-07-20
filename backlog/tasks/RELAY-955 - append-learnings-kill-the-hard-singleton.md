---
id: RELAY-955
title: 'append-learnings: kill the hard singleton (--sprint/--track + thread from finalize-run)'
status: To Do
labels:
  - enhancement
  - backlog
  - workflow
priority: high
milestone: 2026-07 multi-track sprint interop
component: merge-finalize
created_date: '2026-07-20'
---
## Description

Replace relay-merge's global active-sprint assumption with an explicit owning-track contract that works for standalone and fleet runs.

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] `append-learnings` accepts explicit sprint, track, and component handles and resolves them in that precedence before any fallback.
- [ ] A standalone merge derives the issue component and consumes dev-backlog `sprint-state.js --component --json` to resolve the owning sprint.
- [ ] `finalize-run` threads the resolved owner into `appendLearnings`; the seam also accepts the pre-dispatch fleet owner added by #957.
- [ ] Exactly one active sprint remains a compatible no-flag fallback; multiple active sprints fail only when no explicit or derived owner resolves.
- [ ] Relay adds no independent sprint markdown resolver for track/component ownership.
- [ ] Learnings durability does not depend on the canonical checkout's current branch and integrates safely with the remote default branch after the PR merge, covering `unexpected_branch` and non-fast-forward push races.
- [ ] Tests cover disjoint concurrent tracks, each resolution source and precedence, standalone issue derivation, the fleet handle seam, single-active compatibility, unresolved multi-active failure, and branch/race-independent durability.
<!-- AC:END -->

## Dependencies

- `sungjunlee/dev-backlog#291` (closed)

## Related

- Parent #954
- Enables #957
