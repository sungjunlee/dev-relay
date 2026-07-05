---
id: RELAY-783
title: 'relay-config revise mode: gaps --json, conversational amendments, migrate (Phase C)'
status: To Do
labels:
  - enhancement
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Context

Design: [docs/route-config-simplification-design.md](../blob/main/docs/route-config-simplification-design.md) (Phase C). Depends on Phase A (#781: unified loader).

Config skills are never invoked from memory; they need a "점검해줘" entry point that computes what drifted and proposes fixes. Observed live state that motivated this: pi installed but unrouted, opencode routes registered but no default model, legacy policy.json still authoritative, model probes timing out.

## Scope

1. **`relay-config gaps --json`** — deterministic core comparing merged routes config ↔ installed CLIs (existing inspect probes) ↔ usage evidence (events + reliability-report). Gap types: `installed_cli_unrouted`, `route_without_cli`, `executor_missing_default_model`, `legacy_config_present` (with migration proposal), `preset_broken`, `unregistered_route_in_use` (from `UNREGISTERED_ROUTE_USED` events; proposes registration), `probe_failure` (surfaced, not diagnosed).
2. **SKILL.md revise workflow.** Run `gaps --json` → present each gap with its concrete plain-language proposal → apply accepted ones via existing subcommands (`add-route`, `preset add`, `set-default`, migrate) → `doctor` to verify. Triggered by "설정 점검/리바이즈해줘".
3. **`relay-config migrate`.** Folds `policy.json` + `executors.json` + project routes v1 into unified files; prints a diff-style summary; asks before writing; never deletes legacy files (next `gaps` run proposes deletion).

## Acceptance Criteria

- [ ] On a fixture reproducing the observed machine state, `gaps --json` reports at minimum: `installed_cli_unrouted` (pi), `executor_missing_default_model` (opencode), `legacy_config_present`, and `probe_failure` ×2.
- [ ] Every gap entry carries a machine-readable proposal (subcommand + args) the skill can apply verbatim.
- [ ] `migrate` output is byte-equivalent in effect to the legacy inputs (same effective route resolution before/after, verified by resolving a matrix of tuples both ways).
- [ ] `migrate` never writes without confirmation and never deletes legacy files.
- [ ] `gaps` is read-only (no file writes, no events).

## Dependencies

Blocked by Phase A (#781). `unregistered_route_in_use` consumes the Phase A event; `preset_broken` consumes Phase B presets (degrade gracefully when absent).

