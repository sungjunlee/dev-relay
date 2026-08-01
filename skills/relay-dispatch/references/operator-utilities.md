# Operator Utilities

Standalone helpers around `relay-dispatch` for worktree creation, cleanup, and live dogfood. None of these are part of the normal dispatch → review → merge flow — reach for them when you need to work outside the lifecycle.

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

`--register` still matters because it also opens the retained worktree in the executor app.

Janitor v2 adds git/PR health scoring and optional merged-drift reconciliation (`ready_to_merge` only). See [worktree-janitor-v2.md](./worktree-janitor-v2.md).

```bash
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --inspect --json
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --reconcile-merged --dry-run --json
# Prefer finalize-run when review gate passes; reconcile is disk recovery for merged drift
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo .              # clean terminal runs > 24h old
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --all         # ignore age threshold
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run     # show what would be removed
node skills/relay-dispatch/scripts/close-run.js --repo . --run-id <run-id> --reason "stale_non_terminal_run"
```

## `publish-run.js` — Delayed PR publication

Use only after internal relay-review has advanced a run to `publish_pending`:

```bash
node skills/relay-dispatch/scripts/publish-run.js --repo . --run-id <run-id> --json
```

The command pushes the retained branch, opens or reuses the PR, stamps `git.pr_number`, writes a `publish_result` event, and advances the manifest to `review_pending`. The next step is post-publication relay-review so CI/actions and external review signals are evaluated before `ready_to_merge`.

## Live Adapter Dogfood

Run the registry-wide, read-only smoke canary before adapter-specific dogfood:

```bash
node skills/relay-dispatch/scripts/adapter-live-canary.js --timeout-ms 5000
```

It probes every registered adapter, invokes a bounded minimal primary review when that phase is supported, verifies the worktree stayed unchanged, and feeds the result through that adapter's `parseOutcome()`. Dispatch-only adapters are explicit skips for the review invocation. Missing CLIs, unavailable credentials, execution-environment restrictions, and unavailable read-only phases are also explicit skips. Probe failures and invocation timeouts are failures, never skips or healthy passes.

Use `live-dogfood.js` when you need repeatable evidence for Pi, OpenCode, and Antigravity live adapter paths:

```bash
node skills/relay-dispatch/scripts/live-dogfood.js --repo . \
  --pi-model '<pi-provider>/<pi-model>' --opencode-model '<opencode-provider>/<opencode-model>' \
  --json --markdown
node skills/relay-dispatch/scripts/live-dogfood.js --repo . \
  --pi-model '<pi-provider>/<pi-model>' --opencode-model '<opencode-provider>/<opencode-model>' \
  --dispatch-canary --json
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --probe-only --json
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --dry-run --markdown
node skills/relay-dispatch/scripts/live-dogfood.js --repo . \
  --pi-model '<pi-provider>/<pi-model>' --scenario pi-primary --json
```

The harness creates a temporary `RELAY_HOME` by default without writing project configuration. Healthy reviewer canaries use realistic default timeouts, while the Antigravity fail-safe timeout canary has its own intentionally short `--antigravity-fail-safe-timeout` setting.

Pi and OpenCode live dogfood require explicit provider/model values through `--pi-model` and `--opencode-model`, or `RELAY_LIVE_DOGFOOD_PI_MODEL` and `RELAY_LIVE_DOGFOOD_OPENCODE_MODEL`. Antigravity defaults to `google/antigravity-cli` unless `--antigravity-model` or `RELAY_LIVE_DOGFOOD_ANTIGRAVITY_MODEL` overrides it. Use repeated `--scenario <name>` primary-review or dispatch filters when you need isolated evidence for one adapter path.

Use `--dispatch-canary` from a clean worktree for healthy dispatch canaries across Pi, OpenCode, and Antigravity. Those steps request unique minimal repository changes and pass only when dispatch returns `review_pending` with a PR number. `--dispatch-timeout` defaults to 180 seconds, and `--dispatch-branch-prefix` defaults to `dogfood-dispatch`.

The Antigravity no-op/fail-safe dispatch canary remains separate: a no-op PR is failure/false success, not healthy dispatch evidence. Output separates `pass`, `fail-safe-pass`, `timeout`, `fail`, and `not-run` so fake-bin regressions and live canary evidence are not conflated; `timeout` is inconclusive unless the step is the intentionally bounded fail-safe timeout canary, and the fail-safe timeout canary is not healthy success.
