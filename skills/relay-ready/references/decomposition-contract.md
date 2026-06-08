# Relay-Ready Decomposition Contract

This contract defines the boundary between deterministic readiness scripts, AI relay-ready shaping, and downstream planning for oversized or semantically ambiguous requests.

## Boundary

- Scripts emit deterministic signals and persist validated artifacts.
- Scripts must not infer semantic leaf boundaries.
- AI relay-ready shaping decides whether the request is one high-risk leaf or multiple leaves.
- `relay-plan` consumes the persisted `relay-ready/<leaf-id>.md` handoff and frozen Done Criteria for that leaf; it must not silently reinterpret the raw request after relay-ready has frozen a handoff.
- #431 remains the older readiness epic for broader readiness-gate scope. Do not duplicate that scope here.

The deterministic scripts may say "this looks multi-task" from text-shape signals such as a top-level `and`, a multi-verb opener, or bullets across modules. They may not decide that "auth setup", "billing gate", and "operator docs" are the correct leaves. That semantic boundary belongs to the AI shaping step and the operator/requester acceptance path.

## Proposal-First Shaping

When strong decomposition signals appear, relay-ready uses proposal-first shaping: first propose a bounded shape instead of persisting immediately.

1. Present whether the request should remain one high-risk leaf or split into named leaves.
2. Include short AI-authored leaf proposals with order and dependency intent.
3. Offer bounded response options: accept the proposal, keep one leaf, or edit boundaries with free text.
4. Persist only after the proposal is accepted or edited into a stable handoff contract.

Ask one bounded clarification question only when the proposed leaf boundary cannot be made reviewable from the request text. The question should choose between concrete alternatives, include a free-text escape hatch, and target the minimum ambiguity blocking a frozen Done Criteria snapshot. Do not ask an open-ended discovery interview.

## Persistence Contract

After shaping is accepted, write the existing persistence contract:

- one `handoff` for a single leaf, or ordered `handoffs[]` for multiple leaves
- per leaf: `leaf_id`, `title`, `goal`, `order`, and `done_criteria_markdown`
- optional per leaf: `depends_on`, `in_scope`, `out_of_scope`, `assumptions`, and `escalation_conditions`

The persister validates schema shape, ordering, unique leaf ids, and `depends_on` references. It records the resulting request artifact, `relay-ready/<leaf-id>.md` handoff(s), frozen `done-criteria/<leaf-id>.md` snapshot(s), and append-only events. It does not create or revise semantic decomposition.

## Planner Consumption

For each accepted leaf, `relay-plan` reads the persisted handoff and its frozen Done Criteria path. The raw request remains historical context only. If planning finds the handoff or frozen Done Criteria incomplete, it must surface that as an ambiguity or persist a planner-authored Done Criteria anchor according to the relay-plan workflow; it must not quietly recover a different task from the original raw request.

## Oversized Product-Foundation Example

Raw request:

```text
Build the initial product foundation: tenant onboarding, billing gates,
admin analytics, and operator documentation.
```

Deterministic signals:

- multi-task granularity
- cross-domain bullets or clauses
- high implementation/review risk

AI-authored proposal:

- Leaf 1: create tenant onboarding shell.
- Leaf 2: add billing gate skeleton, `depends_on: [tenant onboarding shell]`.
- Leaf 3: document product foundation operation, `depends_on: [tenant onboarding shell, billing gate skeleton]`.

If the request does not identify whether admin analytics or billing is the first production dependency, ask one bounded clarification question such as:

```text
Which foundation branch should be first?
A. Onboarding then billing, analytics later
B. Onboarding then analytics, billing later
C. Other + free text
```

Once accepted, persist those AI-authored leaves through `handoffs[]`; do not ask `score-readiness.js` or `probe-readiness.js` to split the request.
