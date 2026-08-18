Parent: #1129

## Outcome

Create the executable safety boundary for the relay runtime reset before production behavior changes.

## Scope

- Inventory every reader, writer, importer, and CLI entry point touching relay manifests, events, executor descriptors, dispatch, review, recovery, and merge.
- Translate the vNext invariants in the parent spec into black-box contract tests.
- Classify every current relay test as:
  1. invariant to preserve,
  2. compatibility/migration coverage,
  3. implementation-detail coverage to delete,
  4. obsolete product-surface coverage to delete.
- Record baseline runtime file count, production LOC, test LOC, dispatch/recovery latency, and flaky-test rate.

## Acceptance criteria

- [ ] A machine-readable cross-skill reader/writer/import inventory is committed and checked in CI.
- [ ] Contract tests cover immutable run identity, frozen Done Criteria, exclusive mutation, append-only attempts, exact SHA + criteria review, explicit merge, durable merge provenance, idempotent recovery, terminal irreversibility, and live external-fact revalidation.
- [ ] Every existing relay test is present exactly once in the deletion ledger with an owner and disposition.
- [ ] Baseline measurements are reproducible with one documented command.
- [ ] This issue changes no production lifecycle behavior.

## Verification

- Run the full serialized relay test suite.
- Run inventory and ledger consistency checks twice and confirm byte-identical output.
- Confirm that intentionally adding an unclassified test or unknown runtime import fails CI.

## Out of scope

- New event storage.
- Executor migration.
- Production deletion.

## Dependencies

None. This is the foundation issue for the remaining workstreams.
