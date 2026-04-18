# Relay Resolver Audit History

This file carries the resolver's iteration history, selector audit table, and issue/meta-rule ledger so `skills/relay-dispatch/scripts/relay-resolver.js` can keep only the load-bearing invariants inline.

## Selector x Call-Site Audit Table

Call-site extension meta-rule: when fixing one selector call site, audit every other call site of that selector in the same PR (iteration-4 scope-boundary trap note, `memory/feedback_rubric_fail_closed.md`; closes the `#149 -> #165 -> #168 -> #170` ladder).

Fail-closed state-validation meta-rule 7 (`memory/feedback_rubric_fail_closed.md`): every EXCLUSION site that filters by state must gate on a whitelist derived from `STATES`, not on negation of the terminal blacklist.

| Selector | Call site (line) | State-awareness verdict | Closed by |
| --- | --- | --- | --- |
| `filterByBranch` | `filterByBranchPrFallback:98` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:318 branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:319 nonTerminalBranchMatches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:341 branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:342 branch-only matches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:374 branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:376 nonTerminalBranchMatches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByPr` | `resolveManifestRecord:323 branch+PR on nonTerminal` | fail-closed via derived non-terminal whitelist composition (meta-rule 7) | #170/#177 |
| `filterByPr` | `resolveManifestRecord:351 standalone --pr candidates` | state-blind by purpose (full PR candidate error pool) | #174 |
| `filterByPr` | `resolveManifestRecord:357 standalone --pr opt-in` | state-blind by opt-in includeTerminal=true | #174 |
| `filterByPr` | `resolveManifestRecord:360 standalone --pr default` | fail-closed via derived non-terminal whitelist composition (meta-rule 7) | #174/#177 |
| `filterByPr` | `resolveManifestRecord:379 retry terminal-only` | terminal-only by purpose (mixed-state detector) | #170/#174/#177 |
| `filterByBranchPrFallback` | `resolveManifestRecord:320 branch+PR fallback` | fail-closed via derived non-terminal whitelist (meta-rule 7) + dispatched-only whitelist | #168/#177 |
| `filterByBranchPrFallback` | `resolveManifestRecord:375 retry fallback` | fail-closed via derived non-terminal whitelist (meta-rule 7) + dispatched-only whitelist | #168/#177 |
| `findManifestByRunId` | `resolveManifestRecord:304 explicit --run-id` | state-blind by design | n/a |

See `docs/issue-177-fail-closed-state-validation.md` for consumer audit, grep proof, and the iteration-6 pattern-break rationale.

## Per-Function Meta-Rule History

### `formatRunId`

> Raw stored run_id stays available for happy-path rendering and validated explicit selectors.
> Error builders must use safeFormatRunId so tampered manifests cannot echo unsafe values (#171/#174).

### `filterOutTerminal`

> [fail-closed whitelist] meta-rule 7 (`memory/feedback_rubric_fail_closed.md`): unknown/tampered
> states fail-closed via the derived KNOWN_NON_TERMINAL_STATES whitelist rather than fail-open via
> negation of BRANCH_ONLY_TERMINAL_STATES. Called at the standalone --pr default site (#174/#177).

### `filterByBranch`

> [fail-closed whitelist] via excludeTerminal opt-in (#149/#177). See audit table; this selector
> 7 resolveManifestRecord call sites plus 1 helper-composition call site in this file.
> Callers must opt in for stale-inheritance-sensitive paths; standalone branch-only resolution does.

> #149 introduced terminal exclusion; #177 meta-rule 7 (`memory/feedback_rubric_fail_closed.md`)
> converts the predicate from terminal-blacklist negation (fail-open on unknown)
> to !isNonTerminalState(state) (fail-closed on unknown/tampered state values). Escalated stays
> eligible because operators can recover by closing and re-dispatching (#163); only known
> terminal states and unknown/tampered states are excluded.

### `filterByPr`

> [state-aware] only when callers compose it with the correct subset. See audit table;
> this selector has 5 call sites in resolveManifestRecord, and #174 audits each one for
> terminal-state handling so the selector itself stays simple.

### `filterByBranchPrFallback`

> [state-aware whitelist] dispatched + null only (#168). See audit table; this selector has
> 2 resolveManifestRecord call sites, and the state axis stays a whitelist, not a blacklist.

> #168: treat the state-machine axis as a whitelist, not a blacklist. Fixing only the state named
> in the latest bug is compliance theater; the only legitimate null-pr fallback is DISPATCHED.

### `isStaleNullPrSibling`

> [fail-closed classifier] meta-rule 7 (`memory/feedback_rubric_fail_closed.md`): uses the derived
> KNOWN_NON_TERMINAL_STATES whitelist as defense-in-depth. In normal flow this classifier only
> receives records from nonTerminalBranchMatches (already whitelist-filtered via filterByBranch),
> but tightening keeps the classifier safe if a future caller feeds it an unfiltered set.

### `findStaleNonTerminalBranchFallbackCandidate`

> #168: a single non-terminal branch match whose state is NOT on the branch-fallback whitelist
> (anything except DISPATCHED) with no stored pr_number is stale-inheritance-eligible under the
> pre-#168 predicate. Treat every such state the same way so recovery messaging is uniform
> across escalated / review_pending / changes_requested / ready_to_merge. Generalizes the prior
> escalated-only helper per the state-machine-axis whitelist meta-rule from
> memory/feedback_rubric_fail_closed.md.

### `buildStaleBranchFallbackRecoveryMessage`

> #174 reachability audit: close-run is only suggested when validateTransition(state, CLOSED)
> succeeds. Terminal and invalid states get command-free recovery text instead.

### `buildNoManifestError`

> #174 reachability audit: this builder only emits commandless terminal-only/fresh-dispatch text
> plus caller-supplied recovery that must already be state-validated by the caller.

### `buildAmbiguousResolutionError`

> #174 reachability audit: the only operator actions named here are explicit selectors, which remain
> valid for every ambiguous candidate set. Mixed terminal/non-terminal recovery uses its own builder.

### `buildMixedStateRecoveryMessage`

> #174 reachability audit: the terminal sibling is already terminal and the fresh sibling cannot
> advance via same-run resume here, so the only documented recovery is a fresh dispatch.

### `findManifestByRunId`

> [state-blind by design] explicit selectors must resolve EVERY state to keep operator
> recovery reachable; see audit table for the single resolveManifestRecord call site.

### `resolveManifestRecord`

> #170: compose the PR selector with the non-terminal branch subset so stale merged/closed
> manifests with stored pr_number === prNumber cannot shadow a fresh dispatched+null run.
> Selector-composition axis enumeration meta-rule (`memory/feedback_rubric_fail_closed.md`):
> the state-machine axis is a property of EVERY resolver selector; #149 closed it for the
> branch selector, #168 for the dispatched-only fallback helper, and this commit closes it for
> the exact-PR selector at this composition site. branchMatches stays bound for the preserved
> candidates list passed into the no-match error.

> #174 end-to-end recovery audit: when a mixed terminal/non-terminal collision tells the
> operator to create a fresh DISPATCHED run, the next lookup must let that single fallback
> win over stale null-pr siblings instead of re-opening the ambiguity ladder.

> #177 / meta-rule 7: a branch with an unknown or missing state must fail closed instead of
> silently rebinding exact-PR resolution to the dispatched+null fallback.

> standalone --pr is hardened by default (E1, #174); finalize-run --skip-merge opts into terminal inclusion to preserve the documented cleanup workflow.

> #174 / call-site extension meta-rule: standalone --pr must also exclude merged/closed
> siblings, not just the branch+PR composition path.

> #170/#174/meta-rule 7: this retry path deliberately asks a DIFFERENT question than the
> exact-PR resolver above. The mixed-state detector originated in #170 (stale terminal +
> matching stored PR vs fresh non-terminal sibling); #174 refined the ambiguity branch;
> #177 converted every EXCLUSION site to the KNOWN_NON_TERMINAL_STATES whitelist but
> INTENTIONALLY preserves blacklist semantics HERE because the predicate asks "which branch
> matches are KNOWN terminal states?" for positive detection, not for exclusion
> (`memory/feedback_rubric_fail_closed.md`, meta-rule 7). A tampered `bogus` state is NOT a
> terminal sibling and correctly stays out of terminalExactPrMatches; do NOT flip to
> whitelist here — the mixed-state detector would then misfire on unknown states and mask
> the fail-closed contract at the EXCLUSION sites.

## Issue-Number Ledger

### Issues

- `#149`: closed the original terminal-state exclusion surface on branch matching.
- `#163`: forced recovery-path language to stay executable, which is why stale-run messaging still names only reachable operator actions.
- `#168`: closed the null-PR fallback surface by making dispatched the only legitimate branch fallback state.
- `#170`: closed the exact-PR selector-composition surface so stale terminal siblings cannot shadow fresh dispatched runs.
- `#174`: closed the selector x call-site audit sweep, standalone `--pr` hardening, and recovery-builder reachability audit.
- `#177`: closed the fail-closed state-validation surface by deriving exclusion predicates from `STATES`.

### Meta-Rules

- `Enforcement-layer split + sibling trust-root audit`: separate visible behavior from fail-closed gates, and audit sibling trust roots that feed the same downstream surface.
- `State-machine-axis whitelist`: when the bug lives on the state axis, enumerate every relevant state and prefer the smallest legitimate whitelist.
- `Recovery-path end-to-end regression`: any operator recovery claim needs a full executable regression, not just a printed suggestion.
- `Selector-composition axis enumeration`: when one resolver selector needs state discipline, audit every sibling selector feeding the same consumer path.
- `Cross-iteration STOP signal`: after repeated post-merge challenges on the same invariant, escalate to a broader sweep instead of another narrow rung.
- `Call-site extension / scope-boundary trap`: on the first iteration of a new selector rule, audit every call site of the affected helper, not just the surfaced branch.
- `Fail-closed state-validation meta-rule 7`: exclusion sites must whitelist known states so tampered or future states fail closed instead of failing open.
