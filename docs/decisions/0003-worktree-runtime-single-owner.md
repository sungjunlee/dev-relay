# ADR-0003: Worktree Runtime Single Owner

Status: Superseded. `worktree-runtime.js` and `create-worktree.js` were
deleted. Do not restore them.

Current worktree ownership is `dispatch.js` plus `cleanup-worktree.js`. See
[architecture.md](../architecture.md). The body that described
the removed split (`#187`) lives in git history.
