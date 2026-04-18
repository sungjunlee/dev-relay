# Issue 177 Fail-Closed State Validation

This document mirrors the review-contract evidence for issue #177 into the tracked diff so relay-review can verify the iteration-6 closure, the selector audit, the consumer audit, and the self-review grep output from the repository itself.

## Pattern-Break Rationale

This follow-up closes the iteration-6 HIGH class surfaced by the post-merge codex challenge of PR #175 (`501eb8e`), not iteration 7 in a new ladder. The failure class was still the sibling-axis gap inside the #174 pattern break: exact-PR exclusion sites handled known terminal states but still failed open on tampered or missing `state` values.

The post-merge challenge scope for this PR is narrowed to the 5-part Batch 1.5 invariant only, with no sibling-axis probes, because this PR is the sibling-axis closure for iteration 6. The canonical memory file is `~/.claude/projects/-Users-sjlee-workspace-active-harness-stack-dev-relay/memory/feedback_rubric_fail_closed.md`. The sprint cross-link for the stop trigger is `/Users/sjlee/workspace/active/harness-stack/dev-relay/backlog/sprints/2026-04-agentic-patterns-phase-0.md`, Progress entry `2026-04-13 13:53`, which records the iteration-6 STOP signal on `501eb8e`.

## Rule 7

**Fail-closed state-validation meta-rule (2026-04-14, from codex challenge on merged #174/PR #175):** selectors that EXCLUDE records by state must gate on a whitelist derived from the `STATES` enum, not on negation of a literal terminal blacklist, so tampered or missing `state` values fail-closed rather than fail-open.

**Why:** Rule 4 (state-machine-axis whitelist, 2026-04-12) established "whitelist not blacklist" on the state axis but was applied only to the state CITED IN THE BUG (merged/closed at #149, escalated at #165, any non-terminal + null pr at #168). Codex's post-merge challenge of `501eb8e` surfaced that #174's introduction of `BRANCH_ONLY_TERMINAL_STATES = {MERGED, CLOSED}` as a literal-match blacklist and inversion-as-exclusion (`!BRANCH_ONLY_TERMINAL_STATES.has(state)`) at two EXCLUSION sites — `filterOutTerminal()` and `filterByBranch({excludeTerminal: true})` — fails OPEN on tampered `state: "bogus"` or missing state: both sites ADMIT the stale record because it is not in the literal terminal set. Rule 4 was never applied to STATE PARSING itself. Exclusion-by-negation is structurally fail-open on anything not in the blacklist; exclusion-by-whitelist is structurally fail-closed on anything not in the whitelist. The asymmetry only reveals itself under manifest tampering or under a future state added to the enum but not to the exclusion set.

**How to apply:** every selector that filters records by state uses a whitelist predicate (`KNOWN_NON_TERMINAL_STATES.has(state)` or an `isNonTerminalState(state)` helper) rather than `!BRANCH_ONLY_TERMINAL_STATES.has(state)`. Define the whitelist by deriving from the enum: `KNOWN_NON_TERMINAL_STATES = new Set(Object.values(STATES).filter((s) => !BRANCH_ONLY_TERMINAL_STATES.has(s)))` — new states added to `STATES` are automatically admitted unless explicitly added to the blacklist, so the whitelist does not drift. DETECTION sites that positively ask "is this state terminal?" for classification (mixed-state detectors, UX branching on known terminal states, recovery-message state categorization) keep blacklist semantics by purpose and carry an inline comment naming meta-rule 7 AND the issues that introduced the site (e.g., `#170/#174/meta-rule 7`) so the next iteration does not misread the asymmetry as a state-blindness bug and flip it. Closed by #177/PR-pending.

## Selector x Call-Site x State-Awareness Audit Table

The runtime file now keeps only the invariant pointer at `skills/relay-dispatch/scripts/relay-resolver.js:1-5`; the full audit table lives in `docs/relay-resolver-audit-history.md`. Line numbers below are pinned to the current `relay-resolver.js` tree so this historical mirror stays re-anchored with the runtime selectors.

| Selector | Call site (line) | State-awareness verdict | Closed by |
| --- | --- | --- | --- |
| `filterByBranch` | `filterByBranchPrFallback:98` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:318` `branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:319` `nonTerminalBranchMatches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:341` `branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:342` `branch-only matches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByBranch` | `resolveManifestRecord:374` `branchMatches` | state-blind by purpose (error pool; sibling excludes) | #174 |
| `filterByBranch` | `resolveManifestRecord:376` `nonTerminalBranchMatches` | fail-closed via derived non-terminal whitelist (meta-rule 7) | #149/#177 |
| `filterByPr` | `resolveManifestRecord:323` branch+PR on `nonTerminal` | fail-closed via derived non-terminal whitelist composition (meta-rule 7) | #170/#177 |
| `filterByPr` | `resolveManifestRecord:351` standalone `--pr` candidates | state-blind by purpose (full PR candidate error pool) | #174 |
| `filterByPr` | `resolveManifestRecord:357` standalone `--pr` opt-in | state-blind by opt-in `includeTerminal=true` | #174 |
| `filterByPr` | `resolveManifestRecord:360` standalone `--pr` default | fail-closed via derived non-terminal whitelist composition (meta-rule 7) | #174/#177 |
| `filterByPr` | `resolveManifestRecord:379` retry terminal-only | terminal-only by purpose (mixed-state detector) | #170/#174/#177 |
| `filterByBranchPrFallback` | `resolveManifestRecord:320` branch+PR fallback | fail-closed via derived non-terminal whitelist (meta-rule 7) + dispatched-only whitelist | #168/#177 |
| `filterByBranchPrFallback` | `resolveManifestRecord:375` retry fallback | fail-closed via derived non-terminal whitelist (meta-rule 7) + dispatched-only whitelist | #168/#177 |
| `findManifestByRunId` | `resolveManifestRecord:304` explicit `--run-id` | state-blind by design | n/a |

## Consumer Audit Delta

| Consumer | Selector usage | Delta under #177 | Re-tested or deferred |
| --- | --- | --- | --- |
| `dispatch.js:444` | explicit `--run-id`/`--manifest` only | NO CHANGE | Dispatch suite |
| `close-run.js:72` | explicit `--run-id` only | NO CHANGE | Close-run suite |
| `update-manifest-state.js:120` | `--run-id` or `--branch` | NO CHANGE on `--run-id`; `--branch` path inherits whitelist via branch-only resolver | Update-state suite |
| `gate-check.js:~87` (called from `:217`) | `prNumber + (headRefName \|\| undefined)` | BRANCHLESS `--pr` fallback fail-closes on unknown states via new whitelist | Resolver standalone-`--pr` tests + gate-check PR-mode suite |
| `finalize-run.js:223` | all selectors | **CENTERPIECE**: default standalone `--pr` fail-closes on unknown states; `--skip-merge` path via `includeTerminal: true` UNAFFECTED — whitelist applies only to `excludeTerminal: true` / default-standalone paths | Resolver standalone-`--pr` tests + finalize-run suite |
| `finalize-run.js:233` | repo-root rebind retry, same selectors | Same as `:223` | Finalize-run suite |
| `review-runner.js:1037` | branch resolved first at `:1033` | NO CHANGE; does not hit standalone `--pr` | Review-runner suite |

## Self-Review Grep

```text
$ grep -n "!BRANCH_ONLY_TERMINAL_STATES" skills/relay-dispatch/scripts/relay-resolver.js

$ grep -n "BRANCH_ONLY_TERMINAL_STATES\|KNOWN_NON_TERMINAL_STATES\|isNonTerminalState" skills/relay-dispatch/scripts/relay-resolver.js
32:const BRANCH_ONLY_TERMINAL_STATES = new Set([STATES.MERGED, STATES.CLOSED]);
33:const KNOWN_NON_TERMINAL_STATES = new Set(
34:  Object.values(STATES).filter((state) => BRANCH_ONLY_TERMINAL_STATES.has(state) === false)
85:  return BRANCH_ONLY_TERMINAL_STATES.has(state);
88:function isNonTerminalState(state) {
89:  return KNOWN_NON_TERMINAL_STATES.has(state);
98:  // states fail-closed via the derived KNOWN_NON_TERMINAL_STATES whitelist rather than fail-open via
99:  // negation of BRANCH_ONLY_TERMINAL_STATES. Called at the standalone --pr default site (#174/#177).
100:  return records.filter((record) => isNonTerminalState(record?.data?.state));
113:    // to !isNonTerminalState(state) (fail-closed on unknown/tampered state values). Escalated stays
116:    if (excludeTerminal && !isNonTerminalState(record?.data?.state)) {
154:  // KNOWN_NON_TERMINAL_STATES whitelist as defense-in-depth. In normal flow this classifier only
157:  return isNonTerminalState(record?.data?.state)
441:    // #177 converted every EXCLUSION site to the KNOWN_NON_TERMINAL_STATES whitelist but
449:      branchMatches.filter((record) => BRANCH_ONLY_TERMINAL_STATES.has(record?.data?.state)),
```

## Verification

New resolver regressions added in this PR:

- branch+PR exact-PR fail-closed on `state="bogus"` with a fresh `dispatched/pr=null` sibling
- branch+PR exact-PR fail-closed on `state="bogus"` alone
- branch+PR exact-PR fail-closed on missing `state`
- standalone `--pr` fail-closed on `state="bogus"` with a fresh `dispatched/pr=null` sibling
- standalone `--pr` fail-closed on `state="bogus"` alone
- standalone `--pr` fail-closed on missing `state`
- preserved dispatched exact-PR resolution at both site A and site B
- preserved `finalize-run --skip-merge --pr` merged-manifest cleanup path

## Deferred Out Of Scope

This mirror intentionally leaves the following out of scope. Each deferred item remains tracked as its own issue; this PR does not touch them even where the audit tempts.

- `#176` — `cleanup-worktrees.js:88,94` raw `run_id` leak (MED). Filed as a separate follow-up to the iteration-6 codex challenge; linked from `#177`.
- `#166` — concurrent gate-check stamping duplicates audit events (LOW).
- `#163` — layer-higher recovery-path executability (MED).
- `#160` — `paths.repo_root` / `paths.worktree` trust root validation (sibling-field class from #156).
- `#161` — symlink rubric bypass (`path.resolve` vs `fs.realpath`).
- `#158` — run-id collision under concurrent dispatch (LOW-MED).
- `#151` — grandfather flag redesign into migration manifest + provenance.
- `#150` — skip-path rubric status in audit trail.
- `#152` — consistent repo-slug + path resolution.
- `#153` — test fixtures default grandfathered; attack-surface coverage.
