---
name: relay
argument-hint: "[issue-number or task description]"
description: Execute the full relay cycle — plan, dispatch, review, merge. Use when implementing a GitHub issue or task through autonomous executor dispatch. Integrates with dev-backlog sprint files.
compatibility: Requires Claude Code or Codex, gh CLI, git, Node.js 18+.
metadata:
  related-skills: "relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge, relay-sidecar, dev-backlog"
  keywords: "릴레이, 자동 실행, plan, dispatch, review, merge, relay cycle"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; role overrides use `RELAY_ORCHESTRATOR`/`RELAY_REVIEWER`; examples use `ISSUE_BODY_FILE`, `RUN_MANIFEST`, `ISSUE_NUMBER`, `BRANCH`, `PREFLIGHT`, `SUMMARY`, `RUN_ID`, and `PR_NUM`.
- Files: task/issue text, optional sprint file, readiness probe inputs, `/tmp/dispatch-<N>.md`, and `/tmp/rubric-<N>.yaml`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Dev Relay

Execute the plan → dispatch → review cycle. Stop at `ready_to_merge` unless the user explicitly asks to merge. Follow ALL steps below in order.

## Role Defaults

| Role | Default | Override |
|------|---------|----------|
| Orchestrator | `unknown` until explicitly stamped | `RELAY_ORCHESTRATOR` env |
| Executor | Codex | `--executor` flag |
| Reviewer | `unknown` until explicitly stamped | `--reviewer` flag, `RELAY_REVIEWER` env |

Standard Codex path: stamp `RELAY_ORCHESTRATOR=codex` and run review through `review-runner --reviewer codex`. Assigned manifest roles stay immutable; the acting reviewer for a round is recorded separately under `review.last_reviewer` and the `review_apply` event.

## Step 1: Re-Anchor and Route

Run `git fetch origin`; if a sprint file exists, re-read Running Context and completed/in-flight status changes. Apply any previous-task context before proceeding.

Task evidence: use the first available source: local task file `backlog/tasks/{PREFIX}-{N} - {Title}.md`, `gh issue view <N>`, or the user-provided description. If `backlog/sprints/` has an active sprint, read Running Context and batch info; otherwise skip sprint tracking. If no issue number, use a descriptive branch name (e.g., `feat/<slug>`) and skip issue-close in the merge phase.

Run the deterministic route preflight; if readiness is already covered by a prior relay-ready artifact, explicit `--bypass-readiness`, or sprint-batch handoff, add `--bypass-readiness --skip-readiness-reason <reason>`.

```bash
PREFLIGHT=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" \
  --body-file "$ISSUE_BODY_FILE" --manifest "$RUN_MANIFEST" --json)
```

Branch on the JSON using [preflight-guards.md](references/preflight-guards.md); only evaluate readiness when `inflight.route == "continue"`.
- `inflight.route == "existing-open-pr"` → set `PR_NUM`, skip Steps 2-3, and review the existing PR.
- `inflight.route == "existing-merged-pr"` → update the sprint file to `[x]` if present and stop.
- `inflight.route == "inflight-run"` → resume or inspect that run; continue at its manifest state.
- `readiness.bypass == true` → proceed to Step 2.
- `readiness.bypass == false` and `.decision.prompt_allowed == true` → set `SUMMARY=.readiness.signals_summary` and issue exactly `AskUserQuestion("Readiness gaps detected: ${SUMMARY}. Invoke relay-ready first? [y/n/abort]")`.
- `chain-y` → invoke relay-ready Q&A, wait, persist the handoff, set `manifest.anchor.readiness`, then resume Step 2.
- `chain-n` → emit `bypass_override_by_user` from `.decision.branch_labels["chain-n"].event_payload`, then proceed to Step 2.
- `chain-abort` → emit `readiness_check_failed` from `.decision.branch_labels["chain-abort"].event_payload`, then close the run.
- `noninteractive-fail` → emit `readiness_check_failed_nontty` from `.decision.branch_labels["noninteractive-fail"].event_payload`, then close the run.

Fast path: bypass relay-ready only when the input is already one relay-ready task with a stable review anchor and no clarification/decomposition needed. Otherwise run `relay-ready`, persist a request artifact, and use `relay-ready/<leaf-id>.md` as the downstream source of truth.

## Step 2: Plan

**Always build a rubric.** Follow relay-plan's planning process (read task → recover Done Criteria → build rubric → emit handoff artifacts). Do NOT dispatch from relay-plan — Step 3 below handles dispatch. See `relay-plan` SKILL.md for rubric depth by task size (S/M/L/XL).

Write the dispatch prompt to a temp file (e.g., `/tmp/dispatch-<N>.md`).
If relay-ready ran, the relay-ready handoff brief becomes the task source of truth for planning.
Write the rubric YAML to a temp file (e.g., `/tmp/rubric-<N>.yaml`).

## Step 3: Dispatch (relay-dispatch)

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  -b issue-<N> --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml --timeout 3600
# If relay-ready ran, append: --request-id <id> --leaf-id <id> --done-criteria-file <done-criteria-path>
```

While dispatch runs in the background, optionally monitor progress:
```bash
git -C <worktree> log --oneline
wc -l <stdoutLog>
```

Wait for completion. Check result:
- `status: "completed"` and `runState: "review_pending"` → proceed to Step 4
- `status: "completed-with-warning"` and `runState: "review_pending"` → executor timed out but made progress; check worktree, proceed to Step 4
- `status: "failed"` and `runState: "escalated"` → inspect the dispatch error / manifest, fix and re-dispatch

Capture `runId`, `manifestPath`, and `runState` from dispatch output. Get PR number:
```bash
PR_NUM=$(gh pr list --head issue-<N> --json number -q '.[0].number')
```

The manifest is written under `~/.relay/runs/<repo-slug>/`. Readiness linkage is recorded there, but the run lifecycle remains execution-only. If a sprint file exists, mark Plan item as in-flight: `[~] #42 OAuth2 flow → PR #89 (reviewing)`.

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

Verify PR exists: `gh pr list --head issue-<N>`.

Snapshot review state before invoking relay-review:
```bash
REVIEW_BEFORE=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --json)
```

Invoke **relay-review** in an isolated context (no planning bias). It runs two phases (Spec Compliance → Code Quality), re-dispatches on issues, and updates manifest state. The rubric from relay-plan anchors each iteration. Safety cap: 20 rounds (most PRs converge in 1-3). Do NOT review inline.

After review returns, compare against the snapshot:
```bash
PREVIOUS_ROUNDS=<rounds>
PREVIOUS_VERDICT=<verdict>
REVIEW_AFTER=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" \
  --previous-rounds "$PREVIOUS_ROUNDS" --previous-verdict "$PREVIOUS_VERDICT" --json)
```

If `.comparison.stale == true`, treat review as stalled and recover by running the runner directly in the foreground:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --json
```
Wait for exit, then repeat the same preflight comparison before Step 5. See [preflight-guards.md](references/preflight-guards.md) for the stale-review SHA fields.

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
