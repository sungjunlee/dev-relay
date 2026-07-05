---
id: RELAY-438
title: 'Wire single consumer: verifiability:fail → relay-plan tdd_anchor (cut other 4 wires)'
status: To Do
labels: []
priority: medium
milestone: Relay Intake / Preflight
created_date: '2026-07-05'
---
## Description
## Goal
Wire ONE downstream consumer of the readiness score to prove the contract before adding more. Cut the other 4 wires from the original 1-pager.

## Wire (the one we ship)
`verifiability: low | medium` from `relay-ready` manifest anchor → `relay-plan` adds `tdd_anchor: required` to ≥1 factor in the rubric.

## Why only this one
- 3-lens consensus (simplify + craft-critique): "prove one consumer before wiring four more"
- Memory: `feedback_consumer_first_gate` — defer schema/wiring additions without a concrete consumer
- Rule of three: don't generalize until a 3rd consumer exists

## Cut from original 1-pager (defer to follow-ups if demanded by data)
| Wire | Why cut |
|---|---|
| `risk: high → rubric size = xhigh` | Overlaps with existing `extractRubricSize` regex in relay-plan; double-source-of-truth risk (memory: `feedback_dispatch_size_regex_bug`) |
| `risk: medium+ → reasoning_effort↑` | Speculative — no incident driving this |
| `dependency: * → re-check hook` | Overlaps with #408 in-flight check shipped in dispatch.js |
| `dependency: external → wait` | Same as above |

## Implementation
- `relay-plan` reads `manifest.anchor.readiness.verifiability`
- If `low | medium`, applies per-factor `tdd_anchor: required` to ≥1 factor (reuse #142 / #145 TDD plumbing)
- Logged in rubric output for reviewer audit

## Done criteria
- `relay-plan` consumes `readiness.verifiability` field
- Test: `verifiability: low` fixture → rubric contains tdd_anchor on ≥1 factor
- Test: `verifiability: high` fixture → no tdd_anchor forced (preserves current behavior)
- ADR comment in PR: "if 2nd and 3rd consumer demand emerges, revisit the cut wires"

## Out of scope
- Other 4 consumer wires (deferred — see "Cut" table above)
- Test coverage instrumentation for unused dimensions (the wire surface is clean — no point measuring something that isn't read)

## Refs
- Epic: #431
- simplify lens § "Cut 4-of-5 downstream consumer wires; keep verifiability → tdd_anchor only"
- Memory: `feedback_consumer_first_gate`, `project_142_tdd_flavor_shipped`, `project_145_tdd_suggestion_shipped`

