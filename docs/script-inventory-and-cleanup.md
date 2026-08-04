# Relay Runtime Inventory

This is the current vNext inventory, not a history of the legacy manifest
runtime. Historical cleanup rationale remains under [`docs/archive/`](archive/).

## Installed dispatch package

vNext production currently installs **16 JavaScript files / 6,050 production
LOC** under `skills/relay-dispatch/scripts/`.

| Group | Files | LOC | Purpose |
| --- | ---: | ---: | --- |
| Core | 8 | 5,692 | `dispatch`, `inspect`, `recover`, `run-store`, `facts`, `host`, `exec`, and `adapter-contract`. |
| Universal adapters | 8 | 358 | Registry and the seven retained native executor descriptors. |

That is the whole installed runtime: the core plus all seven executors. There
is no migration overlay and no pending retirement, so there is no second figure
to reconcile against.

These counts are measurements, not goals. The installed file and LOC totals are
generated into `tests/ledger/vnext-baseline.generated.json` by the ledger
generator; the per-group rows are arithmetic on those same per-file counts.
Refresh them by regenerating, never by editing the numbers. The core is larger
than the figure published at the vNext reset because production CLI isolation
(#1141) added credential staging, the signed two-phase cleanup lifecycle, and
runtime-identity binding to `host` and `facts`.

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

Do not restore one of these as a compatibility shortcut. There is no permitted
compatibility surface: the writer-generation admission store and the legacy
recovery argv shim were deleted with the rest, and `relay-recover` exposes only
`inspect` and `recover`.

## No migration path

vNext is the only writer. Nothing admits a run, records a writer generation, or
translates retired argv, and the legacy manifest reader went with the runtime
reset — so a pre-vNext run is not readable by any installed script and cannot be
migrated. A repository holding pre-vNext state simply starts its next run as a
vNext run.

Do not reintroduce a generation marker, a cutover ceremony, or a retirement
gate to soften that. The mechanism was measured before it was removed: every
path to a dispatchable marker required an external Ed25519 attestation whose
file and every parent directory had to be owned by a different UID and
non-writable by the operator, which on a single-operator machine can only be
satisfied by becoming root and signing to yourself.
