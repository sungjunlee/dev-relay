---
id: RELAY-1036
title: 'dogfood: run a real risk-adaptive relay observation window'
status: To Do
labels:
  - enhancement
  - backlog
  - workflow
priority: high
milestone:
created_date: '2026-07-19'
---
## Description
## Goal

Run a bounded real-work observation window for the risk-adaptive relay paths after #1035 makes the cohorts comparable. Use the existing manifests, reviewer verdicts, events, and `reliability-report`; do not build another telemetry or scoring system.

The window should answer whether stronger models can carry more implementation and evaluation judgment with less procedural harnessing while preserving outcome quality and durable safety boundaries.

## Dependency

- Blocked by #1035.

## Observation plan

Start with `code`, `design`, and `documentation`, where comparable low-risk work is available. Operations/security and data-change remain full-path unless genuinely compact-eligible examples exist; do not manufacture low-risk classifications to fill a table.

For each target class, gather at least three compact runs and three compact-eligible full controls from real work. The minimum is a promotion-candidate threshold, not statistical proof.

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] #1035 is complete and the report exposes comparable included/excluded cohorts.
- [ ] Code, design, and documentation each have at least 3 real compact runs and 3 compact-eligible full controls, or the report explicitly records why a class remains under-sampled.
- [ ] Design observations inspect rendered output, relevant flows/viewports, hierarchy, consistency, and task-specific user impact rather than relying on build/test success.
- [ ] Routine test/build/lint success is recorded only as Verification, never as Earned Rubric value.
- [ ] Zero-factor Earned Rubric runs remain valid when observation finds no consequential quality gradient.
- [ ] Every earned factor is audited for task-specific evidence and a meaningful weak/adequate/strong distinction; generic filler is rejected.
- [ ] The final report separates outcome quality, Verification, harness friction, independent-review yield, rubric decision value, and safety violations.
- [ ] No automatic route promotion, safeguard deletion, publication, or merge occurs from the report.
<!-- AC:END -->

## Decision output

For each sufficiently sampled class, record exactly one operator-facing result:

- `promote_lightweight_candidate`
- `retain_full`
- `rollback_lightweight`
- `continue_calibration`

Also record whether additional review rounds, Earned Rubric evaluation, or adversarial review found unique material defects, produced only friction, or remain under-sampled. Open a deletion issue only when real evidence reports `deletion_candidate`.

## Related

- Follows #1025/#1032/#1033.
- Related to #439, but does not absorb relay-ready intake calibration.
- This is an operational dogfood issue, not a mandate to generate synthetic runs.
