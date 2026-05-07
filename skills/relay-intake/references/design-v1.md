# Relay Intake Design v1

Updated one-pager: readiness is a three-dimension preflight gate. Score only task-description properties: `clarity`, `granularity`, `verifiability`, each `high|medium|low`; low/unclear drives bounded Q&A before relay dispatch. It does not score runtime world state.

## Decision 1 - Rubric reduction

Decision: reduce 5-D to 3-D. Keep `clarity`, `granularity`, `verifiability`; remove `risk` and `dependency`. Rationale: `risk`/`dependency` are world properties, so mixing them with request text quality obscures what the user must clarify. `risk` moves to dispatch-time `extractRubricSize` regex/rubric-size handling; `dependency` moves to the relay-dispatch in-flight check from #408. `/relay` probe #437 consumes the 3-D gate.

## Decision 2 - Schema migration

Decision: B - coexist with new `readiness_score` field: keep legacy `readiness.*` enums and add `readiness_score.{clarity,granularity,verifiability}` as H/M/L. Rationale: this avoids the current `readiness.granularity` enum collision (`single_task|multi_task|unclear`) without rewriting history. #435, #436, and #437 consume `readiness_score` first; legacy `readiness` remains display/compatibility data until cutover.

## Decision 3 - Default extractor

Decision: A - regex+heuristic. Rationale: #437 needs a sub-200ms deterministic probe, and #435/#436 need repeatable scoring/defaults. Heuristics may be dumb, so they fail open: if no confident default exists, ask the Q&A question without a recommended answer rather than spending an LLM call or laundering guesswork.

## Schema migration plan

Steps:
1. In `relay-request.js`, add optional `readiness_score` validation for only `clarity`, `granularity`, `verifiability` with `high|medium|low`.
2. Preserve existing `readiness.*` validation and writes; new v2 writers write `readiness_score`, not new 3-D meanings into old fields.
3. In #435 `score-readiness.js`, #436 Q&A, and #437 `/relay` probe, read `readiness_score` first and treat absent scores as legacy/unscored.
4. After one release and 20 successful v2 runs, remove legacy reader dependence if no stale-skill incidents appear.

Risks: dual shapes can confuse readers; mitigation is one precedence rule: `readiness_score` wins. Stale installed skills may keep writing `readiness`; mitigation is preserve validation and warn during #434 shim.

Grandfather handling: do not mutate the 22 existing request artifacts. They remain v1-grandfathered with `readiness.*`; on next touch, consumers treat them as unscored and may rescore into `readiness_score`. Cutover starts only after the 20-run trigger above.
