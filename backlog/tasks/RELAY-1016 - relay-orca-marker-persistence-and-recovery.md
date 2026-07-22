---
id: RELAY-1016
title: 'relay-orca: persist and recover program markers in relay manifests'
status: Done
labels:
  - bug
  - priority:high
  - workflow
  - orca
priority: high
milestone: Relay-Orca — Supervised Program Orchestration Pilot
created_date: '2026-07-15'
---
## Description

GitHub source: https://github.com/sungjunlee/dev-relay/issues/1016

The unbridged re-pilot proved that the operator prompt contains the exact program marker but a normal relay dispatch does not persist it into the run manifest. No supported post-dispatch recovery path exists.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] A relay-orca relay-run dispatch persists the exact marker through a first-class supported path.
- [ ] The generated operator contract uses an authoritative real-CLI shape and fails before dispatch when marker persistence is unavailable.
- [ ] Existing issue-matching runs can receive the marker through an idempotent audited recovery command without receipt edits or executor replay.
- [ ] `status` discovers the run and `resume --map-relay-run` completes the supported mapping flow.
- [ ] Duplicate, wrong-program, wrong-outcome, issue-mismatch, and zero-mutation failure fixtures are covered without real `orca` or `gh` binaries.
<!-- AC:END -->
