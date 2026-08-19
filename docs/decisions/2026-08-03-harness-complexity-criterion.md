# 2026-08-03 — When this harness stops being worth it

Status: accepted (2026-08-03)

A block of this harness earns its place if it supplies a property a stronger
model cannot supply from inside a single process. Anything whose job is to
compensate for model weakness has a shrinking half-life; anything whose job is
to survive the world outside the model does not.

Properties that do not get cheaper as models improve: durability across
process death, independence of review, containment, and concurrency.

Properties that do get cheaper, and should be measured rather than assumed:
prompt scaffolding, rubric synthesis, readiness scoring, multi-round review
loops, and recovery machinery justified only by executor failure rates.

## Three questions for any block

1. **Does it survive process death?** If its value exists only inside one live
   session, a stronger model with more context replaces it.
2. **Does it bind two independent parties?** If a single model could produce
   the same guarantee by being asked nicely, it is instruction, not a gate.
3. **Was it built by an incident or by an anticipation?** Prefer running the
   mechanism and watching it refuse over inferring that nothing needs it.
   "Nothing ever demonstrates it was needed" and "nothing has needed it *yet*"
   read identically from inside the code.

## Stopping condition

Unjustified complexity is the variable, not size. Watch the share of runs
where recovery does real work. [architecture.md](../../references/architecture.md)
records the 2026-08-15 reading that recovery is also the routine
publication/verification conveyor (96% of `recovery_applied` events), with
crash convergence a measured small subset.

Do not quote the 2026-08-03 `tests/ledger` accounting ratio; that ledger no
longer exists.
