# ADR-0003: Worktree Runtime Single Owner

Status: Accepted (issue #187)

## Context

Worktree plan/create/register/remove logic was duplicated between `dispatch.js` and `create-worktree.js`. Divergent dry-run output and cleanup-on-failure behavior made parity fixes expensive.

## Decision

`skills/relay-dispatch/scripts/worktree-runtime.js` is the single owner for:

- Dry-run plan formatting (text + JSON)
- Worktree create + optional copy/register
- Worktree removal on failure or signal cleanup

Callers (`dispatch.js`, `create-worktree.js`) delegate lifecycle steps to the runtime. Dispatch-specific policy (base merge, manifest writes, executor gating) stays in dispatch.

**Intentional delta from #187:** if post-create registration fails after the worktree exists, the runtime removes the worktree before exit (previously `create-worktree.js` could leave orphans).

## Consequences

- No direct `git worktree add/remove` in dispatch or create-worktree callers — grep for `"worktree", "add"` in those files should stay empty.
- New worktree behavior belongs in `worktree-runtime.js` first, then wired through callers.
- Fixture-backed parity tests guard dry-run JSON between CLI entry points.

## Evidence

- GitHub issue `#187` (post-merge mirror retired after ADR distill)
- Module: `skills/relay-dispatch/scripts/worktree-runtime.js`
