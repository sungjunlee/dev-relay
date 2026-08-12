# Batch Mode

Operator note for parallel relay batches. Manual fan-out is superseded by relay-fleet when the user explicitly authorizes landing the batch; use this file only for the remaining conflict/recovery principle.

## Default Flow

For multiple independent ready tasks, prepare a [`relay-fleet`](../../relay-fleet/SKILL.md) batch, but keep `/relay` at `ready_to_merge` until the user explicitly authorizes landing it.
After that authorization, one fleet command drives fan-out → review → merge → `closed`.
For sprint-batch mapping, follow [`sprint-to-leaves.md`](../../relay-fleet/references/sprint-to-leaves.md).

## Merge conflict recovery

For an authorized fleet whose child becomes `merge_blocked` after an earlier child lands:

1. On the supported GitHub route, fetch the source-gate-selected remote and
   rebase onto its configured base branch, then push the rebased branch with
   `--force-with-lease`. A local no-remote route has no fleet merge step.
2. Inspect the run, then recover from freshly observed facts: `node skills/relay/scripts/relay-recover.js inspect --run-id <id> --json`, followed by `node skills/relay/scripts/relay-recover.js recover --run-id <id> --reason "PR rebased after merge blocker; rerun review for the live head" --json`.
3. Re-run the explicitly authorized fleet drive: its review loop re-reviews the `review_pending` child at the rebased HEAD, and only after that review passes does its merge queue retry the landing. An interruption before the drive re-run cannot land unreviewed work — the pre-merge fresh-review gate rejects the rebased HEAD and re-blocks the child; resume with the recover hop.

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does; if conflicts arise, recover and re-drive the blocked children.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
