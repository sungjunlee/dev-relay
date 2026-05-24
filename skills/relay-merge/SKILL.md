---
name: relay-merge
argument-hint: "[run-id or PR-number]"
description: Merge a reviewed PR, clean up worktree/branch, and close GitHub issues. Use after relay-review returns LGTM.
compatibility: Requires gh CLI and git.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-dispatch, relay-review, dev-backlog"
  keywords: "머지, 병합, merge, finalize, cleanup"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; examples use `PR_NUM` and `RUN_ID`.
- Files: reviewed PR, retained run manifest/worktree, optional sprint file, and follow-up issue text.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/gate-check.js`, `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/finalize-run.js`, `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/append-learnings.js` (invoked from finalize-run post-merge; structurally bounded writer for target repo's `spec/capabilities.md`, followed by a durable commit/push when safe).

# Relay Merge

## Use when

- Merging a PR after `relay-review` returns LGTM/pass
- Finalizing the retained run manifest, worktree, and branch cleanup
- Recording sprint-file and follow-up issue updates after merge

## Do not use when

- Reviewing executor output — use `relay-review`
- Delegating implementation or review fixes — use `relay-dispatch`
- Authoring rubrics or dispatch prompts — use `relay-plan`
- Shaping an ambiguous task before planning — use `relay-ready`

Explicitly merge a ready-to-merge PR and close the loop. **Requires relay-review PR comment.**

## Process

### 0. Gate check — verify relay-review completed

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/gate-check.js" $PR_NUM
```

- Exit 0 (LGTM) → PR is ready to merge; proceed only if the user wants to land it now
- Exit 1 (no comment) → **STOP.** Run relay-review first
- Exit 1 (stale LGTM) → **STOP.** Run relay-review again for the latest commit
- Exit 1 (CHANGES_REQUESTED) → **STOP.** Re-dispatch or fix the branch first
- Exit 1 (ESCALATED) → **STOP.** Show unresolved issues to user

**Intentional skip** (hotfix, manual PR, trivial change):
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/gate-check.js" $PR_NUM --skip "reason here"
```
This writes a `<!-- relay-review-skip -->` comment to the PR — maintaining audit trail even when review is bypassed. The skip reason is recorded on the PR for future reference.
`gate-check.js --skip` does not invoke any executor or reviewer, so it does not consume manifest `model_hints`.

**Do NOT merge without running gate-check.** This is the audit trail that review actually happened (or was intentionally skipped with documented reason).

### 1. Merge + finalize cleanup

```bash
RUN_ID=<run-id-from-dispatch>
node "${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/finalize-run.js" --repo . --run-id "$RUN_ID" --merge-method squash --json
```

This script:
- re-checks the latest PR audit trail and blocks merge if `review.last_reviewed_sha` is stale for the current HEAD
- merges the PR and only advances the manifest after GitHub reports the PR as `MERGED`
- best-effort deletes the remote branch after the merge is confirmed
- marks the manifest `merged`
- best-effort closes the linked issue
- removes the retained worktree, deletes the local merged branch, and runs `git worktree prune`
- records `cleanup.status` in the manifest

If the retained worktree is dirty, merge still succeeds but cleanup is recorded as `failed` and the manifest moves to `next_action=manual_cleanup_required`.

After the merge state advances to `MERGED` (and before cleanup runs), `finalize-run.js` invokes `append-learnings.js` to write a one-line entry into the matching capability's `## Learnings` block in the target repo's `spec/capabilities.md`. The script is the only writer for that section (anti-adversarial-Goodhart structural defense — see dev-backlog spec-system v0.1 design doc). It no-ops gracefully when `spec/capabilities.md` is absent, the active sprint has no `component:`, or the component does not resolve. It fails loud when multiple active sprints make the target ambiguous. When an entry is appended, `finalize-run.js` commits and pushes the change from the target repo's base branch when the repo is clean; unsafe cases are recorded under `result.learnings.durability` as manual actions. Any learning failure is recorded under `result.learnings` and does not block cleanup.

Emergency, force-finalize, and bootstrap reconciliation paths: see [`references/operator-emergencies.md`](references/operator-emergencies.md).

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
