# Issue #190 — Grandfathering Retirement

## Summary

`anchor.rubric_grandfathered` is retired from relay runtime. The authenticated `#151` migration gate is now historical only: dispatch, review, and merge refuse any retained manifest that still carries the field in a non-`undefined` shape.

## Pre-landing inventory

Verbatim orchestrator-host check:

```bash
grep -l "rubric_grandfathered" ~/.relay/runs/*/*.md
```

Observed result before dispatch: `0` matches.

Safety rationale: no live orchestrator-host manifests depended on grandfathering, so removing runtime acceptance does not strand active local runs. Foreign hosts must repair or close stale manifests before using the post-`#190` runtime.

## Trust-model audit

- Q1 (forge): `#151` authenticated object-form provenance against `~/.relay/migrations/rubric-mandatory.yaml`. `#190` removes the forge surface entirely by rejecting every non-`undefined` value at `anchor.rubric_grandfathered`.
- Q2 (gate): the same three gates now fail closed on the retired field: dispatch pre-flight in `skills/relay-dispatch/scripts/dispatch.js`, review context load via `skills/relay-review/scripts/review-runner/context.js`, and merge readiness in `skills/relay-merge/scripts/review-gate.js`.
- Q3 (external verifier): `~/.relay/migrations/rubric-mandatory.yaml` remains as operator-owned history, not a live trust root. The pre-landing inventory above is the external evidence that the orchestrator host no longer carries retained grandfathered manifests.

## Path Decision

Path A: retire the migration CLI entirely. Once runtime rejects every retained `anchor.rubric_grandfathered` shape, there is no supported stamping flow left to preserve. Keeping a purge CLI would add operator surface area for a field that no longer has runtime meaning, so recovery is documented as manual manifest repair or `close-run.js`.

## Runtime Delta

| File | Added | Removed | Net | Change |
|---|---|---|---|---|
| `skills/relay-dispatch/scripts/dispatch.js` | 17 | 19 | -2 | Removed grandfather output plumbing and enforced the fail-closed pre-flight guard. |
| `skills/relay-dispatch/scripts/manifest/rubric.js` | 27 | 275 | -248 | Replaced provenance validation with `rejectLegacyGrandfatherField()` and simplified missing-path messaging. |
| `skills/relay-dispatch/scripts/worktree-runtime.js` | 0 | 4 | -4 | Removed `rubricGrandfathered` from dry-run rendering. |
| `skills/relay-review/scripts/review-runner/context.js` | 1 | 11 | -10 | Removed the grandfather bypass from rubric loading. |
| `skills/relay-review/scripts/review-runner/redispatch.js` | 1 | 1 | 0 | Dropped the grandfather pass-through state. |
| `skills/relay-merge/scripts/review-gate.js` | 14 | 27 | -13 | Removed grandfather-aware merge readiness and skip-audit formatting. |
| `skills/relay-merge/scripts/gate-check.js` | 5 | 5 | 0 | Removed grandfather references and surfaced the unsupported-field merge block. |
| `skills/relay-dispatch/scripts/manifest/lifecycle.js` | 1 | 2 | -1 | Scope drift: operator guidance string updated to remove the deleted CLI reference. |

## Stress-Test Matrix

| Gate | undefined | false | true | well-formed object |
|---|---|---|---|---|
| dispatch pre-flight | ADVANCE | REFUSE | REFUSE | REFUSE |
| review-runner context | ADVANCE | REFUSE | REFUSE | REFUSE |
| review-gate merge | ADVANCE | REFUSE | REFUSE | REFUSE |

## Per-Suite Test Delta

| Suite | Before | After | Delta |
|---|---|---|---|
| relay-dispatch | 298 | 296 | -2 |
| relay-review | 166 | 166 | 0 |
| relay-merge | 84 | 84 | 0 |

Post-change verification:

```bash
node --test skills/relay-dispatch/scripts/*.test.js
node --test skills/relay-review/scripts/*.test.js
node --test skills/relay-merge/scripts/*.test.js
```

Observed totals after the final tree:

- relay-dispatch: `296 pass / 0 fail`
- relay-review: `166 pass / 0 fail`
- relay-merge: `84 pass / 0 fail`

## Adjacent Behavior

Everything outside the retired field stays on the existing `anchor.rubric_path` contract. Missing-path, unreadable-path, outside-run-dir, and normal persisted-rubric behavior remain unchanged; only retained `anchor.rubric_grandfathered` values now fail closed.

## Grep Proof

Runtime-only grep after the change:

```bash
find skills -path '*/scripts/*.js' ! -name '*.test.js' -print0 | \
  xargs -0 rg -n "rubric_grandfathered|rubricGrandfathered|isRubricGrandfathered|legacyGrandfather|grandfatherProvenance|warnLegacyRubricGrandfather|buildRubricGrandfatherDiagnostic|verifyRubricGrandfatherProvenance|getRubricGrandfatherMetadata"
```

Remaining non-test runtime references are limited to:

- `skills/relay-dispatch/scripts/manifest/rubric.js`: the fail-closed helper and its error string.
- `skills/relay-dispatch/scripts/dispatch.js`: the retired CLI alias help text plus recovery messaging wired to the helper.
- `skills/relay-merge/scripts/gate-check.js`: operator-facing merge-block output when the helper rejects the manifest.

No runtime branch continues to authenticate, grandfather, or accept the field.

## Operator Recovery

For foreign hosts with stale retained manifests:

1. Remove `anchor.rubric_grandfathered` from `~/.relay/runs/<repo-slug>/<run-id>.md`.
2. Persist a rubric file inside the run directory.
3. Set `anchor.rubric_path` to that in-run file.
4. Retry dispatch, review, or merge.
5. If recovery is not worth the effort, close the run with `skills/relay-dispatch/scripts/close-run.js`.
