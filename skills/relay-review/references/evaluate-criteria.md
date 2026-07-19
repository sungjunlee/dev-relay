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

**Convergence model:** Compact assurance allows one post-publication review. Standard
allows two review rounds: one independent review, one targeted re-dispatch when
needed, then one review of the corrected result. Hardened allows three rounds for
the existing pre-publication, targeted-repair, and post-publication path.

An explicit extended policy for experimental work may persist a still-higher `review.max_rounds`. It
retains repeated-issue, flip-flop, SHA, and audit gates.

**After the configured cap:** Escalate — show the user the PR URL, list unresolved
issues, and let them decide. More default rounds are not evidence of convergence.

Lineage grammar for repeated review findings is documented separately in `review-lineage.md`.
