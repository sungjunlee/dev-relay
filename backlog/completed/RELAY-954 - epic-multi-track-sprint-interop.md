---
id: RELAY-954
title: 'Epic: Multi-track sprint interop — make relay track-aware'
status: Done
labels:
  - enhancement
  - backlog
  - workflow
  - epic
priority: high
milestone: 2026-07 multi-track sprint interop
component: merge-finalize
created_date: '2026-07-20'
---
## Description

Close the multi-track interoperability epic with integrated evidence that standalone and fleet relay paths select the correct component-partitioned sprint.

## Acceptance criteria

<!-- AC:BEGIN -->
- [x] #955, #956, and #957 are merged and closed with relay manifests and task mirrors reconciled.
- [x] Integration evidence covers N==1 compatibility and N>1 standalone resolution without lost Learnings.
- [x] Integration evidence covers pre-dispatch fleet ownership and the chosen mixed-track policy.
- [x] No relay-side duplicate parser exists; dev-backlog JSON remains the ownership source of truth.
- [x] Repository sprint state, completed task mirrors, and merged PR/run evidence agree; GitHub issue #954 and milestone #13 remain a post-merge orchestrator handoff.
- [x] The repository sprint is closed through the normal dev-backlog closeout workflow without `--close-milestone`; external issue/checklist and milestone mutation is deferred to the orchestrator after merge.
<!-- AC:END -->

## Dependencies

- #955
- #956
- #957

## Related

- `sungjunlee/dev-backlog#289`
