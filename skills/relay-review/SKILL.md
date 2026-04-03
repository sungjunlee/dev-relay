---
name: relay-review
argument-hint: "[branch-name or PR-number]"
description: Independent PR review after Codex dispatch. Re-scores the rubric and reviews against Done Criteria in a fresh context, free from planning bias. On success, mark the run ready_to_merge.
context: fork
compatibility: "Must run in an isolated context to prevent planning bias (Claude Code: context: fork auto-handled; Codex/other: start a new session). Requires gh CLI."
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-merge"
---

# Relay Review

Independent PR review against the Done Criteria contract and scoring rubric. Use `scripts/review-runner.js` so round count, PR comments, and manifest transitions stay script-managed.

## Setup: Establish the anchor

1. Get the PR diff and Done Criteria (this runs in a fresh context — fetch everything needed):
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
BRANCH=$(gh pr view $PR_NUM --json headRefName -q '.headRefName')
gh pr diff $PR_NUM > /tmp/pr-diff.txt

# Issue number extraction — try each method until one succeeds:
ISSUE_NUM=$(gh pr view $PR_NUM --json closingIssuesReferences -q '.[0].number')
# Fallback 1: grep PR body for issue keywords
[ -z "$ISSUE_NUM" ] && ISSUE_NUM=$(gh pr view $PR_NUM --json body -q '.body' | grep -oiE '(closes|fixes|resolves|refs|related to) #[0-9]+' | grep -oE '[0-9]+' | head -1)
# Fallback 2: extract from branch name (try issue-<N> first, then any number)
if [ -z "$ISSUE_NUM" ]; then
  ISSUE_NUM=$(echo "$BRANCH" | grep -oE 'issue-[0-9]+' | grep -oE '[0-9]+')
  [ -z "$ISSUE_NUM" ] && ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | tail -1)
fi
# If all fail: escalate — cannot review without Done Criteria
[ -z "$ISSUE_NUM" ] && echo "ERROR: Cannot determine issue number. Provide it manually." && exit 1
gh issue view $ISSUE_NUM  # Done Criteria / Acceptance Criteria source
```

2. **Fix the anchor** — these do NOT change across rounds:
   - Done Criteria from the issue (the contract)
   - Rubric factors + targets from the Score Log (if relay-plan was used)
   - Original scope boundary ("do not change" areas)

3. Prepare the review bundle for the current round:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/review-runner.js --repo . --branch "$BRANCH" --pr "$PR_NUM" --prepare-only --json
```

This writes round artifacts under `.relay/runs/<run-id>/`, including:
- `review-round-N-prompt.md`
- `review-round-N-done-criteria.md`
- `review-round-N-diff.patch`

## Review Loop

Two phases, run in order. Each round re-measures against the **original anchor**, not the previous round's state.

### Phase 1: Spec Compliance

4. Review the diff against Done Criteria (see `references/reviewer-prompt.md` or the generated `review-round-N-prompt.md`):
   - **Faithfulness**: Each Done Criteria item implemented? Scope respected?
   - **Stubs/placeholders**: Any `return null`, empty bodies, TODO in production paths?
   - **Integration**: Does it break callers/consumers of changed code?
   - **Security**: Auth/token handling, input validation, injection risks?

5. **Rubric verification** (when Score Log present):
   - Re-run ALL automated checks independently — do not trust Codex's reported results
   - Re-score ALL evaluated factors with fresh eyes (1-10)
   - Any required factor below target → issue
   - Score divergence ≥2 points from Codex → flag for review

6. **Phase 1 gate**: Issues found → return a structured verdict with `verdict=changes_requested`, then re-dispatch (see Re-dispatch below). Do NOT proceed to Phase 2 until Phase 1 passes.

### Phase 2: Code Quality (only after Phase 1 PASS)

7. Run a code review skill on changed files — check code quality, patterns, conventions, structural issues (use the platform's best-matching skill, e.g., Claude Code: `/review`; if no skill available, perform the review inline)
8. Run a code simplification skill on changed files — unnecessary complexity, dead code, verbose patterns (use the platform's best-matching skill, e.g., Claude Code: `/simplify`; if no skill available, review for simplification inline)
9. Issues found → return `verdict=changes_requested`, then re-dispatch and **repeat from step 4** (Phase 1 — quality fixes can regress spec compliance)

### Drift and stuck detection (both phases)

Before any re-dispatch, check:
- **Scope:** Does the fix address a review issue, or is it scope creep?
- **Regression:** Are previously passing rubric factors still passing?
- **Churn:** Is the total diff growing without convergence?
- **Stuck:** Same issue 3+ consecutive rounds → escalate immediately (not fixable by Codex).

### Converge

10. Both phases pass → produce a structured verdict with:
    - `verdict=pass`
    - `next_action=ready_to_merge`
    - `issues=[]`

**Safety cap: 20 rounds total.** Ceiling, not target — most PRs converge in 1-3 rounds. Hitting the cap means something is structurally wrong; escalate.

## Verdict + Audit Trail

11. Apply the structured verdict with the review runner:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/review-runner.js --repo . --branch "$BRANCH" --pr "$PR_NUM" --review-file /tmp/review-verdict.json
```

The runner:
- validates the JSON verdict
- writes the PR audit comment
- updates the relay manifest to `ready_to_merge`, `changes_requested`, or `escalated`
- writes `review-round-N-verdict.json`
- writes `review-round-N-redispatch.md` when changes are requested

<!-- NOTE: Final verdict comment format is still parsed by gate-check.js via /Verdict:\s*(LGTM|ESCALATED)/. -->

## Re-dispatch (when issues found)

Use the generated `review-round-N-redispatch.md` artifact as the targeted fix prompt. It already includes the issue list, scope guardrail, and original Done Criteria.

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
