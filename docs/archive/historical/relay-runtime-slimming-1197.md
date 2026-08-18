# Relay runtime slimming closure (#1197)

Measured 2026-08-10 from the merged `main` filesystem. Counts use `wc -l` on
the named source sets; no generated ledger or inventory is treated as authority.

## Outcome

| Measure | Epic baseline | Final | Change |
| --- | ---: | ---: | ---: |
| `skills/relay-dispatch/scripts/**/*.js` | 16 files / 6,906 LOC | 16 files / 6,226 LOC | −680 LOC |
| Relay `*.test.js` files | 48 files / 14,848 LOC | 48 files / 13,985 LOC | −863 LOC |
| `recover.js` | 2,187 LOC | 1,476 LOC | −711 LOC |
| Test-accounting mechanism measured by #1196 | 4,345 LOC | 498 LOC | −3,847 LOC |
| Unjustified current `vNext` terminology | 63 files / 275 matching lines | 0 | removed |

The five remaining `vNext` strings in three current files are not runtime
terminology: three point at dated historical evidence and two assert that the
retired `--bootstrap-vnext` and `.git/relay-runtime-vnext` surfaces stay closed.
All current test and fixture filenames use Relay-neutral names.

## The 6,000 LOC target

The final runtime is 226 LOC above the aspirational 6,000 LOC target. This is an
accepted evidence-backed exception, not an unmeasured miss. The current 6,226
lines are partitioned among eight live invariant owners plus the seven flat
adapter descriptors:

- `recover.js`: inspect-before-write, same-action reinspection under lock, and
  the sole general lifecycle writer.
- `host.js`: capability locks, detached supervision, cancellation, runtime
  binding, and process-scope cleanup.
- `dispatch.js`: worktree containment and dispatch-only orchestration, including
  the independently fixed worktree-base creation boundary from #1191.
- `facts.js`, `run-store.js`, and `inspect.js`: append-only facts, immutable
  regular-file trust boundaries, and the pure derived action.
- `adapter-contract.js`, `exec.js`, and `adapters/*`: argv-only execution,
  fail-closed capability negotiation, and the seven required native executors.

The ranked deletion review found no caller-free runtime block after #1193–#1196.
Cutting the remaining 226 lines would therefore weaken a named invariant or
remove a supported executor; the user accepted the recommended evidence-first
closure rather than a cosmetic line target.

## Verification

- Full serialized local gate at that historical snapshot: 585 tests, 583 pass,
  0 fail, and 2 opt-in live-provider skips. Those canaries were retired by
  #1234 and are not part of the current gate.
- PR #1202 GitHub matrix: all nine suites green after the final review fix.
- Independent adversarial review: LGTM, no remaining P1/P2.
- The surviving direct guards fail closed on CI job/runner drift, vacuous test
  execution, unauthorized skip/todo/only directives, unreachable packaged
  scripts, and stale RR test anchors.

No migration overlay, mutable manifest lifecycle, second recovery writer,
dispatch-side recovery, generated accounting authority, or incomplete run
lifecycle was introduced.
