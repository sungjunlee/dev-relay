# Test accounting retirement evidence (#1196)

Measured 2026-08-09 with `wc -l` against `HEAD` for removed files and the
working tree for replacements.

| Old mechanism | Before LOC | Unique failure it claimed | Replacement / decision | After LOC |
| --- | ---: | --- | --- | ---: |
| Test ledger generator, its tests, and five ledger artifacts | 1,859 | Deleted/renamed test identity or stale generated output | Direct filesystem↔CI equality plus exact directive policy; ordinal accounting deleted | 275 |
| Runtime inventory generator, its tests, and generated contract | 1,569 | Unknown/missing installed scripts and edges | `script-reachability.test.js` remains the distinct orphan-script guard; duplicate inventory deleted | 0 new |
| Two CI coverage/matrix guards | 345 | Suite omission, wrong runner, or vacuous execution | One `ci-relay-matrix.test.js` checks exact bidirectional membership, duplicates/multiple matrices, exact runners, recursive guarded files, zero-test refusal, serialization, and layout | 217 |
| Uncalled shadow parity corpus | 572 | None: production and test callers were zero | Delete | 0 |
| **Total** | **4,345** | | | **492** |

Net accounting reduction is **3,853 LOC** before the additional narrowing of
`recover.__testing`. The current tree contains zero generated inventory or
ledger artifacts.

The directive guard identifies the 11 permanent exceptions by exact relative
path and normalized literal test name: nine macOS sandbox canaries and two
explicit live-executor canaries. It rejects `.only`, todo, every other skip, and
duplicate allowlisted skips without relying on line or ordinal identity.

The RR contract remains separate because it owns a distinct fail-closed check:
all 12 invariant ids resolve through `relay_test_path` to an exact current named
test. No new generator, writer, baseline, or refresh workflow was introduced.
