# Batch Mode

Operator note for parallel relay batches. Manual fan-out is superseded by relay-fleet when the user explicitly authorizes landing the batch; use this file only for the remaining conflict/recovery principle.

## Default Flow

For multiple independent ready tasks, prepare a [`relay-fleet`](../../relay-fleet/SKILL.md) batch, but keep `/relay` at `ready_to_merge` until the user explicitly authorizes landing it.
After that authorization, one fleet command drives fan-out → review → merge → `closed`.
For sprint-batch mapping, follow [`sprint-to-leaves.md`](../../relay-fleet/references/sprint-to-leaves.md).

## Merge conflict recovery

For an authorized fleet whose child becomes `merge_blocked` after an earlier child lands:

1. In its worktree, fetch and rebase onto `origin/main`, then push the rebased branch.
2. Use the validated lifecycle helper to restore `ready_to_merge`: `node -e 'const p="./skills/relay-dispatch/scripts/",repo=process.cwd(),id=process.argv[1],reason=process.argv[2],m=require(p+"relay-resolver").resolveManifestRecord({repoRoot:repo,runId:id}),l=require(p+"manifest/lifecycle"),n=l.updateManifestState(m.data,l.STATES.READY_TO_MERGE,"await_explicit_merge");require(p+"manifest/store").writeManifest(m.manifestPath,n,m.body);const {appendRunEvent,EVENTS}=require(p+"relay-events");appendRunEvent(repo,id,{event:EVENTS.STATE_RECOVERY,state_from:m.data.state,state_to:n.state,head_sha:n.git?.head_sha||null,round:n.review?.rounds||null,reason})' <id> "merge blocker cleared after rebase"`.
3. Follow the [recovery playbook](../../relay-dispatch/references/recovery-playbook.md): recover to `review_pending`, then run `relay-review` from scratch against the rebased HEAD.
4. Re-run the explicitly authorized fleet drive so its merge queue retries the child.

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does; if conflicts arise, recover and re-drive the blocked children.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
