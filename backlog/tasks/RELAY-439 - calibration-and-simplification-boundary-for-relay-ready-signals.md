---
id: RELAY-439
title: Calibration and simplification boundary for relay-ready signals
status: To Do
labels:
  - enhancement
  - epic
  - workflow
priority: medium
milestone: Relay Intake / Preflight
created_date: '2026-07-05'
---
## Description
## Goal
Cleanup issue covering observation/operations gaps surfaced by 3-lens reviews. Lands **after** Phase 2 ships and we have ≥20 real runs of the new system.

## Items

### 1. Calibration telemetry
Add metrics to `reliability-report.js` (or a sibling lightweight script) for the first 20 runs of the new system:
- **Bypass rate** — % of `/relay` invocations that skip the gate
- **Gate-fire rate** — % that hit interactive Q&A
- **Escalation rate** — % that fail to clear ≤3 budget
- **Direct-dispatch-bypass rate** — % of `relay-dispatch` direct calls (failure mode #4: users learning to bypass `/relay`)
- **Default-acceptance rate** — % of Q&A defaults accepted as-is vs. overridden (calibrates extractor quality)

Replaces the 1-pager's forecasted "예상 30~50% bypass" with measured numbers.

### 2. Multi-leaf budget rule
Decide and document — is `≤3` per-leaf or total per request?
- Edge case: 4-leaf request × 1 low dim each → 4 questions either way (>3 total OR =1 per leaf)
- Per-leaf default proposed in Issue E; this issue locks the decision and adds an edge-case test
- Cross-link to relay-intake's existing multi-leaf decomposition flow

### 3. Escalation recovery refinements
- When user re-runs `/relay` (or `relay-ready`) after editing the issue body, detect prior escalated artifact
- Show diff summary of issue body changes since last escalation
- Single prompt: "discard prior or update with re-score?" (not budget-charged)
- Cross-cuts Issue E's recovery handling — this is where we stress-test it

## Calibration thresholds (proposed defaults, retunable)
After 20 runs, retune if any of these are out of band:
- Bypass rate too high (> 60%) → bypass conditions too loose; tighten
- Bypass rate too low (< 15%) → bypass conditions too strict; loosen
- Gate-fire rate > 40% with default-acceptance < 40% → extractor is bad; revisit Issue A
- Escalation rate > 25% → ≤3 budget too tight, OR rubric flagging false positives

## Done criteria
- Telemetry rows added to reliability-report
- Multi-leaf budget decision in `references/design-v1.md`
- Recovery flow tested end-to-end with a synthetic re-entry scenario
- Calibration table populated with first-20-runs data + tuning decisions

## Refs
- Epic: #431
- craft-critique Failure modes 3 (escalation recovery), 5 (multi-leaf budget collision)
- eng-review § Edge cases
- Replaces 1-pager v1.1 § "예상 30~50% bypass" forecast


---

## Update (2026-07-04): measurement target refreshed for the ready-light routing era

Epic #718 reshaped `/relay` intake routing after this issue was written. `run-preflight.js` now emits a
`route_decision` with four values (`ready_single` / `ready_light` / `needs_split` / `readiness_prompt`,
see `skills/relay/scripts/run-preflight.js` routeDecisionFromReadiness), which supersedes the original
bypass/gate-fire framing.

**Item 1 (calibration telemetry) is retargeted:**
- Measure the **route_decision distribution** across runs (share of `ready_single`, `ready_light`, `needs_split`, `readiness_prompt`) instead of a single "bypass rate".
- Keep: escalation rate, direct-dispatch-bypass rate (direct `relay-dispatch` calls that skip `/relay`), default-acceptance rate for Q&A.
- Threshold table below should be re-derived against the four-way split once data exists (e.g., `readiness_prompt` share too high → extractor/bypass tuning; `ready_light` share ≈ 0 → light path not firing).

**Items 2–3 unchanged** (multi-leaf budget rule; escalation recovery).

**Gate unchanged:** lands only after ≥20 real runs of the new routing (ready-light shipped 2026-07-03 via #718 children). Do not implement before the observation window fills.

