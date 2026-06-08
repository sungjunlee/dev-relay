---
name: relay-ready
argument-hint: "[task description or readiness handoff candidate]"
description: Verify a task is ready to relay — score readiness on clarity, granularity, and verifiability, then ask bounded questions when the task is too ambiguous to plan.
compatibility: Requires git and Node.js 18+.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-review"
  keywords: "relay-ready, ready to relay, readiness gate, task readiness, 릴레이 준비, 준비도, 검증, 완료 기준"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: `/tmp/relay-ready-contract.json` with request, handoff, leaf, and Done Criteria fields; generated request artifacts under `~/.relay/requests/<repo-slug>/`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-ready/scripts/persist-request.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Ready

## Use when

- `/relay` cannot safely bypass straight to planning
- The request is ambiguous, too broad, or may need multiple ordered leaves
- No stable Done Criteria or review anchor exists yet

## Do not use when

- Authoring rubrics or dispatch prompts — use `relay-plan`
- Delegating implementation work — use `relay-dispatch`
- Reviewing executor output — use `relay-review`
- Merging a reviewed PR — use `relay-merge`

## Output Contract

Persist artifacts under `~/.relay/requests/<repo-slug>/<request-id>/` (request frontmatter, raw request,
handoff(s), done-criteria snapshot(s), append-only events.jsonl). Field-by-field schema with input
requirements plus persisted request and handoff artifact definitions: see
[`scripts/request-contract.schema.json`](scripts/request-contract.schema.json). `persist-request.js`
validates the input contract on every persistence call; `$defs.RequestArtifact` and
`$defs.HandoffArtifact` document generated frontmatter for downstream consumers.

## Persistence Step

Write a JSON contract file with:
- `source.kind`
- `request_text`
- either `handoff` for single-leaf or `handoffs[]` for multi-leaf
- per leaf: `leaf_id`, `title`, `goal`, `order`
- per leaf: `done_criteria_markdown`
- optional per leaf: `depends_on`, `in_scope`, `out_of_scope`, `assumptions`, `escalation_conditions`

Persist it with:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-ready/scripts/persist-request.js" --repo . --contract-file /tmp/relay-ready-contract.json --json
```

Readiness is optional, but if supplied, all readiness dimensions are required; see schema enum domains.

## Decomposition Boundary

Readiness scripts emit deterministic signals and persist validated handoffs; they do not infer semantic leaf boundaries. When strong decomposition signals appear, use AI proposal-first shaping to decide whether the request is one high-risk leaf or multiple ordered leaves, then persist the accepted shape. Detailed operator contract and oversized product-foundation example: [`references/decomposition-contract.md`](references/decomposition-contract.md).

Preflight shaping stays append-only in `events.jsonl`. Use the portable readiness event types:
- `proposal_presented`
- `question_asked`
- `question_answered`
- `proposal_accepted`
- `proposal_edited`

Track the immediate follow-up as `next_action` on the request artifact. Do not create a second state machine for readiness.

## Downstream Handoff

After persistence succeeds:
1. use `relay-ready/<leaf-id>.md` as the source-of-truth input for `relay-plan`
2. dispatch with:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  -b <branch> \
  --prompt-file <dispatch-prompt-path> \
  --rubric-file <rubric-path-from-relay-plan> \
  --request-id <request-id> \
  --leaf-id <leaf-id> \
  --done-criteria-file <done-criteria-path>
```

3. for multi-leaf requests, dispatch leaves in `decomposition.leaf_order`, respecting `depends_on`
4. let `relay-review` read the frozen snapshot from the run manifest anchor

Do not create a second lifecycle. The readiness gate stops once the relay-ready contract is persisted.
