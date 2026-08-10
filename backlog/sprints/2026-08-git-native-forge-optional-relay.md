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
- The minimized anonymous inventory records 15 schema-v3 records: 9 terminal
  and 6 nonterminal. Drain all six nonterminal records in place; do not migrate
  or mutate them. Each remains subject to an explicit close decision if it does
  not become terminal.
- Do not regenerate the runtime inventory or deleted test-ledger machinery.

## Progress

- 2026-08-10 — Recorded the supplied aggregate inventory and drain-in-place
  decision; began #1209 as a documentation and deterministic-regression-test
  contract freeze with production JavaScript and schemas out of scope.
- 2026-08-10 — Opus 5 review required a bounded recursive reproduction and a
  literal schema-version plus schema-v3 terminal/nonterminal inventory. The
  minimized output preserves the drain/close decision for all six nonterminal
  records and leaves production JavaScript and schemas out of scope.
