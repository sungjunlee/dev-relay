# Ranked deletion inventory

Measured 2026-08-03 against `f4eba91` plus the uncommitted overlay deletion.
Every LOC figure is `wc -l` on the real filesystem; runtime and test totals come
from `tests/ledger/vnext-baseline.generated.json`, refreshed by the ledger
generator rather than by hand. Every claim about what a block protects is checked
against a call site.

The ranking question is **does this block earn its size**, not **is this
correct**. A block earns its size when deleting it would let a named invariant
break in a way nothing else catches. Blocks are ranked by *unjustified* size —
LOC that no such invariant claims — not by raw size.

**One layer has been cut since this was first written.** The migration overlay is
gone: `runtime-generation.js` (2,044) and `legacy-recovery-shim.js` (169) with
their tests and fixtures, about −4,300 lines including tests. It was not cut on
the ranking below — an earlier proposal to delete the overlay's *retirement-gate
layer* was reviewed by four independent reviewers and withdrawn on measurement.
What cut it was measuring the mechanism's entry condition instead: every path to
a dispatchable marker required an attestation owned by a different UID up to `/`.
See [the disposition](decisions/2026-08-03-migration-overlay-disposition.md).

## Summary

| Layer | Files | LOC | Verdict |
| --- | ---: | ---: | --- |
| Dispatch runtime core | 16 | 6,039 | Justified. Each file owns a distinct invariant. |
| Migration overlay | — | — | **Deleted 2026-08-03.** |
| Relay tests | 53 | 14,253 | Mostly justified. |
| Test-accounting tooling | 11 | 3,185 | Largest candidate, but see §4 — its case is weaker than it first looks. |
| Ledger artifacts | 5 | 1,460 | 636 regenerate, 716 are hand-curated rationale, 108 prose/benchmark. |

## 1. Dispatch runtime, by invariant

| Block | LOC | Invariant it protects | Verdict |
| --- | ---: | --- | --- |
| `recover.js` | 1,488 | Inspect-before-write and re-inspect under the run lock with the same action key; the only general lifecycle writer | Justified — single writer is the point |
| `host.js` | 1,297 | Run lock, detached host, cancellation, sandbox containment; host locks are capabilities | Justified |
| `facts.js` | 739 | Append-only `events.jsonl`; merge authorization | Justified |
| `dispatch.js` | 622 | Worktree containment; dispatch never commits, pushes, opens a PR, or recovers | Justified |
| `run-store.js` | 591 | Immutable run/artifact trust boundary; regular-file containment | Justified |
| `inspect.js` | 533 | Pure fact fold to one typed action | Justified |
| `adapter-contract.js` | 353 | argv-only execution, capability fail-closed, reviewer isolation | Justified |
| `adapters/*` | 358 | Seven executors as four-method descriptors | Justified — variety is a requirement |
| `exec.js` | 58 | `execFileSync`/`spawn`, never interpolated shell | Justified |

Nothing in the core is a candidate. Each file maps to a distinct invariant with a
live call site, and the rows sum to exactly 6,039.

## 2. Migration overlay — deleted

| Block | LOC | Disposition |
| --- | ---: | --- |
| `runtime-generation.js` | 2,044 | Deleted 2026-08-03 |
| `legacy-recovery-shim.js` | 169 | Deleted 2026-08-03 |

Retained here because the *shape* of the earlier analysis is the reusable part.
Partitioning the 120 functions of `runtime-generation.js` by exclusive
reachability over the intra-file call graph, measured on `f4eba91`:

| Reachable only from | LOC |
| --- | ---: |
| CORE — steady-state dispatch / review / merge / recover | 43 exclusive, ~600 with shared infrastructure |
| CUTOVER — one-time migration | 303 exclusive |
| GATE — rollout ledger, retirement status, anchor verification | 326 exclusive |
| ROLLBACK | 113 exclusive |

Those exclusive rows sum to 785 of 2,044 lines — the rest is shared
infrastructure reachable from more than one entry, which is why the CORE row
carries both an exclusive figure and a ~600-line with-shared figure. The
partition ranked blocks; it never exhausted the file.

It also made the GATE slice look self-referential, machinery whose only job is
to prove other machinery deletable — and that reading was wrong in one specific
place: `currentLegacyIdentity` sat in that slice and was the only detector that
the legacy inventory was still being written to. **A reachability partition
ranks blocks; it does not tell you what a block catches.** The whole overlay
went in the end, but on a measurement of its entry condition, not on this
table.

## 3. Tests

Ranked by LOC against the invariant IDs the ledger assigns:

| Test block | LOC | Ledger invariants |
| --- | ---: | --- |
| `host-supervisor.test.js` | 862 | RR-02, RR-03, RR-04 |
| `inspect-recover-blackbox.test.js` | 857 | RR-05, RR-06 |
| `append-learnings.test.js` | 752 | RR-10, RR-11 |
| `finalize-run.test.js` | 742 | RR-10, RR-11 |
| `relay-recover-cli.test.js` | 727 | RR-05, RR-06 |
| `runtime-contract-vnext.test.js` | 672 | RR-01 |
| `sprint-owner.test.js` | 631 | RR-10, RR-11 |

The `RR-*` ids are real and defined:
`docs/contracts/relay-runtime-contracts.v1.json` names all twelve
(`RR-01 worktree_containment`, `RR-06 exact_review_binding`,
`RR-08 explicit_merge`, …) with a `vnext_test_path` each, and
`tests/relay-dispatch/scripts/runtime-contract-blackbox.test.js:6` consumes it.
The ledger's checker does resolve them: `vnext-test-ledger.js:28` builds the
frozen set `RR-01`…`RR-12` and line 223 does `CANONICAL_INVARIANTS.includes(id)`
— a membership check against a set identical to the contract file's id set, so
no accepted id can fail to resolve. An earlier draft of this document called
that a pattern match and claimed a gap; there is none.

**The `files[]` classification axis is degenerate.** All 53 entries are
`preserve-invariant`, one of four defined values. But the same artifact's
`retiredTestMappings` uses the other values for the retired entries
(`implementation-detail-delete`, `obsolete-surface-delete`), and
`REQUIRED_BY_CLASSIFICATION` enforces per-classification fields on them. So the
field discriminates nothing *for currently existing tests* while remaining load
bearing for retired ones — which narrows the available simplification.

## 4. Test-accounting tooling

| File | LOC | What it enforces |
| --- | ---: | --- |
| `skills-lint.test.js` | 683 | SKILL.md prose contracts and length limits |
| `vnext-test-ledger.js` | 609 | Generates/checks the site table and dispositions |
| `vnext-runtime-inventory.js` | 438 | Regenerates the script inventory from the filesystem |
| `script-reachability.test.js` | 307 | No unreachable scripts |
| `vnext-test-ledger.test.js` | 292 | Tests the generator |
| `pr-view-json-contract.js` + test | 267 | `gh pr view` JSON shape |
| `ci-test-coverage.test.js` | 193 | CI runs every test file |
| `vnext-runtime-inventory.test.js` | 193 | Tests the generator |
| `ci-matrix-completeness.test.js` | 152 | CI matrix covers every platform cell |
| `skill-inputs-drift.test.js` | 51 | Skill input drift |

3,185 LOC plus 1,460 lines of ledger artifacts to account for a 6,039-LOC runtime
and its tests. The genuine property is *silent test loss*: the generated site
table pins path + kind + lexical ordinal, so a deleted or renamed test shows up as
a reviewable diff. That is worth having.

This layer did **not** shrink when the runtime it accounts for lost 2,223 lines —
the ledgers gave back 68. That is tripwire A in
[the complexity criterion](decisions/2026-08-03-harness-complexity-criterion.md)
moving the wrong way, and it makes this the highest-yield remaining layer by
ratio rather than by raw size.

## Ranked candidates, highest yield first

1. **Collapse the ledger's degenerate `files[]` classification** (#1147).
   Smaller than it first appeared: `invariantIds` do resolve to a real contract,
   and `classification` is still used by `retiredTestMappings`. Scope the issue
   to the `files[]` axis and the dead `REQUIRED_BY_CLASSIFICATION` branches it
   implies. Do **not** include "teach the checker to resolve invariant ids" —
   it already does, by exact membership.
2. **Delete the duplicated `sprint-state.js`** (#1148).
   `skills/relay-merge/scripts/` and `skills/relay-fleet/scripts/` hold
   byte-identical 387-line copies (`md5 67a879fbd6684d77ac550fc111903834`).
   Cross-skill `require` is already the convention — `review-runner.js` and
   `finalize-run.js` both import `relay-dispatch`'s `facts` and `host` — so
   independence does not justify the copy, and nothing asserts the two stay in
   sync. −387 LOC.
