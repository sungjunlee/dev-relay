# Recovery Playbook

Operator-facing recovery commands for `relay-dispatch`. These cover the two canonical "happy path failed but the work is salvageable" scenarios: the executor finished without committing, and the manifest state needs to advance after an external event. Both replace ad-hoc shell sequences with structured, audit-trailed commands — prefer them over hand-edits.

## Executor completed but did not commit

`recover-commit.js` handles the canonical "executor finished implementation but timed out before committing" path. Replaces the ad-hoc `git add -A && git commit && git push -u && gh pr create` shell sequence with a single command that preflights, commits via template, pushes (no force), creates the PR (idempotent on re-run), stamps `git.pr_number` via the shared lock helper, and emits a `recover_commit` event. Manifest STATE stays `review_pending` — the next step is the normal review.

```bash
# Standard recovery — dispatch returned commits="" + uncommitted!=""
${CLAUDE_SKILL_DIR}/scripts/recover-commit.js --run-id <id> \
  --reason "executor timeout at 1800s on 18-file refactor"

# Preview without touching anything
${CLAUDE_SKILL_DIR}/scripts/recover-commit.js --run-id <id> \
  --reason "..." --dry-run

# Override PR title / body (defaults derive from branch + run-id)
${CLAUDE_SKILL_DIR}/scripts/recover-commit.js --run-id <id> \
  --reason "..." --pr-title "..." --pr-body-file /tmp/pr-body.md
```

If a PR already exists for the branch, the command no-ops the create step and stamps `pr_number` from the existing PR — safe to re-run after a partial failure. Use `--dry-run` first when uncertain.

## Operator state recovery

`recover-state.js` advances a relay run's state after an external event (fix commit pushed directly, dispatch stalled, no-op re-dispatch escalated the manifest). Replaces hand-edited `manual_state_override` entries with structured `state_recovery` events and validated transitions.

```bash
# Fix pushed directly to the PR branch → return to review without re-dispatch
${CLAUDE_SKILL_DIR}/scripts/recover-state.js --repo . --run-id <id> \
  --to review_pending --reason "external commit pushed; see <sha>"

# No-op re-dispatch escalated the run → bring it back for a fresh review
${CLAUDE_SKILL_DIR}/scripts/recover-state.js --repo . --run-id <id> \
  --to review_pending --force --reason "no-op-dispatch-recovery"

# Hung dispatch → unstick manifest so dispatch --run-id can resume
${CLAUDE_SKILL_DIR}/scripts/recover-state.js --repo . --run-id <id> \
  --to changes_requested --force --reason "dispatch hung; operator-killed"
```

Whitelisted transitions (unlisted pairs are rejected — use the normal dispatch/review/merge flow):

| From | To | Force | Precondition |
|---|---|---|---|
| `changes_requested` | `review_pending` | no | fresh commit on branch (HEAD ≠ `review.last_reviewed_sha`) |
| `escalated` | `review_pending` | yes | — |
| `escalated` | `changes_requested` | no | — |
| `dispatched` | `changes_requested` | yes | — |

The script refuses transitions `ALLOWED_TRANSITIONS` already supports — always prefer the normal flow when it applies. Terminal states (`merged`, `closed`) are not recoverable.
