---
id: RELAY-767
title: Retire update-manifest-state.js (recover-state is canonical); document sprint-close-report.js
status: To Do
labels:
  - documentation
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Problem

Two operator scripts have pending disposition decisions flagged in `docs/script-inventory-and-cleanup.md` but never executed:

| File | Lines | Pending decision |
|---|---|---|
| `skills/relay-dispatch/scripts/update-manifest-state.js` | 190 | Overlaps `recover-state.js` (the canonical structured recovery command). Inventory doc: "needs a deprecation decision because it remains in the public CLI schema." Repo rule: "Sunset deprecated flags within one release." Decision: **remove** — recover-state.js is canonical. |
| `skills/relay-merge/scripts/sprint-close-report.js` | 299 | Shipped in #146 as a report-only operator utility, but no SKILL.md or references doc explains when to run it — violating the inventory rule "Optional operator tool: keep only if a skill or reference doc explains when to run it." Decision: **document** (it is recent and functional). |

## Scope

1. Delete `skills/relay-dispatch/scripts/update-manifest-state.js` and its tests under `tests/relay-dispatch/`. Remove its entry from `skills/relay-dispatch/scripts/cli-schema.js` and from `skills/relay-dispatch/references/cli-schema.md` if listed. If `skills/relay-dispatch/references/recovery-playbook.md` or `operator-utilities.md` reference it, replace those references with the `recover-state.js` equivalent invocation.
2. Document `sprint-close-report.js` in `skills/relay-merge/references/` (either a short section in an existing operator reference or a new one), covering: when to run it (sprint close), the invocation command, and what the report contains. Add a one-line pointer from `relay-merge/SKILL.md` only if it fits within the 150-line budget; otherwise the reference doc alone satisfies the rule.
3. Update the corresponding rows in `docs/script-inventory-and-cleanup.md` (update-manifest-state → deleted with this issue as decision record; sprint-close-report → documented operator tool with the reference path).

## Acceptance Criteria

- AC1: `grep -rn "update-manifest-state" skills tests README.md CLAUDE.md` returns zero matches.
- AC2: `node --test tests/relay-dispatch/scripts/cli-schema.test.js` passes with the entry removed.
- AC3: `grep -rln "sprint-close-report" skills/relay-merge/references/` returns at least one doc, and that doc contains a runnable `node skills/relay-merge/scripts/sprint-close-report.js` invocation line.
- AC4: Full test suite green across all `tests/*/scripts/*.test.js` suites.
- AC5: No files modified outside: the Scope 1 deletions, `skills/relay-dispatch/scripts/cli-schema.js`, `skills/relay-dispatch/references/`, `skills/relay-merge/references/`, `skills/relay-merge/SKILL.md` (optional pointer only), `docs/script-inventory-and-cleanup.md`.

Note: this issue and the unwired-helper deletion issue both edit `cli-schema.js` / `cli-schema.md` / the inventory doc — if dispatched in parallel, expect a trivial rebase; prefer serial merge.

Part of the skills-packaging cleanup audit (2026-07-05).

## Scope amendment (pre-dispatch, 2026-07-05)

Planner verification found two additional hardcoded references that Scope 1 must cover:
- `tests/relay-dispatch/scripts/cli-schema.test.js` (~line 166): drop the `update-manifest-state` registry expectation entry.
- `tests/relay-dispatch/scripts/cli-args.test.js` (~line 103): the test "readArg rejects -h as a value for update-manifest-state state flags" must be re-anchored to a surviving registered CLI (use `recover-state`), keeping the `readArg rejects -h` guard behavior covered — do NOT delete this test. Keep the test name prefix `readArg rejects -h` verbatim.

Also verified: no `skills/**/*.md` doc references `update-manifest-state` (the conditional "replace references in recovery-playbook/operator-utilities" branch in Scope 1 is confirmed empty — no doc edits needed there). AC5's allowed-file list includes the two test files above.

