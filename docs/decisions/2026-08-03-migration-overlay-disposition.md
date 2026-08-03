# 2026-08-03 — Migration overlay disposition: delete the overlay

Status: accepted (2026-08-03). Supersedes the "keep the retirement gate, fix the
`checkpoint` CLI, finish the rollout" disposition recorded earlier the same day.

## Question

`runtime-generation.js` (2,044 LOC) plus `runtime-generation.test.js` (1,681 LOC)
were 3,725 lines whose stated purpose was a legacy → vNext migration, gated on
"30 consecutive days with zero legacy reads **and** 30 vNext runs" — a gate that
cannot start until rollout starts, and rollout had not started.

## Decision

**Delete the overlay: the writer-generation store, the admission capability, the
external-attestation cutover, the retirement gate, and the legacy recovery argv
shim.** vNext admits itself. A new run is claimed by a non-recursive `mkdir` on
its run directory, which fails closed if the directory already exists.

Deleted with tests and fixtures: `runtime-generation.js` (2,044),
`legacy-recovery-shim.js` (169), `runtime-generation.test.js` (1,681),
`legacy-recovery-shim.test.js`, and two fixtures — about −4,300 lines. Runtime
8,262 → 6,028 LOC across 18 → 16 files.

## What decided it

An earlier disposition the same morning was to keep the gate. It was reversed by
one measurement, not by a cost argument.

**Every path to a dispatchable vNext marker required an external Ed25519
attestation.** `externallyControlledBytes` walks every path component of the
attestation file and its public key and fails on `uid === process.geteuid()`, so
the file and every parent directory up to `/` must be owned by a different UID
and be non-writable by the operator. A zero-active inventory (this repository) is
blocked immediately. A messier repository gets a `legacy` marker without ceremony
but hits the same wall once it drains.

On a one-person laptop the only way to satisfy that is to become root and sign to
yourself — the mechanism negating its own premise. It was not a gate anyone could
pass; it was a gate that blocked dispatch outright, which is exactly what
happened: refreshing the global install removed the pre-vNext runtime, and the
installed vNext dispatch then refused to start because no marker had ever been
minted.

Supporting measurements at the time: the generation store at
`.git/relay-runtime-vnext/` held **zero generation transitions, zero generation
events, and no marker** — `generation-transitions/`, `generation-events/`, and
the attestation and overlay directories were all empty; only `repository.json`
and a single `legacy_surface_invoked` rollout observation from the same morning
had ever been written. Machine-wide there were **zero vNext `run.json` files**.
The vNext runtime had never executed a run under the mechanism. That store is
now dead data inside `.git/`; nothing reads it.

## What was NOT the reason — do not reuse these

An earlier change tried to replace the gate with a cheaper closed-inventory scan.
Four independent reviewers refuted it and it was reverted in full. Both of its
premises were measured false, and the same shortcut will look attractive again:

- **"The gate is unreachable."** False, and it was a measurement error: a missed
  UTC day was probed by trying successively *later* dates. The gap rule is
  forward-only on date labels — it refuses to *create* a gap, never to *fill*
  one. Backfilling the missed date moved `consecutive_zero_legacy_days` 0 → 6.
  The existing test also drove the full 30-day/30-run gate green in 11.7s.
- **"The legacy inventory is a closed set."** False at the time: a pre-vNext
  relay suite installed at `~/.claude/skills/relay-dispatch` →
  `~/.agents/skills/relay-dispatch` carried the full legacy manifest runtime and
  no admission at all, writing into the same directory the gate scanned. The
  deleted `currentLegacyIdentity` was the only detector for that.

That change also failed open on `quiescence_attestation_digest`, made
`RELAY_RUNS_BASE` an unvalidated input, and retroactively narrowed
`ROLLOUT_TYPES` in a way that would have permanently bricked legacy recovery on
any store that had recorded a checkpoint (#1145 class).

**The deletion recorded here is not that change.** It removes the mechanism
outright rather than replacing its criterion with a weaker one, so no reachable
gate is left mis-measured — there is no gate.

## Consequences

- There is no migration. The legacy manifest *reader* went in #1140, so no
  installed script can read a pre-vNext run. A repository holding pre-vNext state
  does not migrate; its historical runs stay unreadable and new work starts as a
  vNext run.
- Deleting the shim stranded nothing new. It only translated argv into a runtime
  that cannot read legacy manifests (`--manifest` → unknown flag; `recover-state`
  → ENOENT). At deletion the machine held 1,136 legacy manifests across 84 repo
  slugs, 203 of them non-terminal in 20 other repositories; they were already
  unrecoverable before this change.
- The repository-wide generation lock is gone. `withGenerationAdmission` held a
  repository lock *outside* `withRunLock`, and its callback enclosed the whole of
  `startAttempt` — `createRetainedWorktree`, `acquireRunLock`, the
  `attempt_started` append, and `launchLocalSupervisor`. So it serialized every
  dispatch in a repository behind two subprocess-heavy operations. What it
  *protected* that nothing else did was narrower: `existsSync(runDir)` followed
  by `mkdirSync`, a TOCTOU. A non-recursive `mkdir` on the leaf closes that
  atomically, and unrelated runs in one repository stop being serialized.

  An earlier draft of this record described the lock as if `existsSync` →
  `mkdirSync` were all it *enclosed*. That was wrong, and the error mattered:
  it hid that moving the claim in front of `createRetainedWorktree` put
  `git worktree add` inside the window between claiming a run directory and
  writing `run.json`. A kill in that window — plain Ctrl-C is enough — strands an
  empty run directory that then rejects create (`RUN_RECORD_CONFLICT`), resume,
  `inspect`, and `recover` alike, with no GC verb to clear it. The claim now
  happens *after* the worktree, so the window is back to a few file writes and a
  crash during `git worktree add` strands nothing.

- `removeUnpublishedRun` no longer removes the shared per-repository parent
  directory. With repository-wide serialization gone, that `rmdir` raced a
  concurrent dispatch — the normal fleet path runs four at once — into a bare
  `ENOENT` on its own leaf `mkdir`. An empty parent directory is cheaper litter
  than a spurious failure.

- `removeUnpublishedRun` called an undefined `relayHome()`, so whenever
  `RELAY_RUNS_BASE` was unset — the production default — it threw a
  `ReferenceError` before doing anything, masked the real error, and leaked the
  run directory, branch, and worktree. That predates this change; it is fixed
  here because this change rewrote the block around it.
- #1145, #1149, and #1150 are all moot and all still open. #1145 targets
  `runtime-generation.js` transition receipts and `generation_switched` events,
  #1149 was "perform the first cutover", and #1150 was `--as-of` on the
  `checkpoint` verb. Every surface all three name is deleted.

## Follow-ups

1. Refresh the global install. `~/.agents/skills/relay-dispatch` (symlinked from
   `~/.claude/skills/`) is the **overlay build** — it still ships
   `runtime-generation.js` and `legacy-recovery-shim.js`, and it is the install
   that refused to dispatch because no marker had ever been minted. It is not a
   pre-vNext legacy writer, but it is stale, and nothing detects staleness any
   more: the drift audit went with the overlay. Reinstalling is now the only
   control.
