---
id: RELAY-957
title: 'relay-fleet: tag leaves with owning track; reject/route mixed-track fleets'
status: In Progress
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

Determine and carry each fleet leaf's owning track before dispatch so downstream finalize can append Learnings to the correct sprint.

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] Each fleet leaf receives a deterministic owning-track tag at planning/dispatch time.
- [ ] A single-track fleet preserves existing behavior while carrying the owner through the #955 finalize seam.
- [ ] A mixed-track fleet is rejected before dispatch with a clear diagnostic or routes every leaf with its own correct owner.
- [ ] Missing or ambiguous ownership fails before executor work begins.
- [ ] `relay-fleet/references/design.md` replaces the unresolved opportunistic wiring note with the implemented rule.
- [ ] Tests prove pre-dispatch tagging, single-track compatibility, mixed-track behavior, and downstream owner propagation.
<!-- AC:END -->

## Dependencies

- #955

## Related

- Parent #954
