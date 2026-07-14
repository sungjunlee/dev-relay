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

## Flip-Flop Suppression (semantic recurrence)

A rubric status flip (`fail→pass→fail` or `pass→fail→pass`) is only a *candidate* signal. Escalation means the **same semantic blocker recurred**, not merely that a broad factor changed status.

Factor linkage precedence for tying current findings to a flipped factor:

1. Explicit `issues[].factor` (authoritative exact match)
2. `relates_to` (compatibility fallback)
3. `category` / `title` heuristic (legacy fallback)

`repeated_issue_count` is the consecutive fingerprint chain length: `0` for a clean pass path, `1` for current-round-only findings, and `>= 2` when the same fingerprint also appeared in a prior `changes_requested` round.

Continue (do not escalate) when `repeated_issue_count < 2` and either:

- the current round is a clean pass, or
- **every** flipped factor has at least one tied finding, and every tied finding has progressive lineage: `new`, `deepening`, or `newly_scoreable`

Escalate as genuine thrash when any of these holds:

- `repeated_issue_count >= 2` (cross-round fingerprint repeat)
- a flipped-factor finding is `repeat`, `stale`, or `unknown`
- a flipped factor has no explainable tied finding (fail closed)
- mixed progressive + thrash lineage on any flipped factor

Multiple flipped factors require progressive evidence for **each** factor. Missing lineage is coerced to `unknown` and fails closed; `stale` also fails closed.

The audit shape keeps `escalation_decision.reason = progressive_deepening` for continue paths and `flip_flop_thrash` for escalate paths.

## Example Traces

- `new`: `Behavior: r1:pass -> r2:fail` when round 2 finds a first-time issue in a factor with no prior blocker. On a flip candidate with no cross-round fingerprint repeat, `lineage=new` converges (find → fix → verify arc).
- `deepening`: `F1: r1:fail -> r2:pass -> r3:fail` when round 3 strengthens a test after a real fix (`factor=F1`, `lineage=deepening`) — continue, not escalate.
- `repeat`: `Forensics: r1:fail -> r2:pass -> r3:fail` when the current finding restates a prior blocker — escalate (genuine thrash / owner decision).
- `stale`: `Forensics: r1:fail@abc123 -> r2:fail@abc123` when the same reviewed HEAD or stale artifact is being evaluated again.
- `newly_scoreable`: `Behavior: r1:not_run -> r2:fail -> r3:pass` when a previously unscoreable factor becomes reviewable and exposes a finding.

## Non-Regression Guard

tamgu-note#1621 (PR 1634) and finjuice#416 (PR 417) both had cross-round repeated fingerprints (`repeated_issue_count >= 2`) and/or thrash lineage, so they still escalate. Semantic-recurrence suppression applies only when there is no cross-round fingerprint thrash (`repeated_issue_count < 2`) and every flipped factor is explained by progressive lineage.
