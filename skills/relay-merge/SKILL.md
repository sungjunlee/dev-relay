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
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: reviewed PR, retained run manifest/worktree, optional sprint file, and follow-up issue text.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/gate-check.js`, `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/finalize-run.js`, `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/append-learnings.js`.

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

After the merge is confirmed, `finalize-run.js` invokes `append-learnings.js` to record a one-line learning in the target repo's `spec/capabilities.md`. Learning failures are recorded under `result.learnings` and never block cleanup. No-op/fail-loud conditions and durability semantics: [`references/append-learnings.md`](references/append-learnings.md).

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

Task file cleanup (move to `backlog/completed/`) happens at sprint end, not per-issue. Sprint checkbox states are `[ ]` not started → `[~]` reviewing → `[x]` merged, exactly as shown in the section 2 examples; sprint-file semantics belong to `dev-backlog`.
