---
milestone: 2026-07 multi-track sprint interop
status: active
started: 2026-07-20
due: TBD
objectives: []
component: "merge-finalize"
---

# multi-track-sprint-interop

## Goal

Relay resolves and carries an owning sprint track explicitly across standalone finalize, operator prose, and fleet dispatch, so concurrent component-partitioned sprints no longer lose Learnings or update the wrong sprint.

## Plan

### Batch 0 — eliminate the finalize singleton

- [ ] #955 append-learnings: resolve and carry the owning sprint without canonical-checkout branch dependence

### Batch 1 — align operator contracts

- [ ] #956 relay-merge/relay prose: resolve the owning sprint for every read/write

### Batch 2 — carry track ownership through fleets

- [ ] #957 relay-fleet: tag leaves before dispatch and reject or route mixed-track fleets

### Batch 3 — integration proof and epic closeout

- [ ] #954 verify standalone and fleet multi-track behavior, reconcile mirrors, and close the epic

## Running Context

- Dependency `sungjunlee/dev-backlog#291` is closed and its source checkout exposes `sprint-state.js --track/--component --json`. The globally installed dev-backlog skill may lag that source; implementation and tests must consume the JSON contract through an explicit, testable resolver seam rather than assume one installation path.
- Resolution precedence for #955 is explicit sprint/track/component handle → merged issue `component:` resolved through dev-backlog → single-active fallback only when exactly one sprint is active.
- PR #981 and the #1036 finalize of PR #1048 reproduced the same durability class: learnings/finalize can depend on the canonical checkout's current branch or lose a push race against the just-merged remote commit. #955 must remove current-branch dependence and durably integrate against the fetched remote default branch.
- Execute in strict dependency order `#955 → #956 → #957 → #954`. Use the cursor executor + cline adversarial advisory route for #955 as the first real hardened-gate proof after #1040, subject to normal environment probe and review gates.
- Keep N==1 behavior unchanged, add no second relay-side sprint markdown parser, and preserve explicit failure when N>1 has no resolvable owner.

## Progress

- 2026-07-21: Activated after #1036 merged in PR #1048. Live GitHub recheck confirmed #954–#957 remain open under milestone #13 and dev-backlog#291 is closed.
