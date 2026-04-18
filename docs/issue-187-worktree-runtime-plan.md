# Issue #187 — Consolidate worktree lifecycle under one shared runtime

Draft plan for the first item of Epic #192 (Runtime Boundary Cleanup). Unblocked as of 2026-04-18: all five prerequisite-bucket issues (#185, #163, #160, #161, #151) have merged.

This document exists so the next-session dispatch has a concrete starting rubric instead of being re-planned from scratch.

## Problem statement

Two entry points own the same worktree lifecycle, with drift-prone duplication:

| Call site | Pattern |
|-----------|---------|
| `skills/relay-dispatch/scripts/create-worktree.js:200,203` | `git worktree add <path> -b <branch>` with branch-already-exists fallback to `git worktree add <path> <branch>` |
| `skills/relay-dispatch/scripts/dispatch.js:621,624`        | Same pattern, re-implemented inline |
| `skills/relay-dispatch/scripts/dispatch.js:611,656`        | `git worktree remove --force <path>` cleanup on failure (no equivalent in `create-worktree.js`) |

Both call sites also import `copyWorktreeFiles` from `worktreeinclude.js` and `registerCodexApp` from `codex-app-register.js` — those are already shared. The gap is the git-worktree-add + fallback + failure-cleanup sequence and the dry-run rendering.

## Goal

One runtime module owns create, copy, optional app-register, and dry-run output. `dispatch.js` and `create-worktree.js` both call it. Regression tests prove parity across entry points.

## Proposed shape

New module: `skills/relay-dispatch/scripts/worktree-runtime.js`

Exported functions (first cut):

```js
// Returns { worktreePath, branch, created: bool, copiedFiles, registeredApp }.
// Does NOT touch relay manifest — that stays with the caller.
createWorktree({
  repoRoot,          // validated by caller (validateManifestPaths still owns trust-root)
  worktreePath,      // absolute, pre-validated
  branch,
  title,             // optional, forwarded to registerCodexApp
  includeFiles,      // from getWorktreeIncludeFiles() OR explicit --copy
  register,          // bool
  pin,               // bool, forwarded to registerCodexApp
  dryRun,            // bool
  logger,            // ({plan|step|result}) => void, injected for testability
});

// Idempotent, best-effort; no throw on unknown worktree.
removeWorktree({ repoRoot, worktreePath });

// Shared formatter so dry-run output is byte-identical across callers.
formatPlan({ worktreePath, branch, title, register, pin, includeFiles });
```

`create-worktree.js` becomes an argv parser plus one call to `createWorktree()`. `dispatch.js` replaces the inline `worktree add` + cleanup block with `createWorktree({ dryRun, logger: dispatchLogger })` and `removeWorktree()` on failure.

## Rubric (draft)

Size M, 6 factors (4 contract + 2 quality), matching Batch 1.6 discipline.

### Prerequisites
- `node --test skills/relay-dispatch/scripts/*.test.js` exits 0 on PR HEAD.
- No new `require()` cycles introduced (grep guard in CI or manual audit in the PR body).

### Contract factors

**1. `worktree-runtime.js` module exists and both entry points call it**
- `skills/relay-dispatch/scripts/worktree-runtime.js` exports `createWorktree`, `removeWorktree`, `formatPlan`.
- `dispatch.js` no longer calls `git(_, "worktree", "add", ...)` directly at the two pre-existing sites (lines ~621/624); both routes go through `createWorktree`.
- `create-worktree.js` no longer calls `git(_, "worktree", "add", ...)` directly; both the `-b` branch-create and the existing-branch fallback live inside the shared runtime.
- `grep -n 'git(.*"worktree"' skills/relay-dispatch/scripts/dispatch.js skills/relay-dispatch/scripts/create-worktree.js` returns zero matches for the `add` and `remove --force` shapes (cleanup routes go through `removeWorktree`).

**2. Dry-run output is byte-identical before and after**
- Pin the current `create-worktree.js --dry-run --json` output and `dispatch.js --dry-run` equivalent output in a test fixture.
- Both entry points call `formatPlan` exclusively; no alternate format path survives in the diff.
- Test asserts the post-refactor stdout against the pre-refactor fixture character-for-character for at least three shapes: `(a)` standard create + no register, `(b)` create + register + pin, `(c)` `--worktree-path` external mode (create-worktree.js only).

**3. Codex app registration behavior preserved**
- `registerCodexApp` is called with the same arguments (title, worktreePath, pin) from both entry points as today.
- Dispatch's existing conditional (`EXECUTOR === 'codex' && pin/register`) stays at the dispatch orchestrator level, not pushed into the runtime — the runtime should accept `register: bool` and defer to caller for executor-specific gating.
- Regression test spawns `create-worktree.js --register` and `dispatch.js` with a codex-registered run through a shim executor; asserts both paths produce the same registration call.

**4. Cleanup parity — `removeWorktree` covers the two pre-existing dispatch.js call sites**
- `dispatch.js:611` (pre-create cleanup of stale worktree) and `:656` (post-failure cleanup) both call `removeWorktree` instead of inline `git(_, "worktree", "remove", "--force", ...)`.
- `removeWorktree` swallows the "not a working tree" / "already removed" error classes exactly as the current inline `try { ... } catch {}` does — a fresh test asserts no throw when the worktree does not exist.
- `create-worktree.js` gains a matching failure-cleanup path (currently absent) that calls `removeWorktree` — this is a small correctness improvement that falls out of the refactor, NOT a scope expansion.

### Quality factors

**5. Parity test suite for shared runtime**
- New test file `skills/relay-dispatch/scripts/worktree-runtime.test.js` with at minimum: (a) create branch fresh, (b) create branch that already exists (fallback path), (c) `--dry-run` produces the fixture string, (d) register flag invokes `registerCodexApp` with the expected shape, (e) cleanup is idempotent.
- Both entry-point tests (`create-worktree.test.js`, `dispatch.test.js` or equivalent) exercise the same runtime through their public CLI surface, not by importing the runtime directly — proves the parity claim end-to-end.
- Test delta target: ≥ +8 tests; suite must remain 100% green.

**6. Out-of-scope discipline + docs mirror**
- PR body explicitly defers: `relay-manifest.js` split (#188), `review-runner.js` decomposition (#189), grandfather retirement (#190), resolver/docs hygiene (#191).
- PR body explicitly does NOT touch `cleanup-worktrees.js` (separate lifecycle; tracked by #191's CLI hygiene scope when that starts).
- Docs mirror at `docs/issue-187-worktree-runtime.md` with: summary, 10-row audit table (every affected call site before/after), verbatim self-review `grep -n` output pinned to the FINAL post-fix tree, and deferred-issue inventory matching this plan's out-of-scope list.
- `Line-number drift discipline` section states the executor must regenerate the audit-table line numbers from source as the last edit of each round (per #174 r4 / #177 r3 meta-rule).

## Trust-model audit (per #210 rubric-trust-model.md)

This task **does not cross an auth boundary** by the #210 trigger criteria:
- Label: `enhancement` + `backlog`, not `phase-0-follow-up`.
- Keywords in the issue body: no `trust root`, no `grandfather`, no `gate-check`, no `validateTransition*` / `validateManifest*` / `evaluateReviewGate` callsites touched.
- Operator judgment: the refactor does not introduce new filesystem / GitHub / state-transition operations — it consolidates existing ones. `validateManifestPaths` is still called by the manifest layer before any worktree path reaches the runtime.

Therefore `rubric-trust-model.md`'s three-question checklist is **not triggered** here. `rubric-security.md`'s broad guidance applies: path handling stays trust-root anchored by the caller, no new symlink-follow path is introduced, no new subprocess invocations except the `git worktree add/remove` calls that already exist.

If the executor's implementation expands the runtime to perform path validation itself (rather than trusting the caller), the reviewer must re-trigger the trust-model checklist. The dispatch prompt must state this explicitly: **trust-root validation stays with the caller; the runtime is path-opaque.**

## Out of scope

- Replacing the `child_process.execFileSync` git calls with a library (`simple-git`, etc.) — no new dependencies.
- Changing dry-run output intentionally — if readability improvements are desirable, they go in a separate PR after the byte-identical parity is merged.
- Touching `cleanup-worktrees.js`. That is a standalone cleanup scanner, separate lifecycle; tracked separately.
- Expanding `removeWorktree` to handle worktree-in-an-invalid-state recovery. Current inline code is silent-on-error; the runtime must preserve that exactly.

## Next-session execution sequence

1. `node skills/relay-plan/scripts/probe-executor-env.js . --project-only --json` and `node skills/relay-dispatch/scripts/reliability-report.js --repo . --json` for current signal inputs.
2. Finalize this rubric via `/relay-plan 187` (or hand-finalize if the draft here is sufficient).
3. Dispatch via `/relay-dispatch` with the finalized rubric.
4. Standard review cycle; anticipate 2 rounds (parity-test edge cases are the likely round-1 miss surface).

## Prior-art references

- #155 (PR #155): rubric format precedent for refactor with parity-test requirements.
- #174 (PR #175): line-number drift discipline meta-rule (applies to the docs mirror audit table).
- `memory/feedback_rubric_enforcement_layer.md`: even for non-auth refactors, the rubric should name the exact call sites where behavior is preserved, not just "the same behavior".
