# relay-fleet vNext design

## Contract

A fleet is an immutable cohort, not a lifecycle runtime. Its sole durable
artifact is `~/.relay/fleets/<repo-slug>/<fleet-id>.leaves.json` with canonical
bytes:

```json
{ "fleet_id": "fleet-481", "leaves": ["normalized leaf contracts"] }
```

Creation uses exclusive write. A byte-identical re-entry is idempotent; a
different cohort for the same id fails closed. Cohorts require unique issue
number, leaf reference, and branch, one normalized ownership binding, and
frozen prompt/rubric/Done Criteria files.

## Derived view

For each leaf, relay-fleet scans child records. A vNext `run.json` parent and
ownership digest are authoritative. Before legacy cutover, a legacy manifest
with `fleet_id` is a read-only fallback. A candidate must also match branch and
the Done Criteria hash. Exactly one candidate is a child; zero is
`retry_pending`; more than one is an error. A parent child that matches no leaf
is an orphan requiring operator attention.

No fleet state, child dispatch state, error cache, process cache, replacement
journal, ticket, or state-transition record exists. This makes status a pure
read and prevents a second mutable lifecycle from drifting away from the run.

## Dispatch and merge

The CLI only spawns leaves whose derived view has no child record. A
pre-manifest failure therefore remains receipt-only and is safely retried on
the next invocation. `dispatch.js` owns a small exclusive per-issue admission
lock; it permits only same-host provably-dead-holder reclamation and otherwise
fails closed.

`--review` may invoke each child's ordinary review and finalization command,
but does not write fleet state. Finalization is serial and child-owned. All
seven dispatch adapters remain normal child executors.
