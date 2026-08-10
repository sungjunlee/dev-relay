---
milestone: Git-native, forge-optional Relay
status: active
started: 2026-08-10
due: TBD
component: "run-lifecycle"
---

# Git-native, Forge-optional Relay

## Goal

A Git repository with no origin can be isolated, verified, independently
reviewed, and closed as a terminal Reviewed Result without invoking a forge,
while the existing GitHub path retains its exact-SHA and recovery guarantees.

## Plan

### Batch 1 — ReviewSubject contract

- [ ] #1209 — Freeze GitHub lifecycle parity and specify the exact Git ReviewSubject.

### Batch 2 — Git-native identity

- [ ] #1207 — Let no-origin Git runs inspect and recover without forge blockers.

### Batch 3 — Forge-optional boundary

- [ ] #1208 — Review exact local Git changes and close terminal reviewed results.

### Batch 4 — Lifecycle evidence

- [ ] #1205 — Make the public Relay workflow Git-required and forge-optional.

### Batch 5 — Landing and observation

- [ ] #1206 — Verify and close the Git-native forge-optional Relay milestone.

## Deferred outside this milestone

- [ ] #1210 — GitLab change-request adapter: extract a native forge seam from a concrete consumer.
- [ ] #1211 — Plain Git publication receipt for reviewed revisions.
- [ ] #1212 — Research non-Git source isolation before Relay support.

## Running Context

- Parent epic: #1204.
- Git is required for Source and ReviewSubject identity; a forge is optional to
  the architecture. GitHub remains the unchanged production route.
- ReviewSubject is derived from existing evidence and never becomes a runtime
  field, fact, registry entry, compatibility overlay, or review loop.
- Canonical recovery remains the only general lifecycle writer and owns
  Publication. Explicit `relay-merge` remains the only Landing request.
- The initial anonymous 2026-08-10 snapshot observed five active schema-v3
  runs. The bounded follow-up inventory now observes six schema-v3 nonterminal
  runs, none with an unmatched live attempt, plus two invalid versionless
  records and two non-regular `run.json` entries. Drain all six in place; do not
  migrate or mutate them.
- Do not regenerate the runtime inventory or deleted test-ledger machinery.

## Progress

- 2026-08-10 — Recorded the supplied aggregate inventory and drain-in-place
  decision; began #1209 as a documentation and deterministic-regression-test
  contract freeze with production JavaScript and schemas out of scope.
- 2026-08-10 — Opus 5 review found the first inventory undercounted historical
  layouts and equated active attempts with nonterminal runs. Replaced it with a
  bounded recursive aggregate inventory and restored the full Milestone 17
  execution order.
