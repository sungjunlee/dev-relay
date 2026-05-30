# Worktree Janitor v2

Manifest-aware relay worktree cleanup with git/PR health signals (GSD-inspired) and finish-path guidance (Superpowers-inspired). The existing manifest state machine is unchanged; janitor v2 adds inspection, drift reconciliation, and richer operator output on top of `cleanup-worktrees.js`.

## Problem

Relay intentionally retains worktrees after dispatch for PR handoff and re-dispatch. Disk accumulates when:

- runs stall in non-terminal states (`ready_to_merge`, `review_pending`, …)
- GitHub PR merges but `finalize-run` never runs
- manifest `paths.repo_root` / `paths.worktree` drift from the operator repo
- terminal runs age out without a janitor pass

v1 janitor (`cleanup-worktrees.js`) only deletes **terminal** runs past an age gate. v2 adds health scoring and optional reconcile for **merged-but-not-finalized** drift.

## Design principles

1. **Manifest state machine stays authoritative** — janitor does not invent new states; reconcile uses existing `forceUpdateManifestState` → `merged` when git/PR evidence is strong.
2. **PR handoff retention is normal** — Superpowers Option 2/3 analogue: `ready_to_merge` + open PR → retain worktree.
3. **Fail closed on dirty unknown worktrees** — same as `runCleanup()`.
4. **Git graph beats manifest alone** — GSD-style `mergedIntoBase` / `safeToRemove` for drift detection.
5. **Operator-first** — default remains dry-run friendly; destructive paths require explicit flags.

## Health model

`assessRunWorktreeHealth()` (`worktree-health.js`) computes:

| Field | Meaning |
| --- | --- |
| `mergedIntoBase` | `git branch --merged <base>` or `git merge-base --is-ancestor <branch> <base>` |
| `prMerged` | `gh pr view --json mergedAt` when `git.pr_number` set (covers squash merges on GitHub) |
| `mergedIntoBaseOrPr` | either signal true |
| `dirty` / `dirtyFileCount` | worktree `git status --short` |
| `relayOwnedStrayOnly` | only `?? rubric.yaml` (relay-owned stray) |
| `unpushedCommits` | informational; does not block removal when merged |
| `lastCommitAgeDays` | branch tip age |
| `stale` | not merged and age ≥ `--stale-days` (default 14) |
| `safeToRemove` | merged + effectively clean |
| `reconcileEligible` | `ready_to_merge` + merged + effectively clean |

## Finish paths (Superpowers mapping)

| `finishPath` | Relay situation | Superpowers analogue | Default janitor action |
| --- | --- | --- | --- |
| `cleanup_terminal` | `merged`/`closed`, safe | Option 1/4 merge/discard cleanup | `runCleanup()` (v1) |
| `reconcile_merged` | branch/PR merged, manifest not terminal | skipped finalize after merge | `--reconcile-merged` |
| `retain_pr_handoff` | `ready_to_merge` + PR | Option 2 PR path | retain |
| `retain_active` | dispatched / in-review | active work | retain |
| `stale_open` | non-terminal + stale age | Option 3 keep-as-is + operator nudge | report + `close-run` hint |
| `manual_required` | dirty or path validation failure | manual cleanup | fail closed |

## CLI (v2)

```bash
# Health report only (no mutations)
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --inspect --json

# Terminal cleanup (v1 behavior) with health embedded in JSON
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --older-than 24 --json

# Reconcile merged drift (dry-run lists candidates)
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --reconcile-merged --dry-run --json

# Apply reconcile + cleanup (force manifest -> merged, then runCleanup)
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --reconcile-merged --json

# Stale classification threshold (default 14 days)
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --inspect --stale-days 7 --json
```

### Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--inspect` | off | Health inventory only; no cleanup, no shell sweep |
| `--reconcile-merged` | off | For `ready_to_merge` merged drift: transition to `merged`, then cleanup |
| `--stale-days` | 14 | Stale classification for health + stale-open reporting (days; reporting only) |
| `--older-than` | 24 | Age gate for terminal cleanup only (hours) |
| `--all` | off | Ignore age gate |
| `--dry-run` | off | No manifest/git writes |

## Reconcile eligibility

`--reconcile-merged` applies only when **all** hold:

- manifest state is `ready_to_merge`
- `mergedIntoBaseOrPr` is true
- worktree effectively clean (or relay-owned stray only)
- path validation succeeds

Reconcile **does not** use `--older-than`; merge/PR evidence is the safety gate. Terminal cleanup still uses `--older-than` (or `--all`).

Transition: `forceUpdateManifestState(..., merged, manual_cleanup_required)` with audit reason `janitor_reconcile_merged`, then `runCleanup()` with `deleteMergedBranch: true`.

**Preferred path:** `finalize-run --repo <path> --run-id <id>` when the run is `ready_to_merge` and the review gate can pass (issues close, `MERGE_FINALIZE` event, learnings). Use `finalize-run --skip-merge` only when the manifest is already `merged` and you need cleanup-only.

Janitor reconcile is a **disk recovery** escape hatch when finalize is blocked or skipped — not a substitute for merge finalization.

## Out of scope (v2.1 candidates)

- Global sweep across all repos under `~/.relay/runs/`
- Auto `close-run` for stale non-terminal runs (still operator explicit)
- Project-local worktree base (`.relay/worktrees/` per repo)
- Scheduled daemon / launchd cron
- `policy.isolation: branch` escape hatch (spec only; see GSD `use_worktrees: false`)

## Bootstrap audit hook (planned)

On `/relay`, `relay-dispatch`, or `relay-merge` entry, emit a one-line warning when:

- disk worktrees >> open manifests for repo slug
- `inspect` reports `reconcile_merged` count > 0
- path validation failure rate > 0

Implementation tracked separately to keep v2 CLI-only.

## Related files

- `scripts/worktree-health.js` — health + finish path
- `scripts/cleanup-worktrees.js` — janitor CLI
- `scripts/manifest/cleanup.js` — `runCleanup()`
- `scripts/finalize-run.js` — preferred post-review merge path
- `references/operator-utilities.md` — operator cheat sheet
