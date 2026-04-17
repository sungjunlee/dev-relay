---
id: RELAY-22
title: 'relay-review: cross-model review option (Claude spec + Codex quality)'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Add a cross-model review option where Phase 1 and Phase 2 use different models, leveraging each model's strengths:
- Phase 1 (Spec Compliance): Claude — strong at intent understanding and faithfulness judgment
- Phase 2 (Code Quality): Codex — efficient at mechanical pattern checking

Achieves multi-model consensus in a simple two-stage structure. Compensates for blind spots that occur when the same model both implements and reviews.

## Context

### Updated 2026-04-07

Community evidence confirms demand and effectiveness:

**Evidence 1: Adversarial Codex Review**
- Codex used as independent adversarial reviewer alongside Claude
- Fallback to Claude sub-agent when Codex is unavailable
- **Eval result: 92% (with adversarial review) vs 83% (without)** — 9pp improvement
- Key insight: same-model implementation + review shares blind spots

**Evidence 2: Generator-Evaluator Separation**
- Multiple plugins applied Generator-Evaluator separation to prevent self-praise bias
- Multi-model orchestration: GPT-PRO (research) + Codex (code gen) + Claude (orchestration)

### Updated 2026-04-05

- **#20 (two-stage review split) — completed** (merged in PR #26)
- Both reviewer adapters already exist: `invoke-reviewer-codex.js` and `invoke-reviewer-claude.js`
- Infrastructure for multi-reviewer is in place — implementation complexity is lower than originally estimated
- Remaining work: orchestration logic to automatically route Phase 1 → Claude, Phase 2 → Codex within a single review run

### Original context

Disagreement between models requires an escalation protocol to surface conflicting opinions to the user.

## Proposed Enhancement

Beyond the original "Phase 1 Claude → Phase 2 Codex" sequential structure:

- **`--adversarial` flag**: Both models independently review the **same scope** → surface disagreements
- **Disagreement protocol**: When verdicts differ, present both perspectives to user for escalation
- **Selective trigger**: Auto-activate when rubric has 3+ quality-tier factors (cost management)
- **Metrics**: Track relay-review score delta with/without adversarial review (extend `reliability-report.js`)

## References

- `docs/32-cross-platform-compatibility.md` § Cross-Model Review Option
- Octopus 75% consensus gate (references/analysis/02-claude-octopus.md)
- gstack cross-model review (references/analysis/05-gstack.md)
