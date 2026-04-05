---
name: relay
argument-hint: "[issue-number or task description]"
description: Execute the full relay cycle — plan, dispatch, review, merge. Use when implementing a GitHub issue or task through autonomous executor dispatch. Integrates with dev-backlog sprint files.
compatibility: Requires Claude Code or Codex, gh CLI, git, and Node.js 18+. Task AC reading falls back to local files or user input.
metadata:
  related-skills: "relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
---

# Dev Relay

Execute the plan → dispatch → review cycle. Stop at `ready_to_merge` unless the user explicitly asks to merge. Follow ALL steps below in order.

## Role Defaults

| Role | Default | Override |
|------|---------|----------|
| Orchestrator | Claude Code | `RELAY_ORCHESTRATOR` env |
| Executor | Codex | `--executor` flag |
| Reviewer | Codex (read-only) | `--reviewer` flag, `RELAY_REVIEWER` env |

These defaults work well for most workflows. Override per-role when using different agents or self-hosted models.

## Step 0: Re-Anchor

Always run before every task — standalone or batch. Ensures current state, not stale context.

1. `git fetch origin` — check for divergence from remote
2. If sprint file exists: re-read it. Check Running Context for new entries from previous tasks. Note completed/in-flight task status changes.
3. If previous task added Running Context that affects this task, adjust your approach before proceeding.

No sprint file? Just do the `git fetch`. Takes <5 seconds; never skip this step.

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

While dispatch runs in the background, optionally monitor progress:
```bash
git -C <worktree> log --oneline        # new commits
wc -l <stdoutLog>                       # output growth
```

Wait for completion. Check result:
- `status: "completed"` and `runState: "review_pending"` → proceed to Step 4
- `status: "completed-with-warning"` and `runState: "review_pending"` → executor timed out but made progress; check worktree, proceed to Step 4
- `status: "failed"` and `runState: "escalated"` → inspect the dispatch error / manifest, fix and re-dispatch

Capture the run metadata from dispatch output:
- `runId`
- `manifestPath`
- `runState`

Get PR number:
```bash
PR_NUM=$(gh pr list --head issue-<N> --json number -q '.[0].number')
```

The manifest is written under `~/.relay/runs/<repo-slug>/`. This is the shared state surface for later review/merge lifecycle work.

Current scope: dispatch writes the manifest. Review and merge still follow their existing PR-comment and gate-check flow.

If sprint file exists, mark Plan item as in-flight: `[~] #42 OAuth2 flow → PR #89 (reviewing)`

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

Verify PR exists: `gh pr list --head issue-<N>`

Invoke **relay-review** in an isolated context (no planning bias). The review runner manages rounds, PR comments, and manifest updates. See relay-review's **Context Isolation** section for per-platform mechanisms — adapter scripts handle this automatically when using `--reviewer`.

- **Phase 1 — Spec Compliance:** Done Criteria faithfulness, stubs, security, integration, rubric re-verification. Must pass before Phase 2.
- **Phase 2 — Code Quality:** Code review + simplification on changed files. Issues re-dispatch back to Phase 1.
- **Runner:** `scripts/review-runner.js` invokes an isolated reviewer via adapter (built-in: `codex`, `claude`), rejects reviewer-written diffs, posts the PR comment, and updates manifest state

The rubric from relay-plan anchors each iteration — prevents context drift across rounds. Safety cap: 20 rounds (most PRs converge in 1-3).

Do NOT review inline — relay-review must run in an isolated context to prevent planning bias.

## Step 5: Ready to Merge

If relay-review returns LGTM, the review runner should already have recorded the run as `ready_to_merge`. Do not mark the sprint task complete yet. Only run relay-merge when the user explicitly wants to land the PR.

Create follow-up issues if discovered during review.

## Batch Mode

When multiple independent tasks are ready, dispatch them in parallel instead of sequential relay cycles.

### Flow: Plan all → Dispatch all → Review as completed → Merge one-by-one

1. **Plan all tasks** — follow Steps 0 through 2 (including 1.5) for each task. Write each dispatch prompt to its own temp file.
2. **Dispatch all** — run dispatch.js for each task asynchronously (in the background). Mark all as `[~]` in sprint file.
3. **Review as completed** — as each dispatch finishes, run Step 4 (relay-review). No need to wait for all.
4. **Merge one-by-one** — merge each ready PR sequentially only after explicit approval. After each merge, check remaining PRs for conflicts.
5. **Re-anchor** — after the batch completes, run Step 0 before starting the next batch.

### Merge conflict recovery

If a ready-to-merge PR has conflicts after an earlier merge:
1. In the worktree: `git fetch origin && git rebase origin/main`
2. Re-review the rebased PR (run relay-review again — Phase 1 from scratch)
3. Merge

### Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does — if conflict arises, rebase the rest.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.

## Summary Checklist

After completing the relay cycle, verify:
- [ ] Issue AC fully implemented (relay-review confirmed)
- [ ] PR has `<!-- relay-review -->` LGTM comment (or `<!-- relay-review-skip -->` with reason)
- [ ] PR marked `ready_to_merge`, or merged and closed if relay-merge was explicitly requested
- [ ] Sprint file updated — if exists (Plan `[x]`, Progress entry with review round count)
- [ ] Follow-up issues created (if applicable)
