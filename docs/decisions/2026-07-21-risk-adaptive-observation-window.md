# Risk-Adaptive Relay Observation Window

Status: bounded observation complete; all target classes continue calibration.

## Snapshot boundary

- Cutoff: 2026-07-21 01:51:10 KST, immediately before dispatching this
  report.
- Repository HEAD: `825be62842d96b4a12760d706578cf2728609cfe`.
- Latest real-work run in scope: issue #1040,
  `issue-1040-20260720141108206-a0041804`, merged through PR #1045 before
  the cutoff.
- Source command:
  `node skills/relay-dispatch/scripts/reliability-report.js --repo . --json`.
- Evidence: the configured relay home's persisted manifests, event journals,
  and review verdicts as available at the cutoff.
- Minimum comparable sample: 3 runs per path: 3 compact runs and 3
  compact-eligible full controls in each class.

The command saw 284 classified runs because the newly created report run,
`issue-1036-20260720165108485-5e65cf49`, was already present. This snapshot
excludes exactly that run to avoid circular evidence. The bounded result is 283
classified runs: 2 `included` and 281 `excluded_unknown_floor`; there are no
other exclusion categories. Task-class counts are documentation 2, code 1,
design 0, and unknown 280. The 281 excluded runs remain visible evidence but
cannot decide a compact cohort.

Named target-class cohort:

- Included documentation full control:
  `issue-1037-20260720143139054-fbc0c2a0`.
- Included documentation lightweight run:
  `issue-1037-20260720142235807-8a527173`.
- Excluded code full observation:
  `issue-399-20260502075702855-19860d9e`
  (`excluded_unknown_floor`; its persisted profile has no
  `minimum_review_assurance`).
- Design: no run on either path.

## Target-class observations

### Code — `continue_calibration`

The full path has 1 observed run, 0 comparable controls, and 1 excluded run;
the lightweight path has 0 runs. The excluded full run reports outcome quality
PASS (contract PASS and user surface PASS), Verification PASS, harness friction
0, independent-review yield 0 material findings, 2 earned factors with 0
decision-changing factors, and 0 recorded safety violations. These values are
not compact-comparison evidence because the assurance floor is unknown.

The class is under-sampled because it has neither a compact-eligible full
control nor a compact run, against the required 3 on each path. Absence of
comparable evidence is not evidence of quality or safety.

### Design — `continue_calibration`

Both paths have 0 observed and 0 comparable runs. Outcome quality,
Verification, harness friction, independent-review yield, rubric decision
value, and safety are therefore not observed.

The class is under-sampled because it has no real run on either path. A future
design observation must inspect rendered output, relevant flows and viewports,
hierarchy, consistency, and task-specific user impact. Build, test, or lint
success may establish Verification only; it cannot substitute for design
observation or Earned Rubric value.

### Documentation — `continue_calibration`

The class has 1 included full control and 1 included lightweight run, below the
required 3 on each path.

| Channel | Full control | Lightweight |
| --- | --- | --- |
| Outcome quality | PASS: contract PASS, user surface PASS | FAIL: contract FAIL, user surface not run |
| Verification | PASS | PASS |
| Harness friction | 2: 1 stall, 1 recovery, 0 manual interventions | 0 |
| Independent-review yield | 1 material finding | 1 material finding |
| Rubric decision value | 1 earned factor, 0 decision-changing factors | 1 earned factor, 0 decision-changing factors |
| Safety violations | 0 recorded | 0 recorded |

The lightweight run is the concrete counterexample to conflating Verification
with outcome quality: its Verification passed while its Outcome failed. One
run per path cannot establish a trend, and zero recorded safety violations in
this small cohort are not promotion evidence.

## Earned Rubric audit

Both included documentation rubrics contain the same sole quality-tier factor,
`Historical boundary and scope discipline`. It is task-specific: the persisted
criteria inspect byte-preserved relocation of the #138–#146 mirrors, preservation
of archived history, and confinement of live changes to #1037 traceability and
the narrowly required planning-contract correction. Its scoring guide
distinguishes weak (historical rewriting, unrelated changes, or scope
expansion), adequate (the boundary mostly holds but unnecessary edits weaken
the audit), and strong (a precise live-context migration with byte-preserved
history and a minimal audit trail). This is a consequential, observable
gradient rather than generic filler.

In the lightweight run, the persisted verdict records this factor as
`not_run`, with no score, because the Outcome Contract failed first. The
calibration output still counts one earned factor from the quality-tier verdict
row; it records 0 decision-changing factors. In the full control, the factor
was `not_run` after the first contract failure, then scored 10/10 and passed in
rounds 2 and 3; it also records 0 decision-changing factors. The material
findings that drove repair were contract-factor findings, not Earned Rubric
failures. Thus no earned factor changed either run's decision.

Generic quality labels without task-specific evidence and distinguishable
weak/adequate/strong outcomes remain invalid. Zero-factor runs also remain
valid: after excluding this report's own run, 67 classified runs have
`rubric_mode: none`; no factor is invented to fill the observation window.
Routine test, build, and lint evidence remains Verification only.

## Existing mechanism observations

| Mechanism | Uses | Friction units | Unique material defects | Report decision |
| --- | ---: | ---: | ---: | --- |
| Additional review rounds | 173 | 409 | 120 | `retain` |
| Earned Rubric | 216 | 327 | 77 | `retain` |
| Adversarial review | 81 | 81 | 27 | `retain` |

Every mechanism has observed unique material defects; none is a
`deletion_candidate`. No deletion issue is opened.

## Operational boundary

This report is observational only. It causes no automatic route promotion,
safeguard deletion, publication, or merge, and it does not lower task risk to
fill a cohort. Any later change requires a separate operator decision from a
new bounded evidence set.
