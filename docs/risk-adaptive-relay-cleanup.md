# Risk-Adaptive Relay Cleanup Decision

This records the evidence gate for issue #1033. It is an operator-facing
decision, not an automatic route change.

## Evidence state

Live observation status: insufficient evidence. The current repository and
default relay home report `0` manifests and `0` events. Every task class remains
`continue_calibration`; additional review rounds, Earned Rubric evaluation, and
adversarial review remain `insufficient_evidence`.

Static reachability is sufficient only for machinery whose producer was already
removed. It is not a substitute for outcome evidence about an active safeguard.

## Inventory and decision

| Candidate | Evidence | Decision | Surviving invariant owner |
| --- | --- | --- | --- |
| Executor Score Log production | #1030 made reviewer output the sole scoring authority; current dispatch output contained metadata, not scores | Remove and rename the PR section to Dispatch Metadata | Reviewer verdict plus `iteration_score` journal |
| Executor/reviewer score divergence parser, event writer, report fields, and planner signal | No current producer or runtime caller after reviewer-only scoring | Remove together | Reviewer verdict validation and reliability factor analysis |
| Score-Log sprint-close report | Its only input was the retired executor Score Log, so it cannot observe future runs | Remove script, tests, reference, and operator links | Risk-path calibration and project retrospectives |
| Superseded self-review compatibility needle | Current protocol no longer emits that text | Remove fallback branch | Completion Responsibilities and independent review |
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
current code emits or analyzes them. Historical `score_log` fields remain
readable in retained previous-attempt artifacts and are never treated as review
evidence.

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
