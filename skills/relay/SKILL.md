---
name: relay
argument-hint: "[issue-number or task description]"
description: Execute the full relay cycle — plan, dispatch to Codex, review PR, merge. Reads from dev-backlog sprint files. Use when delegating work to Codex, codex에서 실행, 워크트리, relay.
compatibility: Requires Claude Code or Codex, gh CLI, git, and Node.js 18+.
metadata:
  related-skills: "relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
---

# Dev Relay

Execute the full plan → dispatch → review → merge cycle. Follow ALL steps below in order. Do NOT skip any step.

## Step 1: Read Context

Read the dev-backlog sprint file and task file for this issue:
- If a sprint file exists (`backlog/sprints/` with `status: active`), read it for Running Context and batch info
- Read the task file (`backlog/tasks/{PREFIX}-{N} - {Title}.md`) for Acceptance Criteria
- If no local task file, read from GitHub: `gh issue view <N>`

## Step 2: Plan

Build a scoring rubric from the Acceptance Criteria:
- **3+ AC items or quality-sensitive**: Follow relay-plan's process (Steps 1-3 only: read task → build rubric → generate prompt). Do NOT dispatch from relay-plan — Step 3 below handles dispatch.
- **Simple task (1-2 AC, bug fix, typo)**: Use the base template from `references/prompt-template.md`

Write the dispatch prompt to a temp file (e.g., `/tmp/dispatch-<N>.md`).

## Step 3: Dispatch (relay-dispatch)

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-<N> --prompt-file /tmp/dispatch-<N>.md --timeout 3600 --copy-env
```

Wait for completion. Check result:
- `status: "completed"` → proceed to Step 4
- `status: "completed-with-warning"` → check worktree for uncommitted work, proceed to Step 4
- `status: "failed"` → check failure table in relay-dispatch, fix and re-dispatch

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

Verify PR exists: `gh pr list --head issue-<N>`

Invoke **relay-review** (runs with `context: fork` for bias-free review). It will: check faithfulness against Done Criteria, detect stubs/placeholders, review security and integration, re-score rubric factors, and return LGTM or issues with file:line references.

Do NOT review inline — relay-review's forked context prevents planning bias.

## Step 5: Iterate (if issues found)

Re-dispatch with targeted fix prompt. **Include automated checks so Codex re-verifies:**

```
Fix these issues: [specific issues with file:line].
Do not change anything else. Push to the same branch.
After fixing, re-run: [automated check commands from rubric]
```

Re-review. **Max 2 rounds.** After that: show user PR URL + unresolved issues, let them decide.

## Step 6: Merge (relay-merge)

After LGTM:
```bash
gh pr merge <PR-NUM> --squash
gh issue close <N> -c "Resolved in PR #<PR-NUM>"
# Worktree is auto-cleaned by dispatch.js on success.
# If dispatch used --no-cleanup, run: git worktree remove <path> && git branch -d issue-<N>
```

Update dev-backlog sprint file:
- **Plan**: check off `[x] #<N>`
- **Progress**: add timestamped log entry (e.g., "2026-03-28: #540 dispatched → PR #89 → LGTM → merged")
- **Running Context**: add learnings that affect later tasks

Create follow-up issues if discovered during review.

## Summary Checklist

After completing the relay cycle, verify:
- [ ] Issue AC fully implemented (relay-review confirmed)
- [ ] PR merged and issue closed
- [ ] Sprint file updated (Plan checkbox, Progress entry)
- [ ] Running Context updated (if applicable)
- [ ] Follow-up issues created (if applicable)
