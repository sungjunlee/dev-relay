# Comparable Risk Calibration

## Problem

Risk-path calibration currently compares every full-path run with compact runs in
the same task class. Full runs can be medium or high risk, so this can measure
risk mix instead of harness behavior.

## Design principle

Correct the comparison without creating another scoring or matching system.
Reuse the task-derived assurance floor already stored in
`task_profile_summary.minimum_review_assurance`. Do not persist new manifest
state, inspect model/provider identity, mutate routes, or automate promotion.

## Comparison boundary

- A run is comparable when its derived minimum assurance is `compact`.
- A `standard` or `hardened` floor is excluded from compact comparison.
- A missing or unknown floor is excluded fail-closed.
- Selected assurance remains independent: a low-risk run explicitly strengthened
  to `standard` or `hardened` is a valid full-path control.

`by_run` exposes one report-only `comparison_eligibility` value so an operator
can see whether a run was included or why it was excluded. No new field is
written back to the run manifest.

## Reporting and decisions

Keep the existing task-class and path structures. For each path:

- `observed_sample_size` counts every observed run;
- `sample_size` counts only comparable runs used by the existing metrics;
- `excluded_sample_size` is the difference.

All runs remain visible through `by_run`, coverage, and operational evidence.
The existing comparison and promotion functions receive only compact-eligible
entries.

The safety boundary stays conservative:

- any lightweight safety violation still rolls back lightweight immediately;
- a compact-eligible full control can still trigger the existing safety rollback;
- safety signals from excluded medium/high/unknown full runs remain visible but
  cannot change the compact decision.

If either comparable path is below the existing minimum sample, return
`continue_calibration` with path-specific insufficient-comparable-sample
reasons. Do not add a numeric quality score or another decision status.

## Verification

Focused tests cover:

1. low-risk full controls participating even when their selected tier is
   `standard` or `hardened`;
2. medium/high full runs remaining visible but unable to produce promotion,
   retention, or rollback;
3. unknown floors being excluded fail-closed;
4. risk-skewed observed cohorts returning `continue_calibration` when comparable
   samples are insufficient;
5. the operator report exposing observed, included, and excluded counts.

Existing reliability-report and risk-assurance suites remain the regression
boundary.

## Non-goals

- no propensity matching or risk weighting;
- no model/provider-specific logic;
- no new persisted schema;
- no route mutation or automatic promotion;
- no broader calibration rewrite or new module.
