---
name: relay-merge
argument-hint: "[PR-number]"
description: Merge a reviewed PR, clean up worktree/branch, close GitHub issues, and update the sprint file. Use after relay-review returns LGTM. Handles the full post-merge loop including follow-up issue creation.
compatibility: Requires gh CLI and git.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-review, dev-backlog"
---

# Relay Merge

Merge PR and close the loop after LGTM.

## Process

### 1. GitHub cleanup

```bash
gh pr merge $PR_NUM --squash
gh issue close <number> -c "Resolved in PR #$PR_NUM"
git worktree remove <worktree-path>
git branch -d <branch>
```

### 2. Sprint file update

Update the dev-backlog sprint file (the essential part):

**Plan section** — check off completed item:
```markdown
- [x] #38 OAuth2 flow
```

**Progress section** — add timestamped log entry:
```markdown
- 2026-03-25 10:50: #38 PR LGTM → merged. Follow-up #51 created (token refresh edge case)
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

## Sprint File Updates Summary

| Section | What to update | When |
|---------|---------------|------|
| **Plan** | Check off `[x] #N` | Every merge |
| **Progress** | Timestamped log with PR link | Every merge |
| **Running Context** | Learnings that affect later tasks | When something was discovered |
| **Follow-up issues** | New GitHub issues | When review found out-of-scope work |
