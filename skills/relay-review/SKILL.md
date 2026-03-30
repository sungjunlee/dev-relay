---
name: relay-review
argument-hint: "[branch-name or PR-number]"
description: Independent PR review after Codex dispatch. Re-scores the rubric and reviews against Done Criteria in a fresh context, free from planning bias. Returns LGTM or specific issues with file:line references.
context: fork
compatibility: Must run in an isolated context to prevent planning bias (Claude Code: context:fork auto-handled; Codex/other: start a new session). Requires gh CLI.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-merge"
---

# Relay Review

Independent PR review against the Done Criteria contract and scoring rubric. Loops until convergence — the rubric anchors each iteration to prevent drift.

## Setup: Establish the anchor

1. Get the PR diff and Done Criteria (this runs in a fresh context — fetch everything needed):
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt

# Issue number extraction — try each method until one succeeds:
ISSUE_NUM=$(gh pr view $PR_NUM --json closingIssuesReferences -q '.[0].number')
# Fallback 1: grep PR body for issue keywords
[ -z "$ISSUE_NUM" ] && ISSUE_NUM=$(gh pr view $PR_NUM --json body -q '.body' | grep -oiE '(closes|fixes|resolves|refs|related to) #[0-9]+' | grep -oE '[0-9]+' | head -1)
# Fallback 2: extract from branch name (try issue-<N> first, then any number)
if [ -z "$ISSUE_NUM" ]; then
  BRANCH=$(gh pr view $PR_NUM --json headRefName -q '.headRefName')
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

## Review Loop

Two phases, run in order. Each round re-measures against the **original anchor**, not the previous round's state.

### Phase 1: Spec Compliance

3. Review the diff against Done Criteria (see `references/reviewer-prompt.md`):
   - **Faithfulness**: Each Done Criteria item implemented? Scope respected?
   - **Stubs/placeholders**: Any `return null`, empty bodies, TODO in production paths?
   - **Integration**: Does it break callers/consumers of changed code?
   - **Security**: Auth/token handling, input validation, injection risks?

4. **Rubric verification** (when Score Log present):
   - Re-run ALL automated checks independently — do not trust Codex's reported results
   - Re-score ALL evaluated factors with fresh eyes (1-10)
   - Any required factor below target → issue
   - Score divergence ≥2 points from Codex → flag for review

5. **Phase 1 gate**: Issues found → re-dispatch (see Re-dispatch below), re-fetch diff, **repeat from step 3**. Do NOT proceed to Phase 2 until Phase 1 passes.

### Phase 2: Code Quality (only after Phase 1 PASS)

6. Run a code review skill on changed files — check code quality, patterns, conventions, structural issues (e.g., Claude Code: `/review`; Codex: `review` agent skill)
7. Run a code simplification skill on changed files — unnecessary complexity, dead code, verbose patterns (e.g., Claude Code: `/simplify`; Codex: `simplify` agent skill)
8. Issues found → re-dispatch, **repeat from step 3** (Phase 1 — quality fixes can regress spec compliance)

### Drift and stuck detection (both phases)

Before any re-dispatch, check:
- **Scope:** Does the fix address a review issue, or is it scope creep?
- **Regression:** Are previously passing rubric factors still passing?
- **Churn:** Is the total diff growing without convergence?
- **Stuck:** Same issue 3+ consecutive rounds → escalate immediately (not fixable by Codex).

### Converge

9. Both phases pass → proceed to Verdict

**Safety cap: 20 rounds total.** Ceiling, not target — most PRs converge in 1-3 rounds. Hitting the cap means something is structurally wrong; escalate.

## Verdict + Audit Trail

10. All checks pass → write **LGTM PR comment**:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: LGTM
Contract: PASS — all Done Criteria verified
Quality: PASS — /review and /simplify clean
Rounds: <N>
Rubric scores (if applicable):
| Factor | Target | Codex | Claude | Status |
|--------|--------|-------|--------|--------|
| ...    | ...    | ...   | ...    | PASS   |
EOF
)"
```
<!-- NOTE: Verdict line format is parsed by relay and relay-merge gate checks via grep -oE 'Verdict: (LGTM|ESCALATED)'. Do not add markdown formatting. -->

11. Hit safety cap or stuck → escalate to user. Still write audit trail:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: ESCALATED — unresolved after <N> rounds
Issues: [list with file:line]
EOF
)"
```

## Re-dispatch (when issues found)

Targeted fix via relay-dispatch. Always include the anchor context:
```
Fix these issues in the PR: [specific issues with file:line].
Do not change anything else. Push to the same branch.

Original Done Criteria (for scope reference):
[paste Done Criteria from issue]

After fixing, re-run these checks and confirm they pass:
[paste automated check commands from the original rubric]
```

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
