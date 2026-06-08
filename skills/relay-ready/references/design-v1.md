# Relay Intake Design v1

Updated one-pager: readiness is a three-dimension preflight gate. Score only task-description properties: `clarity`, `granularity`, `verifiability`, each `high|medium|low`; low/unclear drives bounded Q&A before relay dispatch. It does not score runtime world state.

## Decision 1 - Rubric reduction

Decision: reduce 5-D to 3-D. Keep `clarity`, `granularity`, `verifiability`; remove `risk` and `dependency`. Rationale: `risk`/`dependency` are world properties, so mixing them with request text quality obscures what the user must clarify. `risk` moves to dispatch-time `extractRubricSize` regex/rubric-size handling; `dependency` moves to the relay-dispatch in-flight check from #408. `/relay` probe #437 consumes the 3-D gate.

## Decision 2 - Schema migration

Decision: B - coexist with new `readiness_score` field: keep legacy `readiness.*` enums and add `readiness_score.{clarity,granularity,verifiability}` as H/M/L. Rationale: this avoids the current `readiness.granularity` enum collision (`single_task|multi_task|unclear`) without rewriting history. #435, #436, and #437 consume `readiness_score` first; legacy `readiness` remains display/compatibility data until cutover.

## Decision 3 - Default extractor

Decision: A - regex+heuristic. Rationale: #437 needs a sub-200ms deterministic probe, and #435/#436 need repeatable scoring/defaults. Heuristics may be dumb, so they fail open: if no confident default exists, ask the Q&A question without a recommended answer rather than spending an LLM call or laundering guesswork.

## Task-shape signals

`score-readiness.js` and `probe-readiness.js` may emit additive `task_shape` metadata for obvious oversized request shapes: many criteria groups, sprint/epic/milestone/foundation language, many subsystem references, multi-stage user journeys, or broad product-foundation mixtures. These are deterministic soft signals for routing into relay-ready/planner shaping. They do not create leaf handoffs, infer semantic task boundaries, or replace AI judgment about decomposition.

Strong task-shape signals prevent direct readiness bypass, but they are not a blanket ban on XL work. Operators should treat them as evidence that relay-ready needs to shape the request before dispatch.

## Schema migration plan

Steps:
1. In `relay-request.js`, add optional `readiness_score` validation for only `clarity`, `granularity`, `verifiability` with `high|medium|low`.
2. Preserve existing `readiness.*` validation and writes; new v2 writers write `readiness_score`, not new 3-D meanings into old fields.
3. In #435 `score-readiness.js`, #436 Q&A, and #437 `/relay` probe, read `readiness_score` first and treat absent scores as legacy/unscored.
4. After one release and 20 successful v2 runs, remove legacy reader dependence if no stale-skill incidents appear.

Risks: dual shapes can confuse readers; mitigation is one precedence rule: `readiness_score` wins. Stale installed skills may keep writing `readiness`; mitigation is preserve validation and warn during #434 shim.

Grandfather handling: do not mutate the 22 existing request artifacts. They remain v1-grandfathered with `readiness.*`; on next touch, consumers treat them as unscored and may rescore into `readiness_score`. Cutover starts only after the 20-run trigger above.

## Call graph — /relay ↔ relay-ready

### Diagram + state transitions

```text
User -> /relay-ready -> /relay                  [explicit two-step default]
User -> /relay
  -> probing: regex only, no LLM/Q&A; read `readiness_score` per D2
     --probe-pass / readiness_probe--> proceeding
     --probe-fail / readiness_probe--> chain_offered
chain_offered asks once:
  "Readiness gaps detected: <summary>. Invoke relay-ready first? [y/n/abort]"
     --chain-y / readiness_chain_started--> chained
chained -> relay-ready interactive Q&A
     --readiness_chain_completed--> proceeding
chain_offered --chain-n / readiness_chain_declined--> proceeding
chain_offered --chain-abort / readiness_aborted--> aborted
```

`chain_offered` is the only state where `/relay` directly asks the user anything. Consumer for new run events: #437 `/relay` routing/resume; `reliability-report` may aggregate declines.

### Non-interactive mode

Non-interactive means explicit `--non-interactive` or non-TTY; the flag has precedence. Probe pass proceeds. Probe fail skips `chain_offered` and closes `aborted` with reason `readiness_check_failed`; `readiness_aborted` payload is `{mode:"non_interactive",reason:"readiness_check_failed",score,gaps}`.

### Warning-fatigue handling

Repeated `n` does not change UX. Every decline logs `readiness_chain_declined` with `{score,gaps,decision:"n",repeat_count}` and `/relay` proceeds. No stronger prompt, cooldown, or block.

### Decision 1 — Non-interactive detection

Decision: use both explicit `--non-interactive` and TTY checks; the flag wins, otherwise `!process.stdin.isTTY || !process.stdout.isTTY` is non-interactive.
Rationale: CI/batch callers can be explicit, while piped automation remains safe by default.

### Decision 2 — Chain-prompt prompt source

Decision: `skills/relay/SKILL.md` is canonical; implementation copies the literal template into a const and pins it with tests.
Rationale: operators read skill docs first, and #437 still needs a runtime string without parsing markdown.

### Decision 3 — Probe latency budget

Decision: p95 <= 200ms for the probe on real issue bodies.
Rationale: this keeps the only new synchronous `/relay` gate cheap; pure regex/no subprocess/no LLM makes the cap realistic.
