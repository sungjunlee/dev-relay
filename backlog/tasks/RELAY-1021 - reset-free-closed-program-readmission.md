---
id: RELAY-1021
title: 'Allow reset-free admission after a verified closed relay-orca program'
status: Done
labels:
  - bug
  - priority:high
  - workflow
  - orca
priority: high
milestone: Relay-Orca — Supervised Program Orchestration Pilot
created_date: '2026-07-15'
dependencies:
  - RELAY-1019
---
## Description

GitHub source: https://github.com/sungjunlee/dev-relay/issues/1021

The successful re-pilot reported `program_complete: true`, but the immediate admission probe rejected one active task and two gates. A normal successful program therefore requires a supervised global reset before the next program.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] Require all program-owned tasks to be terminal before historical-state admission.
- [ ] Treat only unambiguous resolved gates attached to terminal tasks as historical.
- [ ] Continue to block pending, unresolved, orphan, conflicting, foreign, malformed, or runtime-mismatched state.
- [ ] A successful final summary is followed by `probe-orca admitted:true` without `reset --tasks`.
- [ ] Failed, interrupted, ambiguous, or stopped programs receive no exemption.
- [ ] If safe classification is impossible, expose a program-scoped archive/cleanup gap without automatic global reset.
<!-- AC:END -->
