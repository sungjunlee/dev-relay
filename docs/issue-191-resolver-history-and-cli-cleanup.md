# Issue 191 Resolver History And CLI Cleanup

This PR is packaging-only cleanup for `relay-dispatch`: resolver history moves out of the runtime file, and thin Node entry points share one local CLI arg helper. Runtime behavior stays unchanged.

## Resolver Packaging Delta

- `skills/relay-dispatch/scripts/relay-resolver.js:1-5` now keeps only the three load-bearing invariants inline and points at `docs/relay-resolver-audit-history.md`.
- `skills/relay-dispatch/scripts/relay-resolver.js:31-32,75-99,117-118,140-141,177-178,217-218,237-246,265-266,322,359-360,378` keep invariant-only comments; the issue ladder and meta-rule prose moved to `docs/relay-resolver-audit-history.md`.
- `docs/relay-resolver-audit-history.md` now holds the selector x call-site audit table, the per-function history blocks, and the issue/meta-rule ledger that used to be embedded in the runtime file.

## Before/After Resolver Metrics

| Metric | `origin/main` | post-r3 |
| --- | --- | --- |
| File line count | `489` | `418` |
| Comment line count via `grep -c "^\\s*//"` | `91` | `20` |

The earlier review note that described the pre-cleanup comment mass as `~60` was directionally right but not exact. Re-running the literal `grep -c "^\\s*//"` command against the current `origin/main` blob yields `91`, so this mirror pins the exact count instead of the earlier shorthand.

The three load-bearing invariants that stay inline in `relay-resolver.js:1-5` are:

- fail-closed state-exclusion whitelist discipline from meta-rule 7 (`KNOWN_NON_TERMINAL_STATES`)
- selector-composition audit axis across branch/PR call sites
- state-machine-axis whitelist that keeps null-PR fallback dispatched-only

## CLI Helper Consumer Audit

| Consumer | Helper import | Helper usage | `reservedFlags` | Behavior proof |
| --- | --- | --- | --- | --- |
| `cleanup-worktrees.js` | `skills/relay-dispatch/scripts/cleanup-worktrees.js:26` | `getArg(args, ...)`, `hasFlag(args, ...)` replace local `--repo` / `--older-than` parsing. | none; origin/main already used `startsWith("--")`, so no `-h` regression. | `cleanup-worktrees.test.js`; `cli-args.test.js` keeps single-dash payloads as data, which is the origin/main contract for this caller. |
| `close-run.js` | `skills/relay-dispatch/scripts/close-run.js:12` | `getArg(args, ...)`, `hasFlag(args, ...)` replace local `--repo` / `--run-id` / `--reason` parsing. | `["-h"]` | `close-run.test.js`; `cli-args.test.js` covers the r3 `--reason -h` regression. |
| `create-worktree.js` | `skills/relay-dispatch/scripts/create-worktree.js:40` | Array-form aliases (`["--branch", "-b"]`, `["--title", "-t"]`) now route through the shared helper. | local `KNOWN_FLAGS` list, including `-b`, `-t`, `-h` | `create-worktree.test.js`; `cli-args.test.js` covers reserved short-alias rejection with `reservedFlags: ["-b", "-t"]`. |
| `dispatch.js` | `skills/relay-dispatch/scripts/dispatch.js:86` | Shared helper replaces local arg parsing while `KNOWN_FLAGS` remains for positional-arg consumption. | local `KNOWN_FLAGS` list, including `-b`, `-p`, `-e`, `-m`, `-h` | `dispatch.test.js`; `cli-args.test.js` covers the reserved-flag regression shape that dispatch delegates through its local `KNOWN_FLAGS` list. |
| `recover-state.js` | `skills/relay-dispatch/scripts/recover-state.js:25` | Shared helper preserves explicit `args`-first parsing for the recovery CLI. | `["-h"]` | `recover-state.test.js`; `cli-args.test.js` covers the r3 `--reason -h` guard that this caller shares with `close-run.js`. |
| `reliability-report.js` | `skills/relay-dispatch/scripts/reliability-report.js:6` | Shared helper replaces local `--repo`, `--stale-hours`, and report-flag parsing. | `["-h"]` | `reliability-report.test.js`; `cli-args.test.js` covers the r3 `--stale-hours -h` regression. |
| `update-manifest-state.js` | `skills/relay-dispatch/scripts/update-manifest-state.js:35` | Shared helper replaces local selector/state/update flag parsing. | `["-h"]` | `update-manifest-state.test.js`; `cli-args.test.js` covers the r3 `--state -h` regression. |

Round 3 restores origin/main `-h` guard semantics for the four remaining callers: `close-run.js`, `recover-state.js`, `reliability-report.js`, and `update-manifest-state.js`. `cleanup-worktrees.js` did not carry this regression because its origin/main parser already rejected only `--*` lookalikes via `startsWith("--")`, so no short-alias reservation was needed there.

## Grep Proofs

`grep -n "function getArg\\|function hasFlag" skills/relay-dispatch/scripts/*.js`

```text
skills/relay-dispatch/scripts/cli-args.js:1:function getArg(args, flag, fallback = undefined, options = {}) {
```

`grep -rn "require.*\\./cli-args" skills/relay-dispatch/scripts/*.js`

```text
skills/relay-dispatch/scripts/cleanup-worktrees.js:26:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/cli-args.test.js:4:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/close-run.js:12:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/create-worktree.js:40:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/dispatch.js:86:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/recover-state.js:25:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/reliability-report.js:6:const { getArg, hasFlag } = require("./cli-args");
skills/relay-dispatch/scripts/update-manifest-state.js:35:const { getArg, hasFlag } = require("./cli-args");
```

The raw `*.js` grep includes `cli-args.test.js`. Excluding tests leaves the seven production callers listed in the audit table above.

`grep -n "^\\s*//" skills/relay-dispatch/scripts/relay-resolver.js | wc -l`

```text
20
```

`grep -rn "require.*/\\cli-args\\|require.*cli-args" skills/relay-intake skills/relay-plan skills/relay-review skills/relay-merge`

```text
```

The command produced no output and exited `1`, which is the expected zero-match proof for no cross-skill contamination.

## Byte-Identical Preservation

> All runtime behavior MUST remain unchanged. Any edge case that existed before MUST remain tolerated identically. This PR enforces the prescriptive-language discipline from `memory/feedback_rubric_byte_identical_preservation_language.md` and the behavior-matrix enumeration discipline from `memory/feedback_refactor_byte_identical_matrix.md`. The r2/r3 review rounds surfaced a `-h` short-alias regression hidden by the "Single-dash values pass through as data" assertion in the original rubric; the fix added per-caller `reservedFlags` lists that enumerate every short alias that existed in each caller's origin/main `KNOWN_FLAGS` array.

## Line-Number Drift Discipline

> All pinned line numbers in this doc and in sibling `docs/issue-*.md` files were regenerated from the post-r3 tree as the last edit of the session. Sibling docs touched for line-number refresh: `docs/issue-174-resolver-hardening.md`, `docs/issue-177-fail-closed-state-validation.md`, `docs/issue-166-gate-check-stamping-concurrency.md`, `docs/issue-176-cleanup-worktrees-raw-runid.md`.

## Scope Boundaries

- In scope: `skills/relay-dispatch/scripts/cli-args.js`, its new test file, the seven relay-dispatch CLI entry points above, `skills/relay-dispatch/scripts/relay-resolver.js`, `docs/relay-resolver-audit-history.md`, and pinned resolver line-number refreshes in `docs/`.
- Out of scope: cross-skill helper dedupe in `skills/relay-intake/scripts/persist-request.js`, `skills/relay-plan/scripts/probe-executor-env.js`, `skills/relay-review/scripts/invoke-reviewer-codex.js`, `skills/relay-review/scripts/invoke-reviewer-claude.js`, `skills/relay-review/scripts/review-runner.js`, and `skills/relay-merge/scripts/finalize-run.js`.
