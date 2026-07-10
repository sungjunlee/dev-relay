# Batch Mode

Operator note for parallel relay batches. Manual fan-out is superseded by relay-fleet when the user explicitly authorizes landing the batch; use this file only for the remaining conflict/recovery principle.

## Default Flow

For multiple independent ready tasks, prepare a [`relay-fleet`](../../relay-fleet/SKILL.md) batch, but keep `/relay` at `ready_to_merge` until the user explicitly authorizes landing it.
After that authorization, one fleet command drives fan-out → review → merge → `closed`.
For sprint-batch mapping, follow [`sprint-to-leaves.md`](../../relay-fleet/references/sprint-to-leaves.md).

## Merge conflict recovery

For an authorized fleet whose child becomes `merge_blocked` after an earlier child lands:

1. In its worktree, fetch and rebase onto `origin/main`, then push the rebased branch with `--force-with-lease`.
2. Recover in one audited hop (whitelisted in `recover-state.js`; see the [recovery playbook](../../relay-dispatch/references/recovery-playbook.md)): `node skills/relay-dispatch/scripts/recover-state.js --run-id <id> --to review_pending --reason "PR rebased after merge_blocked; rerun review for the live head"`.
3. Re-run the explicitly authorized fleet drive: its review loop re-reviews the `review_pending` child at the rebased HEAD, and only after that review passes does its merge queue retry the landing. An interruption before the drive re-run cannot land unreviewed work — the pre-merge fresh-review gate rejects the rebased HEAD and re-blocks the child; resume with the recover hop.

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does; if conflicts arise, recover and re-drive the blocked children.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
