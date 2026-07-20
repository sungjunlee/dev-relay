---
id: RELAY-833
title: 'Follow-up: Harden live model-list parser fixtures for provider CLIs'
status: Done
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

- [x] Add representative fixture files, at minimum Pi table output and OpenCode line output.
- [x] Cover header rows, separators, provider/model split columns, direct provider/model rows, and extra metadata columns.
- [x] Parser tests are fixture-driven.
- [x] Healthy listed-model probe output resolves via `live_probe`, not catalog fallback.
- [x] Document the fixture update workflow near resolver/catalog docs.

Completion evidence: PR #837 merged and GitHub issue #833 closed on 2026-07-08.
