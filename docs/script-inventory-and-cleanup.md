# Relay Runtime Inventory

This is the current Relay runtime inventory, not a history of the legacy manifest
runtime. Historical cleanup rationale remains under [`docs/archive/`](archive/).

## Installed dispatch package

Relay production installs the JavaScript files currently present under
`skills/relay-dispatch/scripts/`.

| Group | Files | Purpose |
| --- | ---: | --- |
| Core | 8 | `dispatch`, `inspect`, `recover`, `run-store`, `facts`, `host`, `exec`, and `adapter-contract`. |
| Universal adapters | 8 | Registry and the seven retained native executor descriptors. |

That is the whole installed runtime: the core plus all seven executors. There
is no migration overlay and no pending retirement, so there is no second figure
to reconcile against.

There is no generated inventory or test-site ledger. Filesystem-to-CI coverage,
test layout, exact runners, and execution flags are checked directly by
`tests/skills-lint/scripts/ci-relay-matrix.test.js`. Installed skill scripts
remain protected independently by `script-reachability.test.js`, which rejects
orphan scripts rather than reproducing a second inventory.

## Relay runtime ownership

| Surface | Single owner |
| --- | --- |
| Immutable run identity and regular-file checks | `run-store.js` |
| Append-only fact validation and merge authorization | `facts.js` |
| Derived lifecycle action | `inspect.js` |
| Git/GitHub observation and idempotent recovery/close | `recover.js` via `relay-recover.js` |
| Host lock, supervisor, cancellation, runtime binding, process-scope cleanup | `host.js` |
| Executor argv/capability/output contract | `adapter-contract.js` and `adapters/` |

`dispatch.js` only starts an attempt. `review-runner.js` only records a bound
review. `finalize-run.js` only performs an explicit exact-SHA merge. None owns a
second lifecycle state or app-registration protocol.

## Removed runtime accretion

The following categories have been removed from the installed runtime and their
tests deleted or replaced with current Relay coverage: mutable manifest slices and
facades, relay event helpers, resolver/observer folds, execution-evidence
sidecars, publish/rebrand/reconcile/recover command family, worktree create and
cleanup utilities, app registration, executor transport duplicates, live
dogfood commands, CLI parser duplication, and split review-runner modules.

Do not restore one of these as a compatibility shortcut. There is no permitted
compatibility surface: the writer-generation admission store and the legacy
recovery argv shim were deleted with the rest, and `relay-recover` exposes only
`inspect` and `recover`.

## No migration path

The Relay runtime is the only writer. Nothing admits a run, records a writer generation, or
translates retired argv, and the legacy manifest reader went with the runtime
reset — so a legacy run is not readable by any installed script and cannot be
migrated. A repository holding legacy state simply starts its next Relay run.

Do not reintroduce a generation marker, a cutover ceremony, or a retirement
gate to soften that. The mechanism was measured before it was removed: every
path to a dispatchable marker required an external Ed25519 attestation whose
file and every parent directory had to be owned by a different UID and
non-writable by the operator, which on a single-operator machine can only be
satisfied by becoming root and signing to yourself.
