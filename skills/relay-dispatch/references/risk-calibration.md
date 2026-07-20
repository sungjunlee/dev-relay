# Risk-Path Calibration

`reliability-report.js` publishes a `calibration` section that compares the full and lightweight behavior paths without changing any route automatically.

## Evidence unit

Each run is reported with:

- `task_class`: `code`, `design`, `documentation`, `operations_security`, or `data_change`
- `behavior_path`: `lightweight` for compact assurance and `full` for standard or hardened assurance
- `assurance_tier`: compact, standard, or hardened
- `comparison_eligibility`: report-only inclusion or exclusion derived from the persisted assurance floor
- Outcome quality: contract status plus observed user/domain surface status
- Verification status, reported separately; routine Verification success is not rubric value
- Harness friction: stalls, recovery actions, and explicit manual interventions
- Review yield: material independent-review findings
- Rubric value: earned factors and factors whose failure changed a review decision

No-rubric runs are first-class samples. Coverage reports their count and does not invent quality factors.

## Task-class decisions

Promotion evidence is evaluated within each task class, never from one global pass rate. A run is comparable only when its task-derived `minimum_review_assurance` is `compact`. A low-risk run explicitly strengthened to standard or hardened remains a valid full-path control. Medium-, high-, and unknown-risk full runs remain visible but are excluded from compact decisions.

Each path reports `observed_sample_size` for all runs, `sample_size` for the comparable cohort, and `excluded_sample_size` for the difference. A class needs at least three comparable runs in each path before ordinary quality or friction trends can produce a promotion candidate.

The conservative decisions are:

- `continue_calibration`: either path lacks repeated evidence.
- `retain_full`: lightweight outcome quality trends lower, full-path mechanisms found unique material defects, or lightweight friction trends higher.
- `promote_lightweight_candidate`: observed quality is preserved, full-only mechanisms found no unique material defects, and lightweight friction is no higher.
- `rollback_lightweight`: any lightweight safety boundary violation. This immediate rollback does not wait for a trend.

A candidate is an operator decision artifact. The report does not auto-promote a route, weaken a gate, publish, or merge.

Safety violations from excluded medium/high/unknown full runs remain operational evidence but cannot change the compact decision. Compact-eligible full controls retain the existing conservative safety behavior.

## Safety evidence

Ready or merged runs without required contract/surface observation are recorded as `success_without_required_observation`. A ready or merged run whose reviewed SHA differs from its accepted head is recorded as `stale_sha`.

Confirmed violations that require external knowledge, such as a wrong deployment target or an irreversible action without approval, use the durable run journal:

```js
appendSafetyBoundaryViolation(repoRoot, runId, {
  stateFrom: currentState,
  boundary: "wrong_external_target",
  reason: "confirmed target mismatch",
});
```

Only confirmed violations should use this event. A protection that blocks an unsafe action is evidence that the boundary worked, not a violation.

## Legacy mechanism evidence

The report separates demonstrated value from cost for:

- additional review rounds;
- Earned Rubric evaluation;
- adversarial review.

Each mechanism reports uses, friction units, unique material defects, and a decision. A used mechanism with unique material defects is retained. A used mechanism that produced only friction becomes a deletion candidate; unused mechanisms remain `insufficient_evidence`.
