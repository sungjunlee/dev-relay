# Exceptional Review Policy Extension

`extend-review-policy.js` is the only supported operator path for raising an existing run's
persisted `review.max_rounds`. It is deliberately narrow: the command can only increase that
one policy field, refresh `timestamps.updated_at`, and append one dedicated `policy_updated`
audit event. It cannot decrease the cap, edit lifecycle state, bypass escalation, or change
review convergence rules.

## Policy boundary

An increased cap is an operator judgment that another independent review round is worth the
cost. It is **not evidence of convergence**. A longer review budget does not erase prior
findings, satisfy Done Criteria, or justify a merge. Repeated-issue, flip-flop, escalation,
publication, and explicit-merge gates continue to apply. Automatic cap extension is forbidden.

The manifest lock used by `withManifestTransaction` is the trust root. Guard values printed by
a dry run are only a preview; the mutating call re-reads the manifest and enforces state, round,
HEAD, terminal-state, event-sink, and monotonicity checks while that lock is held. A warning
printed outside the lock would not be an enforcement mechanism.

## Operator flow

First derive a coherent guard snapshot without changing the manifest or event journal:

```bash
node skills/relay-dispatch/scripts/extend-review-policy.js \
  --repo . --run-id <run-id> --max-rounds 8 \
  --reason "Corrective redispatch needs one additional independent review" \
  --dry-run --json
```

Then copy the returned `guards.expected_state`, `guards.expected_round`, and
`guards.expected_head` values into the mutating call:

```bash
node skills/relay-dispatch/scripts/extend-review-policy.js \
  --repo . --run-id <run-id> --max-rounds 8 \
  --reason "Corrective redispatch needs one additional independent review" \
  --expected-state changes_requested --expected-round 7 \
  --expected-head <sha> --json
```

If the run moves between those calls, the stale guards are refused. Terminal or unknown states,
a missing manifest HEAD, a non-positive or non-integer persisted cap, a missing/unwritable
`events.jsonl`, lock contention, and write failures also fail closed. Successful events record
the locked snapshot's `state`, `round`, `head_sha`, `old_max_rounds`, and `new_max_rounds`, plus
the operator reason, actor, origin, and timestamp; they never reuse `state_recovery`.
