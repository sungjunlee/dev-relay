# ADR-0006: Merge Gate Contention Policy Split

Status: Superseded. Merge readiness is inspect-derived from immutable facts
and live observations; there is no stamped manifest `pr_number`. Current
contract: [architecture.md](../../references/architecture.md).

This record describes lock-timeout policy for the removed manifest resolver.

## Context

`gate-check.js` stamps `git.pr_number` on first resolution under an exclusive lock, with event-journal dedup (#166). On lock timeout, the unified fail-safe path re-read the manifest and continued — correct for audit-trail dedup (layer B) but wrong for merge readiness: `review-gate.js` did not require a stamped `git.pr_number`, so timeout could yield `{ status: "lgtm", readyToMerge: true }` on an unstamped manifest.

Same compliance-theater pattern as visible-warning vs fail-closed gates (see [rubric-fail-closed-history.md](../archive/historical/rubric-fail-closed-history.md) rule 8).

## Decision

Split timeout/contention policy **by downstream consumer**, not only by happy-path layer:

| Consumer | Policy on lock timeout |
| --- | --- |
| Audit trail / event dedup (layer B) | Fail-safe — late duplicate events suppressed by journal dedup |
| Merge gate (unstamped, non-terminal manifest) | Fail-closed — throw, emit `manifest_resolution_failed`, exit 1 |
| Healthy contention (peer finished, PR number present) | Unchanged — proceed with stamped manifest |
| Concurrent terminalization | Fail-safe skip — do not block close/finalize on stale lock |

Happy-path layer A (lock + write) and layer B (dedup) from #166 stay intact; only the timeout fallthrough gained consumer-specific branches.

## Consequences

- Rubrics for lock/timeout paths must enumerate **every consumer** of fallthrough output (meta-rule 8 in rubric-fail-closed history).
- Merge operators may see hard failures when lock files are stale; recovery is clearing the lock and re-running gate-check — covered by end-to-end tests in #185.
- Do not re-unify timeout policy without re-auditing review-gate invariants.

## Evidence

- GitHub issues `#166`, `#185` (post-merge mirrors retired after ADR distill)
- Meta-rules: [rubric-fail-closed-history.md](../archive/historical/rubric-fail-closed-history.md) (rules 1, 7, 8)
- Resolver ledger (related fail-closed theme): [relay-resolver-audit-history.md](../archive/historical/relay-resolver-audit-history.md)
