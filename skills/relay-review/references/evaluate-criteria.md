# Evaluate Criteria

> Rationale and escalation policy for relay-review.
> The actionable review checklist is in `reviewer-prompt.md` (single source).

## Why Fresh Review Matters

The executor has full implementation context, which paradoxically makes it blind to certain issues:

| Issue | Why the executor misses it |
|---|---|
| Over-complexity | Accumulated incrementally; feels "necessary" to the author |
| Stubs/placeholders | Author planned to fill but forgot |
| Convention violations | Didn't fully absorb existing codebase style |
| Integration issues | Focused on changed files; didn't check callers |
| Security blind spots | Focused on functionality, not threat modeling |

## Escalation Policy

### Re-dispatch immediately (no need to ask user)

Dead code, stale comments, magic numbers, N+1 queries, missing boundary validation, style inconsistency, stubs left behind.

**Rule:** If a senior engineer would apply without discussion → re-dispatch.

### Ask user before re-dispatching

Security decisions, design decisions, large refactors (20+ lines), user-visible behavior changes, race conditions.

**Rule:** If reasonable engineers could disagree → ask user first.

Note: The reviewer does NOT fix code directly — all fixes go through the executor via targeted re-dispatch.

## Decision: LGTM vs Re-dispatch

**LGTM when:** All faithfulness items pass, no critical security/data issues, no stubs remaining.

**Re-dispatch when:** Missing/misunderstood requirement, security issue, stubs in production paths.

**Re-dispatch rules:** file:line references, what to fix (not how), "do not change anything else".

**Convergence model:** Loop until all rubric factors meet target AND qualitative checks pass. The rubric anchors each round to the original scope — prevents drift. Safety cap: 20 rounds.

**After safety cap:** Escalate — show user the PR URL, list unresolved issues, let them decide. Hitting the cap means something is structurally wrong, not that more rounds would help.

## Lineage Grammar (#270 Phase B)

| Value | Meaning | `relates_to` guidance |
|---|---|---|
| `new` | First-time finding with no prior-round ancestor. | Omit unless a prior factor reference clarifies the finding. |
| `deepening` | The prior issue was valid, and this round exposes a narrower or deeper edge case rather than repeating the same blocker. | Reference the prior issue title, factor, or round/factor id. |
| `repeat` | The same semantic issue is still blocking the PR. | Reference the prior issue title, factor, or round/factor id. |
| `newly_scoreable` | A factor was previously blocked, missing evidence, or `not_run`, and is now scoreable with a concrete finding. | Reference the prior unscoreable factor or issue. |
| `unknown` | Relationship cannot be determined, including omitted lineage from older verdicts. | Omit unless a partial reference is known. |

Flip-flop suppression is narrow: when a factor flip-flops, `repeated_issue_count` is 0, and all current issues tied to the flipped factor have `lineage=deepening`, continue the review without escalation. Otherwise escalate. Missing lineage is coerced to `unknown`, which fails closed like `repeat`.

Example traces:
- `new`: `Behavior: r1:pass -> r2:fail` when round 2 finds a first-time issue in a factor with no prior blocker.
- `deepening`: `Behavior: r1:pass -> r2:fail -> r3:pass` when the round 3 finding is a deeper edge case tied to the same factor rather than the same issue.
- `repeat`: `Forensics: r1:fail -> r2:pass -> r3:fail` when the current finding restates a prior blocker.
- `newly_scoreable`: `Behavior: r1:not_run -> r2:fail -> r3:pass` when a previously unscoreable factor becomes reviewable and exposes a finding.

Non-regression guard: tamgu-note#1621 (PR 1634) and finjuice#416 (PR 417) both had `repeated_issue_count >= 1`, so they still escalate regardless of lineage. Phase B only suppresses the `repeated_issue_count === 0` progressive-deepening shape.
