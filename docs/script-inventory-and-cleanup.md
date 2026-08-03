# Relay Runtime Inventory and Retirement Status

This is the current vNext inventory, not a history of the legacy manifest
runtime. Historical cleanup rationale remains under [`docs/archive/`](archive/).

## Installed dispatch package

The sealed vNext production bootstrap currently installs **18 JavaScript
files / 8,262 production LOC** under `skills/relay-dispatch/scripts/`.

| Group | Files | LOC | Purpose |
| --- | ---: | ---: | --- |
| Core | 8 | 5,691 | `dispatch`, `inspect`, `recover`, `run-store`, `facts`, `host`, `exec`, and `adapter-contract`. |
| Universal adapters | 8 | 358 | Registry and the seven retained native executor descriptors. |
| Migration overlay | 2 | 2,213 | `runtime-generation` and `legacy-recovery-shim`; required only for controlled cutover. |

After the migration gate, the installed production target is **16 JavaScript
files / 6,049 production LOC**: the core plus all seven executors. This target
does not reduce executor variety.

These counts are measurements, not goals. The installed file and LOC totals are
generated into `tests/ledger/vnext-baseline.generated.json` by the ledger
generator; the per-group and post-gate rows are arithmetic on those same
per-file counts. Refresh them by regenerating, never by editing the numbers.
The current totals are larger than the figures published at the vNext reset
because production CLI isolation (#1141) added credential staging, the signed
two-phase cleanup lifecycle, and runtime-identity binding to `host` and `facts`,
and #1144 added the generation-marker shape history to `runtime-generation`.

The inventory checker is authoritative for all relay skill scripts, including
cross-skill imports and dynamic entry-point edges:

```bash
node tests/skills-lint/scripts/vnext-runtime-inventory.js .
```

It must report no unknown or missing scripts and no unaccounted edges. The
test-site ledger independently accounts for every currently existing relay test:

```bash
node tests/skills-lint/scripts/vnext-test-ledger.js generate
node tests/skills-lint/scripts/vnext-test-ledger.js check
```

Generation observes the filesystem; it never executes the flake benchmarks.
Use the explicit measurement command only when refreshing the checked-in,
repeat-based E2E observation.

## vNext ownership

| Surface | Single owner |
| --- | --- |
| Immutable run identity and regular-file checks | `run-store.js` |
| Append-only fact validation and merge authorization | `facts.js` |
| Derived lifecycle action | `inspect.js` |
| Git/GitHub observation and idempotent recovery/close | `recover.js` via `relay-recover.js` |
| Host lock, supervisor, cancellation, sandbox | `host.js` |
| Writer-generation admission and legacy observation | `runtime-generation.js` |
| Executor argv/capability/output contract | `adapter-contract.js` and `adapters/` |

`dispatch.js` only starts an attempt. `review-runner.js` only records a bound
review. `finalize-run.js` only performs an explicit exact-SHA merge. None owns a
second lifecycle state or app-registration protocol.

## Removed runtime accretion

The following categories have been removed from the installed runtime and their
tests deleted or replaced with vNext coverage: mutable manifest slices and
facades, relay event helpers, resolver/observer folds, execution-evidence
sidecars, publish/rebrand/reconcile/recover command family, worktree create and
cleanup utilities, app registration, executor transport duplicates, live
dogfood commands, CLI parser duplication, and split review-runner modules.

Do not restore one of these as a compatibility shortcut. The only permitted
compatibility surface is `legacy-recovery-shim.js`, which translates historical
recovery argv at the public boundary while the migration overlay is active.

## Migration retirement gate

The migration overlay is still installed. Retirement is allowed only after a
generated generation ledger proves **both**:

1. at least 30 consecutive days with zero legacy reads; and
2. at least 30 vNext runs in that same post-cutover operating period.

Until then, docs and release output must say “sealed vNext bootstrap active;
retirement gate pending”, not claim the 17-file final shape. The overlay may be
read for historical recovery but cannot become a vNext writer or revive mutable
legacy state.
