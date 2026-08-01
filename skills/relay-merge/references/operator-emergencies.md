# Operator recovery

vNext merge has no `--skip-review`, `--force-finalize-nonready`, manifest-state
override, or bootstrap artifact exemption. Missing or stale evidence changes the
derived action; it does not create an emergency merge path.

Inspect the run first:

```bash
node skills/relay/scripts/relay-recover.js inspect --repo . --run-id "$RUN_ID" --json
```

- `review`: run `relay-review` against the current head.
- `recover`: run canonical recover with the returned action key and a reason.
- `redispatch`: make the requested changes through dispatch.
- `operator_attention`: repair the reported external or durable identity issue;
  do not merge around it.

If `finalize-run` was interrupted after GitHub accepted the merge, rerun the
same finalize command with the same merge method. Its durable authorization is
resumed, GitHub is re-read, and exactly one merge fact is retained.

If GitHub accepted a merge-queue request, finalize returns `merge_pending`.
Rerun the same command; it will not request the merge twice. Cleanup is deferred
until GitHub reports the PR as merged and the terminal receipt is present.

Finalize fsyncs a request intent immediately before calling GitHub. A crash
after that boundary is never retried automatically unless a fresh observation
proves the exact PR is already merged or queued. An open, unqueued PR with an
intent is an ambiguous outcome and requires canonical recovery/operator
attention; deleting the intent to force a retry is unsupported.

If the merge command itself returned an error but a fresh read already reports
the PR as merged, finalize writes an immutable ambiguity marker and refuses to
attribute the requested actor or method. Use canonical `recover` so the event is
recorded as an external reconciliation. Do not delete the ambiguity marker.

A retry also re-verifies the HMAC authorization, terminal fact, receipt, and
fresh GitHub target. Missing receipts after a fact-append crash are repaired;
conflicting, tampered, symlink, or non-regular artifacts fail closed.

An externally merged PR without a `finalize-run` authorization is reconciled by
canonical `recover`, not by finalize:

```bash
node skills/relay/scripts/relay-recover.js recover --repo . --run-id "$RUN_ID" \
  --expected-action-key "$ACTION_KEY" --reason "reconcile operator-confirmed external merge" --json
```

The legacy-manifest bootstrap artifact utility was removed. vNext recovery
derives and records reconciliation through this single canonical command.
