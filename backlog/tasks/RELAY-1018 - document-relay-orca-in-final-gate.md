---
id: RELAY-1018
title: 'Document relay-orca tests in the broad final gate'
status: Done
labels:
  - enhancement
  - documentation
  - workflow
  - orca
priority: medium
milestone: Relay-Orca — Supervised Program Orchestration Pilot
created_date: '2026-07-15'
dependencies:
  - RELAY-1020
---
## Description

GitHub source: https://github.com/sungjunlee/dev-relay/issues/1018

The documented broad final-gate command omits `tests/relay-orca/scripts/*.test.js`, allowing a purported full-suite run to skip the relay-orca contract.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] Add `tests/relay-orca/scripts/*.test.js` to the documented broad final-gate command.
- [ ] Keep the command serialized and aligned with the repository's authoritative gate shape.
- [ ] Run the documented command successfully after RELAY-1020 removes provider-path false positives.
<!-- AC:END -->
