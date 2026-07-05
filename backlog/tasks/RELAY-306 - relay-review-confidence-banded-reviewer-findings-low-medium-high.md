---
id: RELAY-306
title: 'relay-review: confidence-banded reviewer findings (low/medium/high)'
status: To Do
labels:
  - enhancement
  - backlog
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
# relay-review: confidence-banded reviewer findings

## Summary

Add `confidence: low | medium | high` to every entry in `verdict.issues[]`. The reviewer scores each finding's confidence; downstream gates use the band to decide blocking severity.

## Motivation

Reviewer noise is a recurring drag — low-signal nits get the same blocking weight as critical defects. Anthropic's eval guidance and Reflexion-style critic patterns both treat confidence as a first-class signal: high-confidence + critical → block; low-confidence → advisory note that doesn't gate merge.

Concrete dev-relay evidence:
- PR #298 R1 caught a real contract gap, and PR #300 R1 caught a heading-text mismatch — both were correctly blocking. But several recent rounds also surfaced near-cosmetic "consider renaming" issues that the reviewer prompt's "do not invent nitpicks" directive failed to suppress.
- A confidence band gives the reviewer a sanctioned channel for "I'm not sure but flagging" without forcing it into either "ignore" or "block."

## Why this is a separate issue from #142

Verdict-schema additions trigger the bootstrap paradox documented in `feedback_schema_bootstrap_paradox.md`. PR #298 → #304 chain showed how easy it is to ship a strict-mode-incompatible schema change because the running reviewer is on the *previous* schema. Confidence bands need:

- a structural invariant test pass (already exists since PR #304),
- a strict-mode-correct addition to `REVIEWER_VERDICT_JSON_SCHEMA`,
- explicit `required` membership for the new field,
- a coordinated installed-skills rsync before the next dispatch.

#142 explicitly avoids touching the verdict schema for exactly this reason. Bundling confidence bands into #142 would re-introduce the failure mode #142 was designed to dodge.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `REVIEWER_VERDICT_JSON_SCHEMA` and `REVIEW_VERDICT_JSON_SCHEMA` add `confidence` to `issues[].properties` with enum `["low", "medium", "high"]`
- [ ] `confidence` is in `required` for both schemas (strict-mode invariant)
- [ ] Reviewer prompt instructs: "Score every issue's confidence. high = clear defect, reproducible from diff alone. medium = likely defect, may need execution to confirm. low = stylistic or speculative, do not block on this alone."
- [ ] `validateIssue` enforces enum membership
- [ ] Verdict gate logic: a `verdict=changes_requested` payload where all issues have `confidence=low` is downgraded to `verdict=advisory_pass` (new value? or kept as `pass` with notes?) — open design question, see Failure Modes
- [ ] Structural invariant test (`schema/strict-mode invariant: ...`) passes after this change
- [ ] Back-compat: existing reviewer payloads without `confidence` are rejected with a clear error pointing at the field (no silent default)
- [ ] Memory `feedback_schema_bootstrap_paradox.md` referenced in the PR description as the failure-mode this PR explicitly mitigates
<!-- AC:END -->

## Failure Modes

**Critical**: schema strict-mode regression. Per PR #304, every `additionalProperties: false` object must list every property in `required`. The structural invariant test in `review-runner-verdict.test.js` is the gate.

**Design open**: how should "all-low-confidence changes_requested" be transported? Options:
1. New verdict value `advisory_pass` (4-value enum, breaking change to consumers)
2. Keep `verdict=pass` but populate `notes` with the advisory issues (no schema change but loses the "we found something worth mentioning" signal)
3. Keep `verdict=changes_requested` but consumers (gate-check.js, finalize-run.js) downgrade based on confidence band

Recommendation: option 3. Smallest schema delta; consumers already distinguish blocking from advisory.

## Dependencies

- Lessons from #270 Phase B (lineage enum addition pattern) and PR #304 (structural invariant test). Reuse the same test + rsync workflow.

## Out of Scope

- Auto-tuning confidence thresholds based on historical data. (Phase 2 if value validates.)
- Surfacing confidence in `escalation_decision` events. (Possible Phase B follow-up.)
- Reviewer disagreement metric (cross-reviewer confidence delta). (Distinct issue.)

## Context

- Bootstrap paradox lesson: `~/.claude/projects/-Users-sjlee-workspace-active-harness-stack-dev-relay/memory/feedback_schema_bootstrap_paradox.md`
- Strict-mode invariant test: `skills/relay-review/scripts/review-runner-verdict.test.js`
- Lineage enum precedent (same shape of change): PR #298 → `a2d1492`

