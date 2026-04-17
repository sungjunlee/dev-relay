---
id: RELAY-109
title: 'dispatch: per-agent model hints for cost optimization'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Allow per-phase model hints in the relay pipeline to optimize cost-quality tradeoffs. Heavier models for accuracy-sensitive phases (plan, review), lighter models for mechanical phases (gate-check).

## Background

Currently relay supports executor selection (Claude/Codex) but not model-level hints within the same executor. Different relay phases have different accuracy requirements:

- **Plan** (rubric design): Requires deep reasoning → heavier model
- **Dispatch** (implementation): Needs speed-quality balance → mid-tier model
- **Review** (code evaluation): Requires precision → heavier model
- **Merge** (gate-check): Simple verification → lightest model

Community patterns show that role-based model selection (e.g., Opus for analysis/review, Sonnet for implementation, Haiku for triage/PR creation) delivers measurable cost savings without quality loss.

## Proposed Behavior

```yaml
# relay manifest or dispatch config
model_hints:
  plan: opus        # rubric design needs accuracy
  dispatch: sonnet  # implementation balances speed and quality
  review: opus      # review needs accuracy
  merge: haiku      # gate-check is simple verification
```

- Add optional `model_hints` field to manifest schema (backward-compatible, defaults to current behavior)
- Each skill reads the hint for its phase and passes it to the executor
- `--model <name>` flag for per-invocation override
- Model hints are advisory — executor adapters may ignore unsupported hints

## Considerations

- **Executor compatibility**: Not all executors support model selection (e.g., Codex has limited model choice)
- **Cost estimation**: Using Haiku for triage/gate-check could save ~70% on those phases
- **Environment probe**: `probe-executor-env.js` could detect available models and validate hints
- **Schema migration**: Manifest schema extension must be backward-compatible (missing field = current behavior)
- **Observability**: `reliability-report.js` should track model used per phase for cost analysis

## Existing Infrastructure

- `relay-manifest.js` — manifest schema, validation, state machine
- `probe-executor-env.js` — executor environment detection
- `reliability-report.js` — aggregate run metrics
- `dispatch.js` — executor-agnostic entry point with executor routing
