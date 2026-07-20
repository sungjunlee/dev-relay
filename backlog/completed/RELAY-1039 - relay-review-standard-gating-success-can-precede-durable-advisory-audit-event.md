---
id: RELAY-1039
title: 'relay-review: standard gating success can precede durable advisory audit event'
status: Done
labels:
  - bug
  - workflow
priority: medium
milestone: 2026-07 Assurance and Calibration Integrity
created_date: '2026-07-19'
---
## Description
## Problem

A standard (non-hardened) gating advisory can return decision-changing success before its `ADVISORY_REVIEW` event is durable.

The worker writes the result artifact first, waits for decision timing, appends the audit event, and then rewrites the result. Standard settlement previously required event binding only under hardened assurance, so a gating result could demote the primary verdict while the durable audit trail still had zero matching events.

This was observed while rebaselining #816 with the default-parallel full suite. It is adjacent to, but distinct from, the relay-fleet condition-wait report.

## Done Criteria

- [ ] Standard gating success is not returned until a matching durable `ADVISORY_REVIEW` event exists.
- [ ] Event binding validates the existing run/head/round/reviewer/artifact provenance contract.
- [ ] Standard non-gating lanes remain lightweight; hardened behavior remains unchanged.
- [ ] A deterministic regression proves result-first/event-later ordering fails before and passes after the fix.
- [ ] No timeout widening or CI command-shape change.

## Evidence target

- Focused regression.
- Advisory test file.
- Default-parallel Linux full suite.

Discovered during #816 rebaseline.
