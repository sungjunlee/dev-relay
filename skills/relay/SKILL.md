---
name: relay
argument-hint: "[issue-number or task description]"
description: Execute the full relay cycle — plan, dispatch to Codex, review PR, merge. Integrates with dev-backlog sprint files when available. Use when delegating work to Codex, codex에서 실행, 워크트리, relay.
compatibility: Requires Claude Code or Codex, gh CLI, git, and Node.js 18+. Task AC reading falls back to local files or user input.
metadata:
  related-skills: "relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
---

# Dev Relay

Execute the full plan → dispatch → review → merge cycle. Follow ALL steps below in order. Do NOT skip any step.

## Step 1: Read Context

Gather task details and sprint context:
1. **Task AC** (try in order, use first that succeeds):
   - Local task file: `backlog/tasks/{PREFIX}-{N} - {Title}.md`
   - GitHub: `gh issue view <N>`
   - User-provided description (from argument or conversation)
2. **Sprint context** (optional): If `backlog/sprints/` has an active sprint file, read Running Context and batch info. If no sprint file, proceed without — sprint tracking is skipped.

If no issue number, use a descriptive branch name (e.g., `feat/<slug>`) and skip issue-close in Step 6.

## Step 1.5: Check for in-flight work

Check if this issue already has a PR in progress:
```bash
PR_NUM=$(gh pr list --head issue-<N> --json number -q '.[0].number')
```
- PR exists and open → **skip Steps 2-3**, go directly to Step 4 (review)
- PR exists and merged → update sprint file to `[x]` (if exists), done
- PR not found → continue to Step 2

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

Get PR number:
```bash
PR_NUM=$(gh pr list --head issue-<N> --json number -q '.[0].number')
```

If sprint file exists, mark Plan item as in-flight: `[~] #42 OAuth2 flow → PR #89 (reviewing)`

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

Verify PR exists: `gh pr list --head issue-<N>`

Invoke **relay-review** (runs with `context: fork` for bias-free review). It loops until convergence:
- **Contract checks:** Done Criteria faithfulness, stubs, security, integration
- **Rubric verification:** Re-runs automated checks, re-scores evaluated factors independently
- **Quality checks:** `/review` + `/simplify` on changed files
- **Drift check:** Ensures fixes stay within original scope, no regressions
- **Verdict:** Writes LGTM or ESCALATED as a PR comment (`<!-- relay-review -->` marker)

The rubric from relay-plan anchors each iteration — prevents context drift across rounds. Safety cap: 20 rounds (most PRs converge in 1-3).

Do NOT review inline — relay-review's forked context prevents planning bias.

## Step 5: Merge (relay-merge)

relay-merge runs `gate-check.js` as its first step — this verifies the relay-review PR comment exists. If missing, it blocks merge and tells you to run `/relay-review` first (or `--skip <reason>` for intentional bypass).
```bash
gh pr merge <PR-NUM> --squash
gh issue close <N> -c "Resolved in PR #<PR-NUM>"
# Worktree is auto-cleaned by dispatch.js on success.
# If dispatch used --no-cleanup, run: git worktree remove <path> && git branch -d issue-<N>
```

If sprint file exists, update it:
- **Plan**: check off `[x] #<N>` (was `[~]` during dispatch)
- **Progress**: add structured log entry (e.g., "2026-03-28: #540 dispatched → PR #89 → reviewed (LGTM, round 2) → merged")
- **Running Context**: add learnings that affect later tasks

Create follow-up issues if discovered during review.

## Summary Checklist

After completing the relay cycle, verify:
- [ ] Issue AC fully implemented (relay-review confirmed)
- [ ] PR has `<!-- relay-review -->` LGTM comment (or `<!-- relay-review-skip -->` with reason)
- [ ] PR merged and issue closed
- [ ] Sprint file updated — if exists (Plan `[x]`, Progress entry with review round count)
- [ ] Follow-up issues created (if applicable)
