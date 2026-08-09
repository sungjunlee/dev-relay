# relay-fleet design

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

For each leaf, relay-fleet scans Relay child records. The `run.json` fleet
parent and ownership digest are authoritative; legacy manifests are never
read. A candidate must also match issue number, branch, and Done Criteria hash.
Exactly one candidate is a child; zero is
`retry_pending`; more than one is an error. A parent child that matches no leaf
is an orphan requiring operator attention.

No fleet state, child dispatch state, error cache, process cache, replacement
journal, ticket, or state-transition record exists. This makes status a pure
read and prevents a second mutable lifecycle from drifting away from the run.

## Dispatch and merge

The CLI starts a new dispatch only when the view has no child record, and
resumes an existing run only for the exact canonical `redispatch` action. A
pre-record failure therefore remains receipt-only and is safely retried on the
next invocation. Waiting, review, merge, corrupt, ambiguous, or blocked runs
are never dispatched.

`--review` invokes review-runner only for exact `review` actions and invokes
finalize-run serially only for exact `merge` actions. It does not write fleet
state. All seven dispatch adapters remain normal child executors.
