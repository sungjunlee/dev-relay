---
name: relay-review
argument-hint: "[branch-name or PR-number]"
description: Independent PR review after Codex dispatch. Re-scores the rubric and reviews against Done Criteria in a fresh context, free from planning bias. Returns LGTM or specific issues with file:line references.
context: fork
compatibility: context:fork requires Claude Code. Other agents should start a new session before reviewing. Requires gh CLI.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-merge"
---

# Relay Review

Independent PR review against the Done Criteria contract and scoring rubric. Three mandatory phases — all must pass for LGTM.

## Phase 1: Contract Review

1. Get the PR diff and Done Criteria (this runs in a fresh context — fetch everything needed):
```bash
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
ISSUE_NUM=$(gh pr view $PR_NUM --json body -q '.body' | grep -oE '#[0-9]+' | head -1 | tr -d '#')
gh issue view $ISSUE_NUM  # Done Criteria / Acceptance Criteria source
```
   If a Score Log exists in the PR description, extract the rubric from it.

2. Review the diff against Done Criteria (see `references/reviewer-prompt.md`):
   - **Faithfulness**: Each Done Criteria item implemented? Scope respected?
   - **Stubs/placeholders**: Any `return null`, empty bodies, TODO in production paths?
   - **Integration**: Does it break callers/consumers of changed code?
   - **Security**: Auth/token handling, input validation, injection risks?

3. **Rubric verification** (when PR includes a Score Log from relay-plan):
   - **Re-run ALL automated checks** independently — do not trust Codex's reported results
   - **Re-score ALL evaluated factors** with fresh eyes (1-10)
   - Compare Claude's scores against Codex's final iteration scores
   - Any required factor below target or significant score divergence (≥2 points) → treat as issue

   This is the quantitative gate. Combined with step 2 (qualitative), both must pass.

4. Issues found → re-dispatch (see Re-dispatch below). **Max 2 rounds for Phase 1.**

## Phase 2: Quality Review

After Phase 1 passes, run Claude's own quality checks on the PR branch:

5. Run `/review` — code quality, patterns, conventions, structural issues
6. Run `/simplify` on changed files — unnecessary complexity, dead code

These are **mandatory, not optional**. Both must complete before Phase 3.

7. Issues found → re-dispatch with `/review` or `/simplify` findings. **Max 1 round for Phase 2.**

## Phase 3: Verdict + Audit Trail

8. Both phases pass → write **LGTM PR comment** for audit trail:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: LGTM
Phase 1 (Contract): PASS — all Done Criteria verified
Phase 2 (Quality): PASS — /review and /simplify clean
Rounds: <N> (Phase 1: <n1>, Phase 2: <n2>)
Rubric scores (if applicable):
| Factor | Target | Codex | Claude | Status |
|--------|--------|-------|--------|--------|
| ...    | ...    | ...   | ...    | PASS   |
EOF
)"
```
<!-- NOTE: Verdict line format is parsed by relay and relay-merge gate checks via grep -oE 'Verdict: (LGTM|ESCALATED)'. Do not add markdown formatting. -->

9. Issues remain after rounds exhausted → escalate to user with PR URL + unresolved issues. Still write a PR comment recording the incomplete review:
```bash
gh pr comment $PR_NUM --body "$(cat <<'EOF'
<!-- relay-review -->
## Relay Review
Verdict: ESCALATED — unresolved issues after max rounds
Issues: [list with file:line]
EOF
)"
```

## Re-dispatch (when issues found)

Targeted fix via relay-dispatch:
```
Fix these issues in the PR: [specific issues with file:line].
Do not change anything else. Push to the same branch.
After fixing, re-run these checks and confirm they pass:
[paste automated check commands from the original rubric]
```

See `references/evaluate-criteria.md` for escalation policy (auto re-dispatch vs ask user).
