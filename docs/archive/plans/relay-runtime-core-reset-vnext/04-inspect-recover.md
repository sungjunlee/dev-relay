Parent: #1129

## Outcome

Replace the fragmented recovery command family with two convergent operations: read-only `inspect` and idempotent `recover`.

## Scope

- Produce typed inspect actions from stored facts and freshly observed Git/PR/worktree state.
- Re-observe all relevant external facts under the run lock before recovery mutation.
- Converge commit, push, PR publication, verification evidence, review-anchor repair, externally merged PRs, and merge provenance.
- Absorb the valid contracts from #1113, #1114, #1115, #1118, and #1123 without preserving separate entry points.

## Acceptance criteria

- [ ] `inspect` is read-only and reports facts, observations, blockers, and the single recommended next action.
- [ ] `recover` acquires ownership, repeats external observations under lock, and refuses stale assumptions.
- [ ] Re-running `recover` after success is a no-op with the same resulting facts.
- [ ] Publication never creates a duplicate PR and never claims a SHA not present on the remote branch.
- [ ] Verification evidence is bound to exact tree/SHA and Done Criteria.
- [ ] Externally merged PRs reconcile to durable merge provenance without direct state assignment.
- [ ] Terminal runs cannot be reopened or rewritten.
- [ ] Legacy recovery commands become temporary shims that delegate to `inspect`/`recover`.

## Verification

- Scenario matrix covering clean, dirty, committed, pushed, PR-open, PR-merged, stale-review, and partial-evidence states.
- Repeat every scenario with a crash immediately before and after each durable fact.
- Regression fixtures derived from #1113, #1114, #1115, #1118, and #1123.

## Dependencies

- #1131
- #1132
