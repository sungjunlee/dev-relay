# Operational Visibility for Relay Runs

> Historical design note. The manifest-era observer and dry-run reconciliation
> surface described below were retired by the vNext runtime reset. `relay-status.js`
> now selects validated `run.json` records and delegates lifecycle derivation
> to `runtime.inspectRun`; mutation is exclusively `runtime.recoverRun` with an
> explicit audit reason.

## Source

This PRD covers #826 and child issues #827-#830. Provider-aware model resolution is intentionally separate and owned by #825.

## Problem

When dispatch or review appears silent, operators currently have to inspect manifests, leases, logs, worktrees, PR state, and recovery dry-runs by hand. The missing product surface is not another orchestrator. It is one small operational answer:

```text
What is this run doing?
Is it alive?
Did it produce work?
What should I do next?
```

## Product Direction

- Derive status from existing artifacts before writing new state.
- Wrap existing recovery tools before inventing new transitions.
- Prefer one clear JSON row over a background process.
- Make hangs visible before making fallback automatic.
- Keep runtime adapters explicit and simple.

## Non-Goals

- No daemon or watch mode.
- No hidden model aliases; use #825 for model resolution.
- No automatic provider fallback in v1.
- No standalone review-only product in v1.
- No fleet-planning changes in v1.
- No new manifest state transitions.

## V1 Scope

### 1. Run Observer

Add `skills/relay-dispatch/scripts/run-observer.js`.

The observer is read-only. It accepts `--repo` plus `--run-id` or `--manifest`, then emits one row:

```json
{
  "run_id": "issue-123-...",
  "state": "dispatched",
  "manifest_path": "...",
  "run_dir": "...",
  "lease": {
    "status": "process_group_alive",
    "live": true,
    "elapsed_s": 91,
    "remaining_s": 1709
  },
  "logs": {
    "stdout_path": "...",
    "stderr_path": "...",
    "last_output_at": "2026-07-08T12:00:00Z",
    "silent_for_s": 91,
    "stdout_tail": "",
    "stderr_tail": ""
  },
  "worktree": {
    "path": "...",
    "exists": true,
    "reviewable_dirt": false,
    "new_commits": 0
  },
  "pr": {
    "number": null,
    "state": null
  },
  "classification": "running_silent",
  "next_action": {
    "kind": "wait_or_reconcile",
    "command": "node skills/relay-dispatch/scripts/reconcile-run.js --repo ... --run-id ... --dry-run --json"
  }
}
```

Classification is intentionally small:

- `running_with_output`
- `running_silent`
- `timed_out_live`
- `dead_with_work`
- `dead_no_work`
- `missing_worktree`
- `branch_without_pr`
- `pr_without_manifest_stamp`
- `ready_to_merge`
- `merged_not_finalized`
- `unknown_needs_manual_inspection`

### 2. Status Command

Add `skills/relay/scripts/relay-status.js`.

Supported forms:

```bash
node skills/relay/scripts/relay-status.js --repo . --run-id <id> --json
node skills/relay/scripts/relay-status.js --repo . --issue 123 --json
```

`--issue` is a thin manifest lookup convenience. It reports selection reason and candidates instead of silently guessing across multiple active runs. GitHub lookup failure must not prevent local status output.

### 3. Recovery Command

Add `skills/relay/scripts/relay-recover.js`.

Supported forms:

```bash
node skills/relay/scripts/relay-recover.js --repo . --run-id <id> --dry-run --json
node skills/relay/scripts/relay-recover.js --repo . --issue 123 --dry-run --json
```

Default behavior is dry-run. `--apply` is required for mutation. Safe dispatched recovery delegates to `reconcile-run.js`; unsafe states print manual guidance. This command must not assign manifest state directly.

### 4. Timeout Diagnostics

Improve existing timeout surfaces without changing execution policy:

- dispatch timeout distinguishes `total_timeout` from `no_result` where inferable,
- dispatch timeout/no-result output includes stdout, stderr, and result paths,
- primary Codex reviewer timeout includes reviewer phase, model, timeout, and raw response path,
- advisory timeout keeps current non-gating behavior while using aligned wording.

## Test Plan

Targeted coverage:

```bash
node --test \
  tests/relay-dispatch/scripts/run-observer.test.js \
  tests/relay-dispatch/scripts/dispatch-timeout-diagnostics.test.js \
  tests/relay/scripts/relay-status-recover.test.js \
  tests/relay-review/scripts/invoke-reviewer.test.js
```

Lint/reachability:

```bash
node --test tests/skills-lint/scripts/*.test.js
```

Full final gate remains the repo command from `AGENTS.md`. If it stalls, isolate the failing file before broadening scope.

## Deferred Work

These remain deliberately out of v1:

- heartbeat writer,
- idle timeout killer,
- automatic provider fallback chain,
- standalone read-only review command,
- fleet candidate scoring,
- GraphQL review-thread integration.
