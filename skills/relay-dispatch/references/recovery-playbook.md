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

# Override PR title / body (default title prefers linked issue title, then branch + run-id)
${CLAUDE_SKILL_DIR}/scripts/recover-commit.js --run-id <id> \
  --reason "..." --pr-title "..." --pr-body-file /tmp/pr-body.md
```

When `--pr-title` is omitted, the PR title defaults to the linked GitHub issue title as `<issue title> (#<N>)`, first from `manifest.issue.number`, then from an unambiguous `issue-N` branch name. If issue lookup fails or no issue is linked, it falls back to `Recover <branch> (<run-id>)`. `--pr-title` always wins exactly.

If a PR already exists for the branch, the command no-ops the create step and stamps `pr_number` from the existing PR — safe to re-run after a partial failure. Use `--dry-run` first when uncertain.

## Operator state recovery

`recover-state.js` advances a relay run's state after an external event (fix commit pushed directly, dispatch stalled, no-op re-dispatch escalated the manifest). Replaces hand-edited `manual_state_override` entries with structured `state_recovery` events and validated transitions.

```bash
# Fix pushed directly to the PR branch → return to review without re-dispatch
${CLAUDE_SKILL_DIR}/scripts/recover-state.js --repo . --run-id <id> \
  --to review_pending --reason "external commit pushed; see <sha>"

# PR body fixed with gh pr edit, code HEAD unchanged → return to review without re-dispatch
${CLAUDE_SKILL_DIR}/scripts/recover-state.js --repo . --run-id <id> \
  --to review_pending --allow-same-head --require-pr-body-change \
  --reason "PR body metadata fixed with gh pr edit"

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
| `changes_requested` | `review_pending` | no | same HEAD allowed only with `--allow-same-head --require-pr-body-change`, a manifest PR number (`git.pr_number` or `github.pr_number`), a prior `review-round-N-pr-body.md` snapshot, and a current GitHub PR body that differs from the latest numbered snapshot |
| `escalated` | `review_pending` | yes | — |
| `escalated` | `changes_requested` | no | — |
| `dispatched` | `changes_requested` | yes | — |

The script refuses transitions `ALLOWED_TRANSITIONS` already supports — always prefer the normal flow when it applies. Terminal states (`merged`, `closed`) are not recoverable.

### Recovery command boundaries

Decision tree: if the executor finished implementation but did not commit, use `recover-commit.js`; it handles commit, push, PR publication/stamping, and evidence rebrand atomically. If the orchestrator hand-edited fixes after R1, the evidence is still bound to the dispatch SHA, and review at HEAD substantively PASSed, run `rebrand-evidence.js --run-id <id> --reason "..."`, then `finalize-run.js --run-id <id> --force-finalize-nonready --reason "stale-execution-evidence: orchestrator-correction"`. If the reviewer state machine refuses to re-trigger on the same SHA and no commit is needed, skip evidence repair and use `finalize-run.js --run-id <id> --force-finalize-nonready --reason "..."` directly.

Use `recover-commit.js` when the executor changed files but did not commit, push, or create/stamp a PR. It creates the missing commit/PR handoff and leaves the manifest in `review_pending`.

### Codex worktree admin-dir sandbox

Codex CLI 0.128.0 exposes two relevant sandbox configuration surfaces:

- `codex exec --help` documents `--add-dir <DIR>` as "Additional directories that should be writable alongside the primary workspace".
- `-c, --config <key=value>` accepts dotted config overrides parsed as TOML, and relay-dispatch already uses it for `sandbox_workspace_write.network_access=true`.

For relay worktrees, the worktree `.git` file points at the real Git admin directory under the main repository, usually `<main-repo>/.git/worktrees/<name>/`. A Codex executor whose `-C` is the worktree path can write normal workspace files, but a linked-worktree `git add` writes blob objects under `<main-repo>/.git/objects/`, and `git commit` updates branch refs and reflogs under `<main-repo>/.git/refs/...` and `<main-repo>/.git/logs/...` — both in the **common git dir**, not the per-worktree admin dir. The original #332 failure surfaced at `index.lock` (admin dir), but objects/refs writes are at the same architectural risk. `dispatch.js` therefore passes `--add-dir <common-git-dir>` (the main repo's `.git` directory) so Codex can complete the full add+commit cycle inside the sandbox; the per-worktree admin dir is a subdirectory of the common dir, so this single grant subsumes both paths.

Investigation note for #389: `codex --version` reported `codex-cli 0.128.0`, and `codex exec --help` exposed `--add-dir <DIR>`. A temp worktree repro in this dispatch environment could not complete the model step because nested Codex DNS failed against `chatgpt.com`, so the local failure remains intermittent here. The startup logs did confirm the sandbox allowlist mutates with `--add-dir`: it expanded from `workspace-write [workdir, /tmp, $TMPDIR, <codex-home>/memories]` to include the passed path. Treat the original #332 retained evidence as the canonical observed failure: `dispatch_result` recorded `new_dispatch:completed-uncommitted`, and recovery used reason `codex finished implementation but sandbox blocked git add/commit step`; the canonical stderr shape is `fatal: Unable to create '<main-repo>/.git/worktrees/<name>/index.lock': Operation not permitted`. Round-2 reviewer flagged that admin-dir-only widening would leave objects/refs writes outside the sandbox; the fix therefore widened to the full common git dir.

Decision-tree paths from #389, kept verbatim:

If `--add-dir` IS supported and works: ship Path 1. Path 2 (`--auto-recover-commit`) becomes optional defense-in-depth — either bundle it or defer to a follow-up issue.

If `--add-dir` is NOT supported or doesn't fix the failure: ship Path 2 and document Path 1's failure mode in recovery-playbook.md.

#389 picked Path 1 (sandbox widening via `--add-dir`). Path 2 (`--auto-recover-commit` opt-in flag) is **deferred** to follow-up issue #393 — it remains optional defense-in-depth for residual cases (codex CLI crashes mid-commit, transient sandbox edge cases, codex versions that change `--add-dir` semantics). Until #393 lands, the existing `recover-commit.js` operator command remains the canonical recovery for those residual cases.

Use normal `dispatch.js --run-id <id>` when reviewer feedback requires code changes. That path re-dispatches implementation work and must produce a fresh code handoff before review.

Use `recover-state.js --to review_pending` for external events that make a new review valid without redispatch. The normal path still requires `HEAD != review.last_reviewed_sha`. The same-HEAD exception is only for PR-body-only evidence changes and emits a `state_recovery` event with `pr_body_only: true`, `head_sha`, `last_reviewed_sha`, `pr_number`, and the operator `reason`.

Use `finalize-run.js --force-finalize-nonready --reason ...` only as a merge/finalization override for non-ready terminal cleanup. It is not a substitute for fresh review evidence and does not repair missing PR body metadata.
