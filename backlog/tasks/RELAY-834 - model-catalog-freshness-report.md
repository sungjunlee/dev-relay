---
id: RELAY-834
title: 'Follow-up: Add stale model catalog freshness reporting'
status: To Do
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

- [ ] Add a `relay-config` doctor/report surface for model catalog freshness.
- [ ] Report each catalog entry with actor route coverage, `last_checked`, age in days, and stale/not-stale status.
- [ ] Informational report exits successfully and includes structured JSON.
- [ ] Document refresh workflow and evidence required for updating `last_checked`.
- [ ] Do not auto-update routes, treat catalog fallback as an allow-list, or block dispatch/review on freshness warnings.
