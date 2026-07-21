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
message in a caller summary is authority. Durable evidence is also bound to the
receipt mapping identity: the manifest `run_id`/`fleet_id` must match the
receipt-mapped run/fleet (when present) and the manifest `pr_number`/`issue_number`
must match the injected PR/issue records before the outcome counts as
`complete_with_evidence`. An absent manifest `head_sha` is optional; only two present,
disagreeing SHAs are stale. Any mismatch fails closed with a named `PROOF_STALE_EVIDENCE`
reason, and `stopped_on` is the STOP_PRIORITY-most-severe token across all failures.

`orcaSnapshot` must carry structured status, task-list, and gate-list reads. Their
runtime IDs must all be present, non-empty, and identical. The verifier checks only
the exact receipt-mapped task IDs and integration-task gates; unrelated live rows are
left for the admission-filter leaf.

The successful result returns `program_id`, `runtime_id`, sorted `outcome_ids`,
sorted `orca_task_ids`, and sorted `integration_gate_ids`. It also returns the
recomputed four-field final-summary truth used by the later admission leaf. Existing
receipt, gates-report, final-summary, and gate-entry serializers are not modified.
