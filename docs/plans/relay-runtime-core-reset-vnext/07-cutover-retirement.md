Parent: #1129

## Outcome

Cut over active relay runs safely, rewrite dispatch around the vNext core, and retire the legacy runtime after measured compatibility gates.

## Migration policy

- Use drain-and-cutover when there are at most five active legacy runs and the oldest is under 72 hours.
- Otherwise use dual-read/vNext-write.
- Never rewrite terminal historical runs.
- Remove compatibility shims only after zero active legacy runs and zero legacy reads for both 30 days and 30 vNext runs, using whichever threshold completes later.

## Operator observation surface

`runtime-generation.js` is the migration-local operator CLI; it does not add a
second runtime path. Always run its read-only preview first:

```bash
node skills/relay-dispatch/scripts/runtime-generation.js start --repo . --dry-run \
  --actor <operator-token> --operation-id <unique-token> \
  --quiescence-reason "all historical legacy writers stopped" --json
# Send quiescence_request to the external Ed25519 authority, then install the
# returned envelope and key at different-UID, Relay-non-writable paths.
export RELAY_QUIESCENCE_ATTESTATION_FILE=/authority/quiescence.json
export RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE=/authority/ed25519-public.pem
node skills/relay-dispatch/scripts/runtime-generation.js start --repo . \
  --actor <operator-token> --operation-id <unique-token> \
  --quiescence-reason "all historical legacy writers stopped" --json
node skills/relay-dispatch/scripts/runtime-generation.js checkpoint --repo . --json
node skills/relay-dispatch/scripts/runtime-generation.js status --repo . --json
```

Inventory counts are derived from the canonical configured Relay runs root;
the CLI accepts no count, age, inventory digest, or runs-root override. Missing,
orphaned, symlinked, unparsable, or concurrently changed legacy inventory fails
closed. Preview reads the same canonical bytes but creates no generation store,
event, marker, receipt, or checkpoint. Actual start requires an explicit actor,
operation identity, reason, and an external Ed25519 envelope binding them to the
exact zero inventory, repository, expiry, and target generation. Authority files
and every path component are canonical, symlink-free, different-UID-owned, and
non-writable by Relay. An active small/young inventory enters drain; a larger
or older inventory starts dual-read/vNext-write. Both reach vNext-only only
after a fresh zero-active scan and revalidation under the generation lock. The
exact canonical inventory identity and bytes are checked before the cutover
receipt and after marker publication. A failed post-marker check restores the
prior marker and appends an immutable abort; only a freshly signed operation may
supersede an older uncommitted receipt.

All current runtime writers must acquire the generation admission capability:
an already admitted legacy writer completes before cutover, later legacy
admission is rejected, and vNext admission begins only after the marker. An
unmodified historical binary cannot be retroactively forced to participate in
that protocol. Operators must quiesce those processes before cutover; the final
snapshot and subsequent sealed-inventory audits fail closed on their detectable
manifest drift rather than claiming universal process isolation.

The rollout observation ledger is repository-bound, sequence-numbered,
previous-digest chained, and paired one-for-one with immutable local seals; its
mutable head is advisory only. Checkpoints re-read
sealed legacy manifest bytes and bind both metadata and content identities.
These audit reads are distinct from product compatibility consumption; retained
legacy CLI invocations and actual compatibility reads are typed activity that
reset the zero-read interval. Terminal receipts bind the active marker, immutable
run record, and the one canonical terminal fact.

`status --json` is strictly read-only. It rejects missing or reordered events,
head mismatch, cross-repository reuse, future timestamps, date gaps, active
ambiguity, terminal receipt drift, and generation-marker drift. It reports the
local 30-day/30-terminal-run calculation independently of caller assertions.
Repository-scoped files cannot independently detect coordinated observation,
seal, and head rewind. Therefore `retire_ready` also requires an Ed25519-signed
daily lineage from a trust authority outside the repository and state directory.
Configure the canonical, relay-process-non-writable anchor and public-key files
with `RELAY_ROLLOUT_ANCHOR_FILE` and
`RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE`; missing attestation reports an
`anchor_request` and keeps the gate closed. `retire_ready` becomes true only
when every current-epoch checkpoint has one ordered authority signature, the
first links to the cutover quiescence digest, later signatures link to the prior
anchor digest, the signed issuance span is at least 30 full days, the latest checkpoint is current, the
zero-compatibility-activity checkpoint chain is at least 30 consecutive days,
at least 30 full 24-hour periods have elapsed since the vNext-only marker, and
at least 30 exact terminal vNext receipts remain independently verifiable.
A new terminal run before checkpointing reports `terminal_receipt_pending`;
deletion of an already observed receipt is corruption and fails closed.
Rollback retains and validates historical evidence, but a later cutover counts
only checkpoints and terminal receipts bound to its active marker and epoch.
During accumulation, `status` verifies the installed signed prefix and permits
exactly one unsigned latest checkpoint, returning its `anchor_request` chained
to the last verified anchor. A missing middle anchor or a longer unsigned tail
fails closed; a caught-up lineage remains pending until its signed span reaches
30 full days.

## Scope

- Implement explicit legacy-to-vNext read mapping and a runtime-generation marker.
- Rewrite dispatch as a thin orchestration path over run creation, ownership, executor invocation, fact append, and action derivation.
- Cut over review and merge readers after shadow parity and crash gates pass.
- Remove legacy manifest mutation, old recovery implementations, and migration shims at the final gate.

## Acceptance criteria

- [ ] Migration choice is computed from observed active-run count and age and is recorded as a fact.
- [ ] Active legacy runs finish without history rewriting or identity changes.
- [ ] New runs write vNext only after all prerequisite gates are green.
- [ ] A rollback overlay can return readers to legacy without deleting vNext facts.
- [ ] Dispatch, review, recovery, and merge all consume the same derived lifecycle action.
- [ ] Old recovery implementations and mutable state transitions are deleted after the retirement threshold.
- [ ] Final installed `relay-dispatch/scripts` contains 14–18 JavaScript files and 4,000–6,000 production LOC, excluding tests, docs, fixtures, and expired migration shims.
- [ ] All seven current executors pass conformance and available live canaries.
- [ ] The full serialized relay suite and package-content checks pass.

## Dependencies

- #1131
- #1132
- #1133
- #1134
- #1135

## Out of scope

- Removing executor diversity.
- Rewriting terminal historical records.
- Adding new workflow policy layers during migration.
