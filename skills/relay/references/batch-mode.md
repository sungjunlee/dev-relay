# Batch Mode

Operator note for parallel relay batches. Manual fan-out is superseded by relay-fleet drive-by-default; use this file only for the remaining conflict/recovery principle.

## Default Flow

For multiple independent ready tasks, use [`relay-fleet`](../../relay-fleet/SKILL.md) as the default path.
One fleet command drives fan-out → review → merge → `closed`.
For sprint-batch mapping, follow [`sprint-to-leaves.md`](../../relay-fleet/references/sprint-to-leaves.md).

## Merge conflict recovery

If a fleet child becomes `merge_blocked` after an earlier child lands:

1. In its worktree, fetch and rebase onto `origin/main`, then push the rebased branch.
2. Run `relay-review` again from scratch against the rebased HEAD.
3. Audit the recovery with `recover-state.js --to ready_to_merge --reason "<why>"`; follow the [recovery playbook](../../relay-dispatch/references/recovery-playbook.md).
4. Re-run the fleet drive so its merge queue retries the child.

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does; if conflicts arise, recover and re-drive the blocked children.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
