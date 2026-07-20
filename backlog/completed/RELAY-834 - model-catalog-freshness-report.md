---
id: RELAY-834
title: 'Follow-up: Add stale model catalog freshness reporting'
status: Done
labels:
  - documentation
  - enhancement
  - workflow
  - agent-adapter
priority: medium
milestone: Route Config Simplification
created_date: '2026-07-08'
---
## Description

Add a proactive relay-config report for model catalog freshness so operators can see aging catalog entries without first hitting a catalog fallback path.

## Acceptance Criteria

- [x] Add a `relay-config` doctor/report surface for model catalog freshness.
- [x] Report each catalog entry with actor route coverage, `last_checked`, age in days, and stale/not-stale status.
- [x] Informational report exits successfully and includes structured JSON.
- [x] Document refresh workflow and evidence required for updating `last_checked`.
- [x] Do not auto-update routes, treat catalog fallback as an allow-list, or block dispatch/review on freshness warnings.

Completion evidence: PR #837 merged and GitHub issue #834 closed on 2026-07-08.
