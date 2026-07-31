Parent: #1129

## Outcome

Delete policy and observability surfaces that do not protect a core lifecycle invariant, so the runtime has one explicit path.

## Remove

- Routing presets, catalog layers, and multi-scope precedence.
- Advisory/assurance policy machinery.
- Runtime analytics aggregation; preserve raw event facts for offline analysis.
- Central CLI schema indirection where direct command parsing is clearer.
- Mutable PR-liveness caches.
- Duplicate recovery entry points after shims expire.

## Preserve

- Explicit executor/model selection.
- Raw durable facts and auditability.
- Executor capability negotiation.
- The core safety invariants and migration compatibility needed by active runs.

## Acceptance criteria

- [ ] Each removed surface is mapped to deleted production files, tests, docs, and import edges.
- [ ] Moving code elsewhere in the installed skill bundle does not count as deletion.
- [ ] Core dispatch/review/recovery behavior has one configuration precedence path.
- [ ] Runtime analytics commands are removed or converted to offline readers that are not installed with the runtime.
- [ ] #783 and #868 are closed as superseded if routing is deleted, or narrowed to adapter registration only.
- [ ] #1117 is closed as superseded when reviewer-budget/swap state disappears.
- [ ] Full invariant tests pass after each deletion slice.

## Verification

- Import inventory reports no surviving references to removed modules or flags.
- Package-content check proves deleted runtime files are not installed.
- Before/after file and LOC report excludes tests, docs, fixtures, and migration-only shims.

## Rollback

Revert the individual deletion slice; do not restore multiple policy paths through compatibility branches.

## Dependencies

- #1130
