---
milestone: 2026-07 Assurance and Calibration Integrity
status: active
started: 2026-07-20
due: 2026-07-31
objectives: []
component: "review-cycle"
---

# assurance-calibration-integrity

## Goal

Make decision-changing advisory evidence and risk-path calibration trustworthy enough to begin a bounded real-work observation window, then hand execution to the existing multi-track interoperability milestone.

## Plan

### Batch 0 — land the already-reviewed audit fix

- [x] #1039 bind standard gating success to a durable advisory audit event — merged in PR #1038 and closed on 2026-07-20 → PR #1038 (merged)

### Batch 1 — restore the hardened merge path

- [ ] #1040 make successful advisory events the hardened gate's provenance root — S/M, ~1 relay run; must accept event-matched `blindspot` and `adversarial` artifacts while preserving all forged/tampered/stale fail-closed cases

### Batch 2 — make risk-path calibration comparable

- [x] #1035 compare compact runs only with compact-eligible full-path controls — merged in PR #1042 and closed on 2026-07-20 → PR #1042 (merged)

### Batch 3 — clean live execution context

- [ ] #1037 migrate live backlog context to Outcome/Verification/Earned Rubric semantics — S, ~1 compact relay run; run after #1035 so the live context describes the calibrated model without reviving superseded mandatory-rubric assumptions

## Running Context

- Activation gate satisfied 2026-07-20: `2026-07-route-config-simplification.md` was closed through `sprint-close.sh`; already-closed work was reconciled, #783 was explicitly deferred, and milestone Route Config Simplification was closed.
- #1039 landed through PR #1038. Although the PR body retained `Closes #816`, the operator closed #1039 after merge; preserve that issue/PR relationship in sprint history.
- #1040 is more urgent after PR #1034: high-risk profiles now derive `review_assurance=hardened`, so the metadata glob and hard-coded `blindspot` parser block a first-class risk-adaptive path.
- #1035 is the prerequisite for #1036. Do not start the observation window or make promotion decisions from risk-skewed cohorts before #1035 lands.
- Follow-on execution is intentionally separate:
  1. Start #1036's bounded observation window after #1035.
  2. Execute milestone `2026-07 multi-track sprint interop` in dependency order: #955 → #956 → #957 → #954 closeout.
  3. Use the assurance/calibration and multi-track runs as real #1036 observations when they are compact-eligible; never lower task risk merely to fill a cohort.

## Progress

- 2026-07-20: Activated as the single active sprint after the Route Config closeout. Next actionable item is #1040; #1039 and #1035 are already complete.
- 2026-07-20: External progress reconciled: PR #1038 merged and #1039 closed; PR #1042 merged and #1035 closed. Remaining sprint implementation is #1040 then #1037.
- 2026-07-19 planning state: Planned from live GitHub and `origin/main` `edcff70`. Created #1040 with the preserved #981 reproduction contract, created milestone #15, assigned #1039/#1040/#1035/#1037, and kept #954–#957 on their existing multi-track milestone. At that time the sprint remained `planned` pending normal closure of the route-config sprint; it was activated the following day.
