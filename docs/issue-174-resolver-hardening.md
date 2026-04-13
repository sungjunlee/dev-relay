# Issue 174 Resolver Hardening

This document mirrors the review-contract documentation from PR #175 into the tracked diff so relay-review can verify the pattern-break rationale, consumer audit, and sibling-builder audit directly from the repository.

## Pattern-Break Rationale

This is one PR, not iteration 5, because the failure pattern was the ladder itself: #149 fixed `filterByBranch`, #165 fixed the escalated+null fallback, #168 converted the branch fallback to a dispatched-only whitelist, and #170 fixed the branch+PR `filterByPr` composition site. Issue #174 recorded the stop-signal after that ladder: four consecutive codex challenges (`#149 -> #165 -> #168 -> #170`) each landed a narrow patch and exposed the next sibling path.

The cross-iteration STOP signal came from `memory/feedback_rubric_fail_closed.md` and is restated in issue #174: once the same invariant survives 3+ consecutive iterations, the next fix must break the pattern instead of adding another rung; issue #174 calls iteration 5 without a pattern break "compliance theater." The same memory update also adds the call-site extension meta-rule: the selector-composition audit axis applies to every call site of a selector, not only to the selector function name in the abstract.

## Implementation Choices

- E-axis: option (a) shipped. `resolveManifestRecord({ prNumber })` now uses a dedicated `filterOutTerminal(records)` helper at the standalone `--pr` site instead of growing an `excludeTerminal` parameter on `filterByPr`. That keeps `filterByPr` a pure selector and makes state-awareness explicit at each audited call site.
- R-axis: option (a) shipped. The mixed-state branch uses a dedicated `buildMixedStateRecoveryMessage()` builder instead of auto-returning the `review_pending` sibling or falling through to a generic ambiguity message. The recovery text says "fresh dispatch" because the terminal sibling is already terminal and the null-PR sibling does not carry the caller PR.
- Round 2 adjustment: `includeTerminal` exists only as an opt-in for `finalize-run --skip-merge` cleanup-by-PR. Default standalone `--pr` resolution stays hardened against stale merged/closed manifests.

## What Changed

- Expanded the resolver header from a selector-only audit into a selector x call-site x state-awareness audit table.
- Hardened the standalone `--pr` resolver path so terminal manifests are excluded by default, while `includeTerminal: true` remains reserved for cleanup-only callers.
- Kept the retry-path terminal-only `filterByPr` call as an intentional mixed-state detector and documented that choice inline.
- Added `safeFormatRunId()` and routed operator-facing error builders through safe candidate rendering.
- Validated manifest state before interpolating `stale_${state}_run`, with dedicated invalid-state and terminal-state branches that suppress impossible `close-run` guidance.
- Replaced the mixed terminal + `review_pending(pr:null)` generic ambiguity path with a dedicated fresh-dispatch recovery message.
- Added tracked documentation in this file so the reviewer can inspect the pattern-break rationale, consumer audit, and sibling-builder audit from the diff bundle instead of relying on PR-body visibility.

## Consumer Audit

| Consumer | Selector | Delta | Re-tested or deferred |
| --- | --- | --- | --- |
| `skills/relay-dispatch/scripts/dispatch.js:444` | explicit `--run-id` / `--manifest` only | No change | Re-tested by the full dispatch suite |
| `skills/relay-dispatch/scripts/close-run.js:72` | explicit `--run-id` only | No change | Re-tested by the close-run suite |
| `skills/relay-dispatch/scripts/update-manifest-state.js:120` | explicit `--run-id` or `--branch` only | No change | Re-tested by the full suite |
| `skills/relay-merge/scripts/gate-check.js:87` | `prNumber + (headRefName || undefined)` | Branchless `--pr` fallback now inherits the hardened standalone `--pr` contract | Re-tested by the resolver standalone-`--pr` tests and the gate-check PR-mode suite |
| `skills/relay-merge/scripts/finalize-run.js:223` | all selectors, including `--pr` alone | Default standalone `--pr` stays hardened; `includeTerminal: skipMerge` preserves cleanup-by-PR for `--skip-merge` | Re-tested by the resolver standalone-`--pr` tests and the full finalize-run suite |
| `skills/relay-merge/scripts/finalize-run.js:233` | repo-root rebind retry with the same selector set | Same as above | Re-tested by the full finalize-run suite |
| `skills/relay-review/scripts/review-runner.js:1037` | branch resolved first at `:1033` before resolver call | No change; this path does not hit standalone `--pr` resolution | Re-tested by the full review-runner suite |

## Sibling-Builder Audit

| Builder | `run_id` handling | State validation | Reachability result |
| --- | --- | --- | --- |
| `buildNoManifestError` | Safe via `formatCandidateDetails()` -> `safeFormatRunId()` | n/a | Emits only explicit-selector or fresh-dispatch guidance; no unreachable command text |
| `buildAmbiguousResolutionError` | Safe via `formatCandidateDetails()` -> `safeFormatRunId()` | n/a | Names only explicit selectors, which remain reachable for every ambiguous candidate set |
| `buildStaleBranchFallbackRecoveryMessage` | Uses `safeFormatRunId()` | Validates against `STATES` and `validateTransition(state, CLOSED)` | Suggests `close-run` only for closeable active stale-fallback states that can reach this path, including `draft`; invalid and terminal states suppress the command |
| `buildMixedStateRecoveryMessage` | Uses `safeFormatRunId()` | No state-derived command interpolation | Names only fresh dispatch for the null-PR sibling and explicitly states that the terminal sibling is already terminal |

## Tests And Verification

Commands:

- `node --test skills/*/scripts/*.test.js`
- `node --test skills/relay-dispatch/scripts/relay-resolver.test.js`
- `node --check skills/relay-dispatch/scripts/relay-resolver.js`
- `node --check skills/relay-merge/scripts/finalize-run.js`
- `node --check skills/relay-merge/scripts/gate-check.js`
- `grep -n "STATES.DRAFT\\|stale draft" skills/relay-dispatch/scripts/relay-resolver.test.js`

New or expanded regression coverage:

- `resolveManifestRecord includeTerminal:true returns a single merged manifest on standalone --pr`
- `resolveManifestRecord includeTerminal:true keeps standalone --pr ambiguous across multiple merged matches`
- `resolveManifestRecord includeTerminal:false rejects standalone --pr terminal-only matches with actionable recovery and clean recovery chain`
- `resolveManifestRecord rejects standalone --pr closed-only matches with the same terminal-only recovery shape`
- `resolveManifestRecord standalone --pr lets the cross-branch dispatched exact-PR match win over a stale merged sibling`
- `resolveManifestRecord names fresh dispatch for mixed terminal plus review_pending reuse and that recovery resolves cleanly`
- `close-run remains reachable across active states named in stale-fallback recovery contracts` now exercises `draft`, `dispatched`, `review_pending`, `changes_requested`, `ready_to_merge`, and `escalated`
- `finalize-run --skip-merge --pr resolves a merged manifest and continues cleanup`
- `finalize-run keeps standalone --pr hardened for stale merged manifests unless --skip-merge is set`

## Closes

- `Closes #174` because this PR lands the pattern break that issue #174 requires: selector call-site audit plus recovery-message hardening in one sweep instead of another narrow ladder rung.
- `Closes #171` because the resolver's operator-facing error builders now safe-format stored `run_id` values before rendering recovery text or candidate details.
- `Closes #172` because stale-fallback recovery now validates manifest state before suggesting `close-run`, suppresses impossible `stale_<bogus>_run` guidance, and the reachability coverage now includes the real `draft -> closed` path.

## Deferred Out Of Scope

- `#166`: tracked in #166, deferred per #174 out-of-scope rule.
- `#163`: tracked in #163, deferred per #174 out-of-scope rule.
- `#160`: tracked in #160, deferred per #174 out-of-scope rule.
- `#161`: tracked in #161, deferred per #174 out-of-scope rule.
- `#158`: tracked in #158, deferred per #174 out-of-scope rule.
- `#151`: tracked in #151, deferred per #174 out-of-scope rule.
- `#150`: tracked in #150, deferred per #174 out-of-scope rule.
- `#152`: tracked in #152, deferred per #174 out-of-scope rule.
- `#153`: tracked in #153, deferred per #174 out-of-scope rule.
