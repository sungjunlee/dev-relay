---
id: RELAY-131
title: 'relay-intake: add optional external refinement adapters after core preflight lands'
status: To Do
labels:
  - enhancement
  - backlog
priority: medium
milestone: Relay Intake / Preflight
created_date: '2026-04-12'
---
## Description
## Summary

Add optional external refinement adapters such as gstack and superpowers *after* the core relay-native preflight path is stable.

## Background

Some weak requests may benefit from stronger adversarial review or rewrite support before relay starts. gstack and superpowers can help here, but they use their own logs, plan files, and local conventions. relay should ingest their outputs, not outsource its state to them.

This is explicitly a phase-2 enhancement. Core correctness should come from relay-native request artifacts, readiness assessment, decomposition, and handoff. External adapters are useful acceleration, not launch-critical infrastructure.

Parent epic: #126

## Sequencing

Blocked by the core preflight path landing first:

- #127 standalone skill contract + handoff boundary
- #128 request persistence + readiness assessment + interaction events
- #130 run handoff + review anchor integrity

## Proposed Behavior

- Detect actual delegate availability, not just PATH stubs or plugin cache presence
- Invoke gstack/superpowers only as optional refinement adapters
- Record delegate lifecycle in request events (`delegate_started`, `delegate_completed`, etc.)
- Persist resulting artifacts/links back into the relay request contract
- Fall back cleanly to native preflight when delegates are unavailable or fail

## Non-goals

- Required dependency on gstack or superpowers
- Using external tool logs as authoritative relay state
- Blocking core intake/preflight launch on adapter support

## Considerations

- gstack review logs and superpowers plan files are not authoritative relay state
- Adapter behavior should be observable but not required for correctness
- Installation checks should reflect real usability, not partial local leftovers

## Existing Infrastructure

- gstack review/timeline logs under `~/.gstack/projects/...`
- superpowers plan + reviewer workflows
- relay request/event model introduced by this epic

