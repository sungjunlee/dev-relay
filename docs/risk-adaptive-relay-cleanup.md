# Risk-Adaptive Relay Cleanup Decision

This records the evidence gate for issue #1033. It is an operator-facing
decision, not an automatic route change.

## Evidence state

Live observation status: insufficient evidence. The current repository and
default relay home report `0` manifests and `0` events. Every task class remains
`continue_calibration`; additional review rounds, Earned Rubric evaluation, and
adversarial review remain `insufficient_evidence`.

The observation gate is therefore closed. No active review, recovery,
compatibility, audit, SHA-freshness, publication, or approval mechanism may be
removed on this evidence.

A separate structural obsolescence proof applies only after an approved earlier
transition has removed every current producer, consumer, and semantic effect of
an artifact. It establishes that retaining or deleting that artifact is
behaviorally equivalent; it is not promotion evidence or a substitute for
outcome-quality evidence. Structural obsolescence proof never authorizes
deletion of an active mechanism. If any live call path or unique invariant owner
exists, the observation gate applies and the mechanism remains.

## Inventory and decision

| Candidate | Evidence | Decision | Surviving invariant owner |
| --- | --- | --- | --- |
| Executor Score Log production | #1030 made reviewer output the sole scoring authority; current dispatch output contained metadata, not scores | Remove and rename the PR section to Dispatch Metadata | Reviewer verdict plus `iteration_score` journal |
| Executor/reviewer score divergence producer, review comparison, and planner signal | Reviewer-only scoring removed the current executor score authority | Remove from current review and planning paths | Reviewer verdict validation and reliability factor analysis |
| Historical score-divergence analytics | Historical events remain readable and may still carry operator value | Retain as a legacy-only reliability-report consumer; do not restore an event producer | Generic event reader plus legacy analytics |
| Score-Log sprint-close report | It cannot observe future reviewer-only runs, but completed historical manifests and PR bodies remain supported inputs | Retain `skills/relay-merge/scripts/sprint-close-report.js` as an explicit legacy-only command; remove it from the default operator flow | Historical manifest and Score Log compatibility readers |
| Superseded self-review compatibility needle | Current protocol no longer emits that text | Remove fallback branch | Completion Responsibilities and independent review |
| Legacy quality-card summary helper | No planner, dispatcher, reviewer, or operator path calls it; it only parses the superseded factor-tier shape and its own TDD skip-reason vocabulary | Remove helper, tests, and stale documentation link | Structured evaluation validation, optional TDD flavor, and task-derived observation lenses |
| Additional review rounds | No observed runs | Retain | Assurance-derived review cap and review runner |
| Earned Rubric | No observed earned-rubric runs | Retain | Evaluation channels, rubric anchor, and reviewer scoring |
| Adversarial review | No observed advisory runs | Retain | Hardened assurance and advisory orchestration |
| Lifecycle states and recovery utilities | No evidence that they are redundant | Retain | Manifest lifecycle, recovery events, and merge gates |
| Historical Score Log and manifest compatibility readers | Historical migration cannot be proven complete from an empty live store | Retain and label legacy-only | Previous-attempt reader, fail-closed rubric reader, and generic event reader |

## Preserved boundaries

Intent and Done Criteria remain frozen in the run anchor. Permission, sandbox,
network, repository, and worktree isolation remain route inputs. Reviewer
evidence, audit journals, reviewed-SHA freshness, delayed publication, and
explicit approval for merge or other irreversible actions remain mandatory.

Historical `score_divergence` journal lines are still readable because event
validation is write-only and the generic reader accepts historical names. No
current code emits them; reliability-report may still analyze them as
legacy-only historical data. Historical `score_log` fields remain readable in
retained previous-attempt artifacts and by the legacy-only sprint-close report,
and are never treated as current review evidence.

## Rollback triggers

Rollback the cleanup if a supported historical manifest can no longer be read,
legacy attempt context breaks re-dispatch, reviewer scores stop reaching
`iteration_score`, or operator verification finds a missing audit/SHA/approval
gate. Restore only the smallest compatibility reader needed; do not restore
executor score authority.

## Final operator flow

1. Plan from intent, Done Criteria, Verification, and optional Earned Rubric.
2. Dispatch with an assurance tier derived from task risk.
3. Capture implementation and Verification evidence; publish Dispatch Metadata.
4. Review independently; reviewer verdicts own pass/fail and optional scores.
5. Repeat only within the assurance-derived cap, then require fresh reviewed SHA.
6. Stop at `ready_to_merge`; merge only after explicit approval.
7. Use risk-path calibration after a real observation window before deleting any
   retained safeguard.
