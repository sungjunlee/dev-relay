# Issue #187 — Worktree Runtime Consolidation

## Summary

This change moves worktree create/copy/register lifecycle code into [`skills/relay-dispatch/scripts/worktree-runtime.js`](../skills/relay-dispatch/scripts/worktree-runtime.js). Both callers now route through the same runtime path for dry-run planning and worktree lifecycle operations.

The only intentional correctness delta is in [`skills/relay-dispatch/scripts/create-worktree.js`](../skills/relay-dispatch/scripts/create-worktree.js): when post-create steps fail after the worktree exists, the script now removes that worktree before exiting. No other behavior was intentionally changed.

Pre-refactor dry-run fixtures were captured in commit `22cc11b` from source commit `5e78def9da36ea18b08946345f1028057b452eeb`.

## Audit Table

| # | Concern | Before | After | Notes |
|---|---------|--------|-------|-------|
| 1 | Shared runtime owner | duplicated inline logic in callers | [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L12) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L25) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L32) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L55) | One module now owns plan/create/register/remove behavior. |
| 2 | `create-worktree` dry-run JSON plan | `create-worktree.js:179-185` | [create-worktree.js](../skills/relay-dispatch/scripts/create-worktree.js#L183) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L75) | Fixture-backed parity for `--dry-run --json`. |
| 3 | `create-worktree` dry-run text renderer | `create-worktree.js:186-192` | [create-worktree.js](../skills/relay-dispatch/scripts/create-worktree.js#L197) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L12) | Text plan now comes from `formatPlan()`. |
| 4 | `create-worktree` standard create + copy | `create-worktree.js:197-214` | [create-worktree.js](../skills/relay-dispatch/scripts/create-worktree.js#L209) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L95) | Inline `git worktree add` fallback and copy path removed from caller. |
| 5 | `create-worktree` registration path + failure cleanup delta | `create-worktree.js:217-220` | [create-worktree.js](../skills/relay-dispatch/scripts/create-worktree.js#L226) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L32) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L131) | New correctness delta: cleanup now runs if registration fails after create. External-worktree registration also routes through the runtime helper. |
| 6 | `dispatch` dry-run worktree planning | `dispatch.js:545-556` | [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L547) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L75) | Dispatch still owns its full plan envelope, but the worktree plan comes from the shared runtime. |
| 7 | `dispatch` unexpected-exit cleanup | `dispatch.js:606-614` | [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L616) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L25) | Signal cleanup now uses `removeWorktree()`. |
| 8 | `dispatch` new-run create + copy | `dispatch.js:618-636` | [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L628) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L95) | Dispatch-specific merge/manifest policy stays outside the runtime. |
| 9 | `dispatch` merge-failure cleanup | `dispatch.js:651-656` | [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L659) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L25) | Base-branch fetch/merge remains dispatch-only; cleanup moved to the shared remover. |
| 10 | `dispatch` post-success Codex registration | direct `registerCodexApp` call late in `dispatch.js` | [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L946) / [worktree-runtime.js](../skills/relay-dispatch/scripts/worktree-runtime.js#L32) | Executor gating stays in dispatch; runtime only receives a plain register request. |

## Grep Evidence

```text
$ grep -nE '"worktree",[[:space:]]*"(add|remove)"' skills/relay-dispatch/scripts/dispatch.js skills/relay-dispatch/scripts/create-worktree.js
<no output>
```

## Tests

- `node --test skills/relay-dispatch/scripts/*.test.js` → 248 passing
- `node --test skills/relay-intake/scripts/*.test.js` → 21 passing
- `node --test skills/relay-plan/scripts/*.test.js` → 19 passing
- `node --test skills/relay-review/scripts/*.test.js` → 77 passing
- `node --test skills/relay-merge/scripts/*.test.js` → 78 passing
- Full total: `428 -> 443` passing (`+15` tests)

New coverage added in:
- [create-worktree.test.js](../skills/relay-dispatch/scripts/create-worktree.test.js)
- [worktree-runtime.test.js](../skills/relay-dispatch/scripts/worktree-runtime.test.js)
- [dispatch.test.js](../skills/relay-dispatch/scripts/dispatch.test.js)

## Deferred Inventory

- `#188` manifest/runtime boundary cleanup in `relay-manifest.js`
- `#189` `review-runner.js` decomposition
- `#190` grandfather retirement
- `#191` resolver/docs hygiene and separate cleanup CLI work
- [`skills/relay-dispatch/scripts/cleanup-worktrees.js`](../skills/relay-dispatch/scripts/cleanup-worktrees.js) remains untouched in this PR

## Trust-Model Note

This refactor did not re-trigger the trust-model checklist. The runtime stays path-opaque, `validateManifestPaths()` remains caller-owned, no new subprocess families were introduced, and no new GitHub/state-transition/filesystem trust entry points were added.

## Line-Number Drift Discipline

This file was generated after the final code changes were complete. If the source changes again before merge, regenerate the audit table line numbers and grep evidence last.
