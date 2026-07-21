---
milestone: 2026-07 multi-track sprint interop
status: completed
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

- [x] #955 append-learnings: resolve and carry the owning sprint without canonical-checkout branch dependence → PR #1051 (merged)

### Batch 1 — align operator contracts

- [x] #956 relay-merge/relay prose: resolve the owning sprint for every read/write → PR #1052 (merged)

### Batch 2 — carry track ownership through fleets

- [x] #957 relay-fleet: tag leaves before dispatch and reject mixed-track fleets → PR #1055 (merged) [run:issue-957-20260720214029585-15fe71ce]

### Batch 3 — integration proof and epic closeout

- [x] #954 verify standalone and fleet multi-track behavior, reconcile mirrors, and close the epic

## Running Context

- Dev-backlog schema-v2 JSON is the owning-sprint source of truth. Resolution precedence is explicit or fleet owner, then issue `component:`, then the exactly-one-active fallback; relay keeps one shared sprint-state seam and no second track/component markdown parser.
- A fleet is one validated track. The owner persists through leaves, child manifests, dispatch/redispatch, and finalize; missing, contradictory, or mixed ownership fails before fleet manifest, issue lock, worktree, or dispatch side effects.
- Learnings durability is independent of the canonical checkout's current branch and integrates against the fetched remote default branch across non-fast-forward push races.

## Progress

- 2026-07-21: #957 merged via PR #1055 and run `issue-957-20260720214029585-15fe71ce`; #954 integration closeout passed 83/83 standalone/append tests, 3/3 fleet integration tests, and 33/33 skills-lint tests. All four task mirrors and Plan items were reconciled for the normal dev-backlog close path.
- 2026-07-21: #956 merged via PR #1052, establishing the owning-sprint operator contract used by #957.
- 2026-07-21: #955 merged via PR #1051; live durable-learning proof recorded `durability.status=pushed` in one attempt with the canonical checkout untouched. #956 followed as Batch 1.
- 2026-07-21: #955 dispatched through the hardened cursor + cline adversarial route as run `issue-955-20260720171527060-5631994b`; frozen criteria include standalone multi-track resolution and canonical-branch/push-race-independent Learnings durability.
- 2026-07-21: Activated after #1036 merged in PR #1048. Live GitHub recheck confirmed #954–#957 remain open under milestone #13 and dev-backlog#291 is closed.
- 2026-07-21: Sprint closed. 4/4 tasks completed. Final verification passed 83/83 standalone/append tests, 3/3 fleet integration tests, and 33/33 skills-lint tests; `git diff --check` passed.
