# Batch Mode

Operator note for parallel relay batches. Manual fan-out is superseded by relay-fleet drive-by-default; use this file only for the remaining conflict/recovery principle.

## Default Flow

Use `relay-fleet` as the default batch drive for prepared leaves.
For sprint batches, follow `../../relay-fleet/references/sprint-to-leaves.md`.

## Merge conflict recovery

If a child leaves `ready_to_merge` as `merge_blocked` after an earlier child lands:

1. Recover the affected run per the recovery playbook.
2. Re-run the fleet drive so the child returns to the merge queue.
3. Continue through the fleet gate.

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does; if conflicts arise, recover and re-drive the blocked children.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
