---
name: relay
argument-hint: "[issue-number or task description]"
description: Execute the full relay cycle — plan, dispatch, review, merge. Use when implementing a GitHub issue or task through autonomous executor dispatch. Integrates with dev-backlog sprint files.
compatibility: Requires Claude Code or Codex, gh CLI, git, Node.js 18+.
metadata:
  related-skills: "relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
---

# Dev Relay

Execute the plan → dispatch → review cycle. Stop at `ready_to_merge` unless the user explicitly asks to merge. Follow ALL steps below in order.

## Role Defaults

| Role | Default | Override |
|------|---------|----------|
| Orchestrator | `unknown` until explicitly stamped | `RELAY_ORCHESTRATOR` env |
| Executor | Codex | `--executor` flag |
| Reviewer | `unknown` until explicitly stamped | `--reviewer` flag, `RELAY_REVIEWER` env |

Standard Codex path: stamp `RELAY_ORCHESTRATOR=codex` and run review through `review-runner --reviewer codex`. Assigned manifest roles stay immutable; the acting reviewer for a round is recorded separately under `review.last_reviewer` and the `review_apply` event.

## Step 0: Re-Anchor

Before every standalone or batch task, run `git fetch origin`; if a sprint file exists, re-read Running Context and completed/in-flight status changes. Apply any previous-task context before proceeding.

## Step 1: Route and Read Context

Task evidence: use the first available source: local task file `backlog/tasks/{PREFIX}-{N} - {Title}.md`, `gh issue view <N>`, or the user-provided description. If `backlog/sprints/` has an active sprint, read Running Context and batch info; otherwise skip sprint tracking.

Fast path: bypass relay-ready only when the input is already one relay-ready task with a stable review anchor and no clarification/decomposition needed. Otherwise run `relay-ready`, persist a request artifact, and use `relay-ready/<leaf-id>.md` as the downstream source of truth.

If no issue number, use a descriptive branch name (e.g., `feat/<slug>`) and skip issue-close in Step 6.

### Readiness path

If readiness is required, persist a single-leaf contract first:

```bash
${CLAUDE_SKILL_DIR}/../relay-ready/scripts/persist-request.js --repo . --contract-file /tmp/relay-ready-contract.json --json
```

Carry forward the handoff brief, frozen Done Criteria snapshot, and linkage: `request_id`, `leaf_id`.

## Readiness probe + chain prompt
Before Step 2, run this unless bypassed by a prior relay-ready artifact with `readiness_score` and frozen review anchor, explicit `--bypass-readiness`, or a sprint-batch entry already linked to a relay-ready handoff:

```bash
PROBE=$(node ${CLAUDE_SKILL_DIR}/../relay-ready/scripts/probe-readiness.js \
  --json --body-file "$ISSUE_BODY_FILE" --manifest "$RUN_MANIFEST" --issue-number "$ISSUE_NUMBER")
BYPASS=$(printf '%s' "$PROBE" | jq -r '.bypass')
SUMMARY=$(printf '%s' "$PROBE" | jq -r '.signals_summary')
NEXT_ACTION=$(printf '%s' "$PROBE" | jq -r '.next_action')
```

The CLI emits `readiness_probe`. If `BYPASS=true`, proceed to Step 2. If `BYPASS=false` and interactive (TTY and no `--non-interactive`), issue exactly:
`AskUserQuestion("Readiness gaps detected: ${SUMMARY}. Invoke relay-ready first? [y/n/abort]")`

Branch labels and events:
- `chain-y` / `readiness_probe`: invoke relay-ready Q&A, wait, persist the handoff, set `manifest.anchor.readiness`, then resume Step 2.
- `chain-n` / `bypass_override_by_user`: emit with current scores and proceed to Step 2.
- `chain-abort` / `readiness_check_failed`: emit with current scores, close the run.
- `noninteractive-fail` / `readiness_check_failed_nontty`: emit when `BYPASS=false` and no prompt is allowed, then close the run.

## Step 1.5: Check for in-flight work

Check if this issue already has a PR in progress:
```bash
PR_NUM=$(gh pr list --head issue-<N> --json number -q '.[0].number')
```
- PR exists and open → **skip Steps 2-3**, go directly to Step 4 (review)
- PR exists and merged → update sprint file to `[x]` (if exists), done
- PR not found → continue to Step 2

## Step 2: Plan

**Always build a rubric.** Follow relay-plan's planning process (read task → recover Done Criteria → build rubric → generate prompt). Do NOT dispatch from relay-plan — Step 3 below handles dispatch. See `relay-plan` SKILL.md for rubric depth by task size (S/M/L/XL).

Write the dispatch prompt to a temp file (e.g., `/tmp/dispatch-<N>.md`).
If relay-ready ran, the relay-ready handoff brief becomes the task source of truth for planning.
Write the rubric YAML to a temp file (e.g., `/tmp/rubric-<N>.yaml`).

## Step 3: Dispatch (relay-dispatch)

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b issue-<N> --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml --timeout 3600
# If relay-ready ran, append: --request-id <id> --leaf-id <id> --done-criteria-file <done-criteria-path>
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

The manifest is written under `~/.relay/runs/<repo-slug>/`. This is the shared state surface for later review/merge lifecycle work. Readiness linkage is recorded there, but the run lifecycle remains execution-only.

Current scope: dispatch writes the manifest. Review and merge still follow their existing PR-comment and gate-check flow.

If sprint file exists, mark Plan item as in-flight: `[~] #42 OAuth2 flow → PR #89 (reviewing)`

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

Verify PR exists: `gh pr list --head issue-<N>`

Invoke **relay-review** in an isolated context (no planning bias). It runs two phases (Spec Compliance → Code Quality), re-dispatches on issues, and updates manifest state. See `relay-review` SKILL.md for the Phase 1/2 procedure, Context Isolation per platform, and runner details.

The rubric from relay-plan anchors each iteration — prevents context drift across rounds. Safety cap: 20 rounds (most PRs converge in 1-3).

Do NOT review inline — relay-review must run in an isolated context to prevent planning bias.

## Step 5: Ready to Merge

If relay-review returns LGTM, the review runner should already have recorded the run as `ready_to_merge`. Do not mark the sprint task complete yet. Only run relay-merge when the user explicitly wants to land the PR.

Create follow-up issues if discovered during review.

## Batch Mode

When multiple independent tasks are ready, dispatch in parallel instead of running sequential relay cycles. See `references/batch-mode.md` for the full flow (plan all → dispatch all → review as completed → merge one-by-one), merge-conflict recovery, and the "when in doubt, run sequentially" principle.

## Summary Checklist

After completing the relay cycle, verify:
- [ ] Done Criteria fully implemented (relay-review confirmed)
- [ ] PR has `<!-- relay-review -->` LGTM comment (or `<!-- relay-review-skip -->` with reason)
- [ ] PR marked `ready_to_merge`, or merged and closed if relay-merge was explicitly requested
- [ ] Sprint file updated — if exists (Plan `[x]`, Progress entry with review round count)
- [ ] Follow-up issues created (if applicable)
