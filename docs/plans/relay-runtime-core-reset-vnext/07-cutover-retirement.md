Parent: #1129

## Status: closed, mechanism deleted 2026-08-03

This slice built a migration overlay — a writer-generation marker, an admission
capability, an external-attestation cutover ceremony, and a 30-day/30-run
retirement gate — and that overlay has been deleted rather than exercised. What
survives is the outcome the slice was meant to reach: vNext is the only writer,
and it admits itself.

Do not treat anything below as an available operator procedure. The commands,
environment variables, and ceremony this document once described no longer
exist in the runtime; `runtime-generation.js` and `legacy-recovery-shim.js` are
recorded as deleted in
[06-delete-runtime-accretion.md](06-delete-runtime-accretion.md), and the
reasoning is in
[../../decisions/2026-08-03-migration-overlay-disposition.md](../../decisions/2026-08-03-migration-overlay-disposition.md).

## Outcome

Rewrite dispatch around the vNext core. vNext is the only runtime: dispatch
consults no generation store, and a new run is claimed by a non-recursive
`mkdir` on its run directory, which fails closed if the directory exists.

## Migration policy

There is none, by decision. The legacy manifest reader was removed in #1140, so
no installed script can read a pre-vNext run — a repository holding pre-vNext
state does not migrate, it simply starts its next run as a vNext run. Terminal
historical runs are still never rewritten, because nothing reads or writes them
at all.

The overlay was measured before removal. Every path to a dispatchable vNext
marker required an external Ed25519 attestation whose file and every parent
directory up to `/` had to be owned by a different UID and non-writable by the
operator. On a single-operator machine the only way to satisfy that is to become
root and sign to yourself, which negates the premise of an external authority.
The ceremony was not a gate anyone could pass; it was a gate that blocked
dispatch outright.

## Scope as delivered

- Dispatch is a thin orchestration path over run creation, ownership, executor
  invocation, fact append, and action derivation.
- Review and merge read the same derived lifecycle action as dispatch and
  recovery.
- Legacy manifest mutation, the old recovery implementations, the migration
  overlay, and the recovery argv shim are all deleted.

## Acceptance criteria

- [x] Dispatch, review, recovery, and merge all consume the same derived
      lifecycle action.
- [x] Old recovery implementations and mutable state transitions are deleted.
- [ ] **NOT MET.** Installed `relay-dispatch/scripts` is 16 JavaScript files and
      6,039 production LOC, excluding tests, docs, and fixtures. The 14–18 file
      target is met; the 4,000–6,000 LOC band is exceeded by 39 lines. The
      overrun is production CLI isolation (#1141) — credential staging, the
      signed two-phase cleanup lifecycle, and runtime-identity binding — not
      migration scaffolding, so no remaining deletion closes it. Left open
      rather than waived: raising the band is a separate, explicit decision.
- [x] All seven current executors remain registered and pass conformance.
- [x] The full serialized relay suite and package-content checks pass.
- [ ] Migration choice, drain, dual-read, and rollback overlay: **withdrawn**. No
      migration is offered, so there is nothing to choose, drain, or roll back
      to.

## Dependencies

- #1131
- #1132
- #1133
- #1134
- #1135

## Out of scope

- Removing executor diversity.
- Rewriting terminal historical records.
- Reintroducing a generation marker, cutover ceremony, or retirement gate.
