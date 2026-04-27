# Batch Mode

Operator playbook for parallel relay dispatch. Consult only when batching multiple independent tasks; the dominant single-task path in `SKILL.md` does not need this.

## Flow: Plan all → Dispatch all → Review as completed → Merge one-by-one

1. **Plan all tasks** — follow Steps 0 through 2 (including 1.5) for each task. Write each dispatch prompt to its own temp file.
2. **Dispatch all** — run dispatch.js for each task asynchronously (in the background). Mark all as `[~]` in sprint file.
3. **Review as completed** — as each dispatch finishes, run Step 4 (relay-review). No need to wait for all.
4. **Merge one-by-one** — merge each ready PR sequentially only after explicit approval. After each merge, check remaining PRs for conflicts.
5. **Re-anchor** — after the batch completes, run Step 0 before starting the next batch.

## Merge conflict recovery

If a ready-to-merge PR has conflicts after an earlier merge:

1. In the worktree: `git fetch origin && git rebase origin/main`
2. Re-review the rebased PR (run relay-review again — Phase 1 from scratch)
3. Merge

## Principles

- **When in doubt, run sequentially.** Batch mode is an optimization, not the default.
- Merge order doesn't matter until it does — if conflict arises, rebase the rest.
- No DAG analysis needed for 3-5 task batches. If tasks touch the same files, run them sequentially.
