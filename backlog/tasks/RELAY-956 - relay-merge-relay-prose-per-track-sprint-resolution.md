---
id: RELAY-956
title: 'relay-merge/relay prose: per-track sprint resolution for reads/writes'
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

Make the relay and relay-merge operator contracts select the sprint that owns the task instead of referring ambiguously to “the active sprint.”

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] Relay reads Running Context and batch information from the owning track resolved through dev-backlog JSON.
- [ ] Relay marks in-flight work in the owning track rather than an arbitrary active sprint.
- [ ] Relay-merge writes Plan completion, Progress, and Running Context to the owning track.
- [ ] Component/track resolution uses dev-backlog `sprint-state.js`; exactly one active sprint remains the N==1 fallback.
- [ ] No relay-side track/component markdown parser is introduced.
- [ ] SKILL.md files remain within the repository line limit and relevant lint/tests pass.
<!-- AC:END -->

## Dependencies

- #955

## Related

- Parent #954
