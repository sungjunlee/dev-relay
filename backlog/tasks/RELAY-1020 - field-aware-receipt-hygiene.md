---
id: RELAY-1020
title: 'Field-scope receipt hygiene for provider-named worktree paths'
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

GitHub source: https://github.com/sungjunlee/dev-relay/issues/1020

The receipt-hygiene test scans the entire serialized file and false-fails when legitimate path fields contain provider tokens such as `.codex` or `.claude`.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] Replace whole-file substring scanning with field-aware schema assertions.
- [ ] Continue to reject real engine/model/reviewer/executor/provider fields or values.
- [ ] Permit provider-like tokens in documented path-bearing fields.
- [ ] Cover `.codex`, `.claude`, `.cursor`, `.grok`, and `.opencode` roots.
- [ ] Focused tests pass from token-bearing and token-free roots without changing schema-1 receipt bytes.
<!-- AC:END -->
