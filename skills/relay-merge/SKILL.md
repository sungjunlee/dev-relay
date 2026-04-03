---
name: relay-merge
argument-hint: "[PR-number]"
description: Merge a reviewed PR, clean up worktree/branch, close GitHub issues, and update sprint file if available. Use after relay-review returns LGTM.
compatibility: Requires gh CLI and git.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-review, dev-backlog"
---

# Relay Merge

Merge PR and close the loop after LGTM. **Requires relay-review PR comment.**

## Process

### 0. Gate check — verify relay-review completed

```bash
${CLAUDE_SKILL_DIR}/scripts/gate-check.js $PR_NUM
```

- Exit 0 (LGTM) → proceed to merge
- Exit 1 (no comment) → **STOP.** Run relay-review first
- Exit 1 (ESCALATED) → **STOP.** Show unresolved issues to user

**Intentional skip** (hotfix, manual PR, trivial change):
```bash
${CLAUDE_SKILL_DIR}/scripts/gate-check.js $PR_NUM --skip "reason here"
```
This writes a `<!-- relay-review-skip -->` comment to the PR — maintaining audit trail even when review is bypassed. The skip reason is recorded on the PR for future reference.

**Do NOT merge without running gate-check.** This is the audit trail that review actually happened (or was intentionally skipped with documented reason).

### 1. GitHub cleanup

```bash
gh pr merge $PR_NUM --squash
gh issue close <number> -c "Resolved in PR #$PR_NUM"
# Dispatch retains the worktree by default.
# Cleanup here: git worktree remove <worktree-path> && git branch -d <branch>
```

### 2. Sprint file update (if available)

If `backlog/sprints/` has an active sprint file, update it. If no sprint file exists, skip this step.

**Plan section** — mark completed (was `[~]` during review):
```markdown
- [x] #38 OAuth2 flow → PR #87 (merged)
```

**Progress section** — structured log entry with review round count:
```markdown
- 2026-03-25 10:50: #38 dispatched → PR #87 → reviewed (LGTM, round 1) → merged
```

**Running Context section** — capture learnings for remaining tasks:
```markdown
- OAuth2: PKCE flow using jose library. Tokens in httpOnly cookies.
```

### 3. Follow-up (if needed)

```bash
gh issue create --title "Follow-up: ..." --body "..."
```

Task file cleanup (move to `backlog/completed/`) happens at sprint end, not per-issue.

## Sprint File State Transitions

```
[ ] #N Task name                          ← not started
[~] #N Task name → PR #M (reviewing)     ← dispatched, review in progress
[x] #N Task name → PR #M (merged)        ← completed
```

## Sprint File Updates Summary

| Section | What to update | When |
|---------|---------------|------|
| **Plan** | `[~]` → `[x]` with PR ref | Every merge |
| **Progress** | Structured log with review rounds | Every merge |
| **Running Context** | Learnings that affect later tasks | When something was discovered |
| **Follow-up issues** | New GitHub issues | When review found out-of-scope work |
