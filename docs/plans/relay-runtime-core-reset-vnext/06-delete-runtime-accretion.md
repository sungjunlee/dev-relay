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

### #1134 deletion-slice evidence

The following production files are deleted, not relocated. The mapped tests and
documentation were either deleted with the surface or rewritten to protect the
single primary-review path.

| Deleted production file | Test/doc/import evidence |
| --- | --- |
| `relay-dispatch/scripts/adapters/generic.js` | operator-provided argv-template execution and its absolute-command identity machinery were removed; only registered native descriptors remain |
| `relay-dispatch/scripts/advisory-timing.js` | advisory timing tests and route-policy documentation removed; runtime inventory has no import edge |
| `relay-dispatch/scripts/evaluation-contract.js` | evaluation-contract tests now assert direct closed-shape validation |
| `relay-dispatch/scripts/extend-review-policy.js` | policy-extension tests now assert dispatch/review-only policy |
| `relay-dispatch/scripts/rubric-size.js` | rubric-size authoring tests removed; planner documentation uses direct rubric rules |
| `relay-dispatch/scripts/manifest/guidance.js` | guidance persistence tests removed; legacy manifest data is ignored |
| `relay-dispatch/scripts/manifest/review-assurance.js` | assurance-policy tests replaced by blocking-verdict E2E coverage |
| `relay-dispatch/scripts/manifest/review-budget.js` | round-budget assertions replaced by lifecycle-state assertions |
| `relay-dispatch/scripts/manifest/risk-assurance.js` | risk-assurance tests and references removed |
| `relay-review/scripts/advisory-review-schema.js` | secondary-review schema tests removed with the lane |
| `relay-review/scripts/advisory-worker.js` | secondary-worker orchestration tests removed with the worker |
| `relay-review/scripts/invoke-reviewer-cline.js` | Cline remains dispatch-capable; primary-review capability preflight rejects it |
| `relay-review/scripts/review-runner/confidence-downgrade.js` | low-confidence `changes_requested` E2E proves the verdict remains blocking |
| `relay-review/scripts/review-runner/reviewer-swap.js` | reviewer-swap tests and mutable swap state removed |
| `relay-review/scripts/review-runner/round-cap.js` | budget-based escalation tests replaced by one explicit blocking path |
| `relay-dispatch/scripts/agent-adapters/policy.js` | capability negotiation now uses `adapter-contract.validateCapabilities()` directly; policy-audit tests removed |
| `relay-dispatch/scripts/agent-adapters/cline-model-route.js` | Cline keeps its universal dispatch adapter while route-specific model rewriting and resolver coverage were deleted |
| `relay-dispatch/scripts/executor-model-config.js` | executor defaults/config precedence tests removed; omitted model delegates to the adapter provider default |
| `relay-dispatch/scripts/model-catalog.js` | catalog report and model-resolution tests/docs removed |
| `relay-dispatch/scripts/model-hints.js` | `--model-hints` removed; persisted legacy hints remain inert historical data |
| `relay-dispatch/scripts/model-resolver.js` | automatic aliases, live/catalog fallback, and resolution tests removed |
| `relay-dispatch/scripts/relay-policy.js` | global/project route policy and its tests/decision doc removed |
| `relay-dispatch/scripts/relay-policy-gate.js` | dispatch/review use adapter capability negotiation with no separate route authorization gate |
| `relay-dispatch/scripts/relay-routing.js` | presets, tags, run-intent files, route snapshots, and routing tests removed |
| `relay-dispatch/scripts/route-failure-hints.js` | route-specific recovery hints removed with the routes they described |
| `relay-dispatch/scripts/project-config.js` | project metadata writer/reader and its tests removed; no shipped runtime imports the deleted project configuration surface |
| `relay-dispatch/scripts/cli-schema.js` | `cli-schema.test.js`, its reader fixture, and `references/cli-schema.md` were deleted; each command now declares a closed local flag taxonomy and the runtime inventory has no import edge |
| `relay-dispatch/scripts/cli-args.js` | Every former consumer now owns its closed argv parser; command-local tests preserve unknown-flag, reserved-value, and verbatim-value behavior. The shared-parser unit test was deleted rather than relocated. |
| `relay-dispatch/scripts/dispatch-publish.js` | Static-import, dynamic-invocation, and installed-operator-doc scans found no live consumer; its stale inventory row was removed. |
| `relay-dispatch/scripts/manifest/inflight-runs.js` | No live import or invocation remained; its dedicated implementation test and obsolete semantic inventory seed were removed. |
| `relay-dispatch/scripts/manifest/pr-number-stamp.js` | No live import or invocation remained; the obsolete inventory edge was removed without moving the helper. |
| `relay-dispatch/scripts/wait-for-check.js` | No live import or operator command remained; its implementation test was removed with the script. |
| `relay-dispatch/scripts/relay-config.js` | This was an unreachable duplicate of the public `skills/relay-config/scripts/relay-config.js`; only the public operator path remains. |
| `relay-dispatch/scripts/reliability-report.js` | `reliability-report.test.js` and the installed reliability-report operator guidance were deleted; raw facts remain available for offline analysis without a shipped aggregation command |
| `relay-plan/scripts/rubric-validation.js` | dead ready-light runtime validator and its test were deleted; rubric authoring remains a human-readable planning checklist |
| `relay-plan/scripts/earned-rubric.js` | unreachable runtime rubric synthesis and its unit test were deleted; Done Criteria and rubric reference contracts retain RR-02 coverage |
| `relay-plan/scripts/observation-context.js` | unreachable observation synthesis and its unit test were deleted; planner prompt emission remains the public contract |
| `relay-dispatch/scripts/reliability/calibration.js` | runtime calibration and its calibration tests were deleted; durable facts remain the offline input |
| `relay-dispatch/scripts/reliability/legacy-mechanisms.js` | legacy-mechanism analytics and reference tests were deleted rather than moved into another installed skill |
| `relay-dispatch/scripts/reliability/task-class.js` | runtime task classification and calibration consumers were deleted with the aggregation surface |
| `relay-dispatch/scripts/manifest/fleet.js` | mutable fleet manifest/state/cache behavior and its manifest/fleet tests were deleted; fleet derives from an immutable cohort and child facts |
| `relay-dispatch/scripts/reconcile-advisory.js` | advisory reconciliation and advisory-lane lifecycle tests were deleted; primary lifecycle reconciliation remains |
| `relay-fleet/scripts/merge-queue.js` | persisted merge-queue state and queue tests were deleted; the fleet command performs a serial merge directly from derived child state |
| `relay-review/scripts/review-runner/advisory-gates.js` | advisory gate and score-authority coverage were deleted in favor of the primary verdict gate |
| `relay-review/scripts/review-runner/advisory-lane-reap.js` | secondary-lane lease/reap code, tests, and merge-time reap fixture were deleted |
| `relay-review/scripts/review-runner/advisory-orchestration.js` | advisory orchestration and its orchestration tests were deleted; only primary reviewer invocation remains |
| `relay-review/scripts/review-runner/advisory-prompt.js` | secondary prompt construction and advisory runner tests were deleted |
| `relay-review/scripts/review-runner/advisory.js` | advisory lane entry point and runner-advisory tests were deleted |
| `relay-review/scripts/review-runner/assurance.js` | assurance mutation and score-authority tests were deleted; blocking verdict semantics remain direct |
| `relay-review/scripts/review-runner/evaluation-channels.js` | multi-channel evaluation/lane state and lane-field tests were deleted; the primary Done Criteria verdict is authoritative |
| `relay-dispatch/scripts/runtime-generation.js` | writer-generation marker, admission capability, and the external-attestation cutover were removed; dispatch no longer consults a generation store and the run directory is claimed by an atomic mkdir |
| `relay-dispatch/scripts/legacy-recovery-shim.js` | translated retired recovery argv into a runtime that cannot read legacy manifests; `relay-recover` exposes only `inspect` and `recover` |
| `relay-fleet/scripts/sprint-state.js` | byte-identical duplicate of `relay-merge/scripts/sprint-state.js`; relay-fleet ownership validation now imports the relay-merge module (#1148) |
| `relay-ready/scripts/probe-readiness.js` | fail-open readiness probe and its probe test were deleted; the route stage no longer shells out and returns only the in-flight dedup guard (#1156) |
| `relay-ready/scripts/score-readiness.js` | scored readiness heuristics and their unit test were deleted; the clarity, granularity, verifiability, task-shape, and risk factors are prose in `relay-ready/SKILL.md` (#1156) |

The surviving precedence is intentionally closed: a new run binds explicit
`--executor`/`--model` values (or the adapter defaults), and a resumed run uses
that immutable manifest binding. Legacy `routes`, `routing`, and `model_hints`
objects are readable for migration/audit purposes but are ignored by dispatch
and review selection.

Package-content coverage and the generated runtime inventory prove these paths
are absent from the installed skill bundle and have no surviving import or
dynamic-invocation edges. Script reachability additionally proves that retained
adapter modules are connected through a production registry rather than a test
or documentation-only edge.

`project-config.js` was deleted rather than retained as an unreferenced utility:
its `project-config.test.js` coverage and project-config inventory artifact were
deleted in the same slice, and `relay-config` now exposes only read-only
executor/model capability checks. This keeps project configuration from
reintroducing a second routing or policy precedence path.

This is a policy-surface deletion, not a vNext lifecycle-writer replacement. Legacy
persisted assurance, round-budget, lane-demotion, and secondary-review fields
are tolerated only as inert historical data; they do not authorize, downgrade,
or block a new lifecycle action. The remaining legacy lifecycle readers were
deleted outright rather than retired through a migration.

## Rollback

Revert the individual deletion slice; do not restore multiple policy paths through compatibility branches.

## Dependencies

- #1130
