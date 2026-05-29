# ADR-0005: Rubric Mandatory — Grandfathering Retired

Status: Accepted (issue #190)

## Context

Issue #151 introduced an authenticated migration path (`anchor.rubric_grandfathered`) so legacy manifests without rubrics could still dispatch during rollout. After migration, retaining the bypass created a permanent trust hole: review and merge could proceed without a scored rubric anchor.

Pre-landing inventory on the orchestrator host showed zero manifests still carrying `rubric_grandfathered`.

## Decision

1. **Retire** `anchor.rubric_grandfathered` from runtime acceptance. Any non-`undefined` value fails closed.
2. **Three gates** enforce uniformly: dispatch pre-flight (`dispatch.js`), review context load (`review-runner/context.js` via `manifest/rubric.js`), merge readiness (`review-gate.js`, `gate-check.js`).
3. **Remove** the migration CLI — recovery is manual manifest repair or `close-run.js`, not re-stamping grandfather flags.
4. **`~/.relay/migrations/rubric-mandatory.yaml`** remains operator history only; it is not a live trust root.

Missing rubric paths surface explicit errors; there is no silent null or grandfather bypass.

## Consequences

- Foreign hosts with stale grandfathered manifests must repair or close runs before upgrading.
- Rubric authoring is mandatory for new dispatches; see `skills/relay-plan/` and `skills/relay-plan/references/rubric-fail-closed-patterns.md`.
- Operator recovery for `#151`-era manifests is manual manifest repair or `close-run.js`, not a supported CLI.

## Evidence

- GitHub issue `#190` (post-merge mirror retired after ADR distill)
- Fail-closed patterns: [rubric-fail-closed-patterns.md](../../skills/relay-plan/references/rubric-fail-closed-patterns.md)
