# Review Lineage

Lineage labels help the runner distinguish repeated blockers from progressive deeper findings across review rounds.

## Grammar

| Value | Meaning | `relates_to` guidance |
|---|---|---|
| `new` | First-time finding with no prior-round ancestor. | Omit unless a prior factor reference clarifies the finding. |
| `deepening` | The prior issue was valid, and this round exposes a narrower or deeper edge case rather than repeating the same blocker. | Reference the prior issue title, factor, or round/factor id. |
| `repeat` | The same semantic issue is still blocking the PR. | Reference the prior issue title, factor, or round/factor id. |
| `stale` | The finding is tied to stale review evidence, such as the same reviewed HEAD or an unchanged prior artifact, and should not be mistaken for meaningful progress. | Reference the stale round, artifact, or prior issue title when known. |
| `newly_scoreable` | A factor was previously blocked, missing evidence, or `not_run`, and is now scoreable with a concrete finding. | Reference the prior unscoreable factor or issue. |
| `unknown` | Relationship cannot be determined, including omitted lineage from older verdicts. | Omit unless a partial reference is known. |

## Flip-Flop Suppression

Flip-flop suppression is narrow: when a factor flip-flops, `repeated_issue_count` is 0, and all current issues tied to the flipped factor have `lineage=deepening`, continue the review without escalation.

Otherwise escalate. Missing lineage is coerced to `unknown`, which fails closed like `repeat`; `stale` also fails closed rather than counting as progressive deepening.

## Example Traces

- `new`: `Behavior: r1:pass -> r2:fail` when round 2 finds a first-time issue in a factor with no prior blocker.
- `deepening`: `Behavior: r1:pass -> r2:fail -> r3:pass` when the round 3 finding is a deeper edge case tied to the same factor rather than the same issue.
- `repeat`: `Forensics: r1:fail -> r2:pass -> r3:fail` when the current finding restates a prior blocker.
- `stale`: `Forensics: r1:fail@abc123 -> r2:fail@abc123` when the same reviewed HEAD or stale artifact is being evaluated again.
- `newly_scoreable`: `Behavior: r1:not_run -> r2:fail -> r3:pass` when a previously unscoreable factor becomes reviewable and exposes a finding.

## Non-Regression Guard

tamgu-note#1621 (PR 1634) and finjuice#416 (PR 417) both had `repeated_issue_count >= 1`, so they still escalate regardless of lineage. The Phase B suppression applies only to the `repeated_issue_count === 0` progressive-deepening shape.
