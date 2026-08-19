# 2026-08-03 — Migration overlay disposition: delete the overlay

Status: accepted (2026-08-03).

## Decision

Delete the migration overlay: the writer-generation store, the admission
capability, the external-attestation cutover, the retirement gate, and the
legacy recovery argv shim. A run directory is claimed by a non-recursive
`mkdir`, which fails closed if the directory already exists.

## Why

Every path to a dispatchable marker required an external Ed25519 attestation
whose file and every parent directory had to be owned by a different UID. On a
single-operator machine that is only satisfiable by becoming root and signing
to yourself. The overlay blocked dispatch instead of migrating it.

Do not replace the overlay with a cheaper gate. An earlier same-day change
that tried that was reverted in full.

## Consequences

There is no migration. Retired run artifacts are unreadable. A repository
holding pre-vNext state starts its next work as a Relay run. The claim
happens after worktree creation so a crash during `git worktree add` does not
strand an empty run directory.

Current contract: [architecture.md](../../references/architecture.md).
