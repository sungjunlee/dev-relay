# Issue #160: Manifest Path Trust Roots Audit

This change closes the manifest trust-root gap for `paths.repo_root` and `paths.worktree` without widening into resolver or symlink follow-up work.

## Shared Helper

- Added `validateManifestPaths(paths, { expectedRepoRoot, manifestPath, runId, requireWorktree, caller })` in `skills/relay-dispatch/scripts/relay-manifest.js`.
- `paths.repo_root` now fail-closes unless it matches the caller's expected repo root, or, for manifest-only entry points, the manifest storage path implied by `run_id`.
- `paths.worktree` now fail-closes unless it is either contained under the trusted repo root or under the relay-owned worktree base for that repo name.
- `runCleanup()` now re-validates manifest paths before any worktree removal, branch deletion, or prune side effect.

## Consumer Audit

- Fixed: `skills/relay-dispatch/scripts/dispatch.js`
  Resume now validates manifest-owned repo/worktree paths before reusing the repo root, retained worktree, run directory, or previous-attempts state. Explicit `--manifest` resume keeps the manifest storage path as the trust root instead of binding to the caller's cwd repo.
- Fixed: `skills/relay-review/scripts/review-runner.js`
  Review preparation now validates the retained checkout before prompt generation, SHA reads, or event journal writes. Explicit `--manifest` review uses the manifest storage path as the repo-root trust source even when `--repo` points at another checkout.
- Fixed: `skills/relay-merge/scripts/gate-check.js`
  PR-mode manifest resolution now validates manifest paths before PR stamping, run-dir lock creation, or merge-gate evaluation.
- Fixed: `skills/relay-merge/scripts/finalize-run.js`
  Merge finalization now validates manifest paths before GitHub operations, review gating, cleanup, or issue close. Explicit `--manifest` finalize trusts the manifest storage path instead of the caller's cwd repo.
- Fixed: `skills/relay-dispatch/scripts/cleanup-worktrees.js`
  Janitor cleanup now rejects crafted manifests before cleanup side effects and records a fail-closed result instead.
- Fixed: `skills/relay-dispatch/scripts/close-run.js`
  Manual close/recovery now validates manifest paths before state transitions or cleanup.
- Fixed: `skills/relay-dispatch/scripts/relay-manifest.js`
  Cleanup helpers now validate manifest paths internally so a raw caller cannot retarget cleanup side effects through manifest data.
- Unchanged but enumerated: `skills/relay-dispatch/scripts/relay-manifest.js` (`resolveRubricRunDir()` fallback inside `getRubricAnchorStatus()`)
  This helper still falls back to `data.paths.repo_root` when callers omit `options.repoRoot` and `options.runDir`. That remaining raw reader is outside the `#160` bypass surface: the in-scope dispatch/review/merge consumers now pass a validated repo root or run dir before any filesystem write or GitHub operation, and the only zero-option caller left is the relay-manifest-local `validateTransitionInvariants()` rubric-state read path. No change here in this PR; if rubric-status reads become their own trust boundary, file a follow-up rather than silently widening this fix.

## Regression Coverage

- Added manifest-layer unit coverage for valid repo-contained and relay-owned worktrees, plus repo-root mismatch, worktree escape, and manifest-path mismatch rejection.
- Added consumer regressions showing rejection before side effects for:
  `dispatch`, `review-runner`, `gate-check`, `finalize-run`, `cleanup-worktrees`, and `close-run`.
- Existing alias-flow coverage still passes: `review-runner` continues to accept a symlinked repo alias that resolves to the same trusted repo root.

## Explicit Non-Scope

- No symlink hardening beyond preserving existing repo-alias behavior.
- No resolver/state-machine widening.
- No reliability-report or planner changes.
