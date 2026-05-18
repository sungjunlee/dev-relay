# Operator Utilities

Standalone helpers around `relay-dispatch` for worktree creation, cleanup, and reliability reporting. None of these are part of the normal dispatch → review → merge flow — reach for them when you need to work outside the lifecycle (set up a worktree without dispatching, prune stale runs, audit aggregate metrics).

## `create-worktree.js` — Standalone worktree creation

Create a worktree without dispatching, or register an existing worktree in Codex App:

```bash
# Create worktree in ~/.relay/worktrees/
node skills/relay-dispatch/scripts/create-worktree.js <repo> -b <branch>

# Register an existing worktree in Codex App (optional)
node skills/relay-dispatch/scripts/create-worktree.js <repo> --worktree-path <path> -b <branch> -t "Title" --register
```

## Worktree Cleanup

Successful dispatches keep their worktree by default. Cleanup moves later in the lifecycle, typically after review or merge.

`--no-cleanup` remains accepted as a compatibility alias. `--register` still matters because it also opens the retained worktree in the executor app.

To prune stale retained worktrees safely from this repo:
```bash
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo .              # clean terminal runs > 24h old
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --all         # ignore age threshold
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run     # show what would be removed
node skills/relay-dispatch/scripts/close-run.js --repo . --run-id <run-id> --reason "stale_non_terminal_run"
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
```
