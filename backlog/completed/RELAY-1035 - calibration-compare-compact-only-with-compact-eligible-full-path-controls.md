---
id: RELAY-1035
title: 'calibration: compare compact only with compact-eligible full-path controls'
status: Done
labels:
  - enhancement
  - backlog
  - workflow
priority: high
milestone: 2026-07 Assurance and Calibration Integrity
created_date: '2026-07-19'
---
## Description
## Problem

The risk-path calibration added by #1032 compares `full` and `lightweight` inside each broad task class. Compact is earned only by low-risk tasks, while the full cohort can contain medium/high-risk work. Comparing those cohorts directly can make either path look better or worse because of risk mix rather than harness behavior.

This issue makes the comparison valid without adding another score, matching engine, or automatic route mutation.

## Direction

Compare compact runs only with full-path controls that were themselves compact-eligible from the task-derived risk floor. Higher-risk full runs remain visible as operational evidence but cannot influence compact promotion.

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] Calibration records expose a task-derived compact-eligibility/comparison field using existing risk-assurance data; no model/provider identity is used.
- [ ] A compact run is compared only with same-task-class full runs whose derived assurance floor was also compact-eligible.
- [ ] Medium/high/unknown-risk full runs remain reported but are excluded from lightweight promotion calculations.
- [ ] When either comparable path lacks the minimum sample, the decision remains `continue_calibration` with an explicit non-comparable/insufficient-cohort reason.
- [ ] Tests prove that a risk-skewed full cohort cannot create `promote_lightweight_candidate` or `retain_full` for the comparable low-risk cohort.
- [ ] No new numeric quality score, propensity matching, automatic promotion, or route mutation is introduced.
<!-- AC:END -->

## Verification

- Focused calibration unit tests cover compact-eligible full controls, higher-risk exclusions, unknown-risk fail-closed behavior, and insufficient comparable samples.
- Existing reliability-report and risk-assurance suites remain green.
- A fixture/report example makes included and excluded cohort counts observable to an operator.

## Context

- Follows #1025/#1032.
- Must land before relying on a real risk-path observation window for promotion decisions.
- Related but distinct from #439, which calibrates relay-ready intake signals rather than assurance-path outcome comparisons.
