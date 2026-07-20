---
id: RELAY-954
title: 'Epic: Multi-track sprint interop — make relay track-aware'
status: To Do
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
- [ ] #955, #956, and #957 are merged and closed with relay manifests and task mirrors reconciled.
- [ ] Integration evidence covers N==1 compatibility and N>1 standalone resolution without lost Learnings.
- [ ] Integration evidence covers pre-dispatch fleet ownership and the chosen mixed-track policy.
- [ ] No relay-side duplicate parser exists; dev-backlog JSON remains the ownership source of truth.
- [ ] Sprint state, milestone state, GitHub issue checklist, and repository backlog agree.
- [ ] The sprint is closed through the normal dev-backlog closeout workflow and milestone #13 is complete.
<!-- AC:END -->

## Dependencies

- #955
- #956
- #957

## Related

- `sungjunlee/dev-backlog#289`
