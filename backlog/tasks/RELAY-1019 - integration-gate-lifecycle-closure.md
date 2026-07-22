---
id: RELAY-1019
title: 'Make integration-gate lifecycle single-owner, terminal, and provenance-safe'
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
  - RELAY-1016
---
## Description

GitHub source: https://github.com/sungjunlee/dev-relay/issues/1019

The re-pilot completed with a `ready` integration task, two resolved gates for the same outcome, and lifecycle completion messages that required explicit-flag retries or encountered stale coordinator context.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] Define one owner and one ordering for integration evidence, `worker_done`, gate creation, and gate resolution.
- [ ] Exactly one canonical integration gate exists per outcome; recovery and resume are idempotent.
- [ ] Emit a copy-paste-safe explicit-flag completion command with current task, dispatch, report, assignee, and coordinator provenance.
- [ ] Passed evidence leaves the program-owned integration task terminal without direct coordinator state surgery.
- [ ] Final summary refuses completion for active integration residue or duplicate/conflicting gates.
- [ ] Cover duplicate gate, repeated resume, stale coordinator, conflicting result, and zero-mutation failures with fixtures only.
<!-- AC:END -->
