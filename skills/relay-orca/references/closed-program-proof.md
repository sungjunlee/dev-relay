# Closed-program proof

`scripts/lib/closed-program-proof.js` is the pure leaf-1 verifier for a retained
relay-orca runtime. It accepts parsed values only; callers own the read boundary.

```js
verifyClosedProgram({
  acceptedProgram,
  receipt,
  trustedGenericIntegrationEvidence,
  durableOutcomeEvidence,
  orcaSnapshot,
  // Optional in tests; the shared collision-resistant encoder is the default.
  programSegment,
});
```

`acceptedProgram` may be the raw accepted program or `{ program: acceptedProgram }`.
`trustedGenericIntegrationEvidence` is keyed by the raw `check_ref` (or is an array
of identity-bound artifacts). `durableOutcomeEvidence` is keyed by accepted
`outcome_id` (or is an array of records). Each relay-run record carries structured
`manifest`, `pr`, and `issue` facts; no `state`, `program_complete`, or diagnostic
message in a caller summary is authority.

`orcaSnapshot` must carry structured status, task-list, and gate-list reads. Their
runtime IDs must all be present, non-empty, and identical. The verifier checks only
the exact receipt-mapped task IDs and integration-task gates; unrelated live rows are
left for the admission-filter leaf.

The successful result returns `program_id`, `runtime_id`, sorted `outcome_ids`,
sorted `orca_task_ids`, and sorted `integration_gate_ids`. It also returns the
recomputed four-field final-summary truth used by the later admission leaf. Existing
receipt, gates-report, final-summary, and gate-entry serializers are not modified.
