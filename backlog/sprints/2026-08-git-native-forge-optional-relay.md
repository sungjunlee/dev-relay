---
milestone: Git-native, forge-optional Relay
status: completed
started: 2026-08-10
completed: 2026-08-12
component: "run-lifecycle"
---

# Git-native, Forge-optional Relay

## Goal

A Git repository with no origin can be isolated, verified, independently
reviewed, and closed as a terminal Reviewed Result without invoking a forge,
while the existing GitHub path retains its exact-SHA and recovery guarantees.

## Plan

### Batch 1 — ReviewSubject contract

- [x] #1209 — Freeze GitHub lifecycle parity and specify the exact Git ReviewSubject → PR #1213 (merged).

### Batch 2 — Git-native identity

- [x] #1207 — Let no-origin Git runs inspect and recover without forge blockers (PR #1223).

### Batch 3 — Forge-optional boundary

- [x] #1208 — Review exact local Git changes and close terminal reviewed results → PR #1224 (merged).

### Batch 4 — Lifecycle evidence

- [x] #1205 — Make the public Relay workflow Git-required and forge-optional → PR #1226 (merged).

### Batch 5 — Landing and observation

- [x] #1206 — Verify and close the Git-native forge-optional Relay milestone
  ([closure evidence](../../docs/git-native-forge-optional-closure.md), completed by this closure PR).

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
- 2026-08-11 — #1209 merged in PR #1213. Began #1207 in run
  `issue-1207-20260811062805756-b698a5ae`; production observer/fold/recovery
  changes now pass the focused local-delivery, production recovery, GitHub
  parity, and skills-lint suites; the full serialized gate remains pending.
- 2026-08-11 — #1207 completed in PR #1223. Began #1208 in run
  `issue-1208-20260811141912577-b5562f0b`; local review now shares the exact
  Git review fold and uses canonical recovery for the terminal Reviewed Result.
- 2026-08-12 — #1208 and #1205 merged in PRs #1224 and #1226. #1206 then
  closed the program with one uninterrupted no-origin journey, five real
  child-process crash cuts, and the final serialized gate: 634 tests, 632 pass,
  0 fail, and the two existing credential-gated skips. Runtime remained 16
  files; milestone implementation added 540 LOC and no new framework, schema,
  fact type, or lifecycle writer.
