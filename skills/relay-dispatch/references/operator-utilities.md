# Operator Utilities

Standalone helpers around `relay-dispatch` for worktree creation, cleanup, live dogfood, and reliability reporting. None of these are part of the normal dispatch → review → merge flow — reach for them when you need to work outside the lifecycle (set up a worktree without dispatching, prune stale runs, run live adapter canaries, audit aggregate metrics).

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

## Live Adapter Dogfood

Use `live-dogfood.js` when you need repeatable evidence for Pi, OpenCode, and Antigravity live adapter paths:

```bash
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --json --markdown
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --dispatch-canary --json
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --probe-only --json
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --dry-run --markdown
```

The harness creates a temporary `RELAY_HOME` by default and writes a scoped route policy there instead of mutating the operator's default `~/.relay/policy.json`. Healthy reviewer canaries use realistic default timeouts, while the Antigravity fail-safe timeout canary has its own intentionally short `--antigravity-fail-safe-timeout` setting.

Use `--dispatch-canary` from a clean worktree for healthy dispatch canaries across Pi, OpenCode, and Antigravity. Those steps request unique minimal repository changes and pass only when dispatch returns `review_pending` with a PR number. `--dispatch-timeout` defaults to 180 seconds, and `--dispatch-branch-prefix` defaults to `dogfood-dispatch`.

The Antigravity no-op/fail-safe dispatch canary remains separate: a no-op PR is failure/false success, not healthy dispatch evidence. Output separates `pass`, `fail-safe-pass`, `timeout`, `fail`, and `not-run` so fake-bin regressions and live canary evidence are not conflated; the fail-safe timeout canary is not healthy success.
