---
id: RELAY-833
title: 'Follow-up: Harden live model-list parser fixtures for provider CLIs'
status: To Do
labels:
  - enhancement
  - workflow
  - agent-adapter
priority: medium
milestone: Route Config Simplification
created_date: '2026-07-08'
---
## Description

Provider-aware model resolution now has live-first behavior. Add fixture-backed parser coverage for representative provider CLI model-list outputs so healthy live probes resolve via `live_probe` instead of silently falling back to the catalog.

## Acceptance Criteria

- [ ] Add representative fixture files, at minimum Pi table output and OpenCode line output.
- [ ] Cover header rows, separators, provider/model split columns, direct provider/model rows, and extra metadata columns.
- [ ] Parser tests are fixture-driven.
- [ ] Healthy listed-model probe output resolves via `live_probe`, not catalog fallback.
- [ ] Document the fixture update workflow near resolver/catalog docs.
