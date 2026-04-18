# Issue 191 Resolver History And CLI Cleanup

This PR is packaging-only cleanup for `relay-dispatch`: resolver history moves out of the runtime file, and thin Node entry points share one local CLI arg helper. Runtime behavior stays unchanged.

## Resolver Packaging Delta

- `skills/relay-dispatch/scripts/relay-resolver.js:1-5` now keeps only the three load-bearing invariants inline and points at `docs/relay-resolver-audit-history.md`.
- `skills/relay-dispatch/scripts/relay-resolver.js:31-32,75-99,117-118,140-141,177-178,217-218,237-246,265-266,322,359-360,378` keep invariant-only comments; the issue ladder and meta-rule prose moved to `docs/relay-resolver-audit-history.md`.
- `docs/relay-resolver-audit-history.md` now holds the selector x call-site audit table, the per-function history blocks, and the issue/meta-rule ledger that used to be embedded in the runtime file.

## CLI Helper Consumer Audit

| Consumer | Helper import | Helper usage |
| --- | --- | --- |
| `cleanup-worktrees.js` | `skills/relay-dispatch/scripts/cleanup-worktrees.js:26` | `getArg(args, ...)`, `hasFlag(args, ...)` replace local `--repo` / `--older-than` parsing. |
| `close-run.js` | `skills/relay-dispatch/scripts/close-run.js:12` | `getArg(args, ...)`, `hasFlag(args, ...)` replace local `--repo` / `--run-id` / `--reason` parsing. |
| `create-worktree.js` | `skills/relay-dispatch/scripts/create-worktree.js:40` | Array-form aliases (`["--branch", "-b"]`, `["--title", "-t"]`) now route through the shared helper. |
| `dispatch.js` | `skills/relay-dispatch/scripts/dispatch.js:86` | Shared helper replaces local arg parsing while `KNOWN_FLAGS` remains for positional-arg consumption. |
| `recover-state.js` | `skills/relay-dispatch/scripts/recover-state.js:25` | Shared helper preserves explicit `args`-first parsing for the recovery CLI. |
| `reliability-report.js` | `skills/relay-dispatch/scripts/reliability-report.js:6` | Shared helper replaces local `--repo`, `--stale-hours`, and report-flag parsing. |
| `update-manifest-state.js` | `skills/relay-dispatch/scripts/update-manifest-state.js:35` | Shared helper replaces local selector/state/update flag parsing. |

## Scope Boundaries

- In scope: `skills/relay-dispatch/scripts/cli-args.js`, its new test file, the seven relay-dispatch CLI entry points above, `skills/relay-dispatch/scripts/relay-resolver.js`, `docs/relay-resolver-audit-history.md`, and pinned resolver line-number refreshes in `docs/`.
- Out of scope: cross-skill helper dedupe in `skills/relay-intake/scripts/persist-request.js`, `skills/relay-plan/scripts/probe-executor-env.js`, `skills/relay-review/scripts/invoke-reviewer-codex.js`, `skills/relay-review/scripts/invoke-reviewer-claude.js`, `skills/relay-review/scripts/review-runner.js`, and `skills/relay-merge/scripts/finalize-run.js`.
