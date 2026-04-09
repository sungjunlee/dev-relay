---
name: relay-intake
argument-hint: "[raw request or ambiguous task description]"
description: Shape a raw request into a single relay-ready leaf contract with a frozen Done Criteria snapshot. Use before relay-plan when the task is ambiguous, oversized, or missing a stable review anchor.
compatibility: Requires git and Node.js 18+.
metadata:
  related-skills: "relay, relay-plan, relay-dispatch, relay-review"
---

# Relay Intake

Use this skill when `/relay` cannot safely bypass straight to planning.

## When Intake Is Required

Run intake when any of these are true:
- the request is free-form or ambiguous
- the task may contain multiple steps or multiple leaves
- no stable Done Criteria anchor exists yet
- the issue/task text is too broad to review safely as-is

Bypass intake only for a single relay-ready task with a trustworthy review anchor already available.

## Output Contract

This slice supports **single-leaf only**.

Persist all of the following under `~/.relay/requests/<repo-slug>/<request-id>/`:
- request artifact: `../<request-id>.md`
- raw request: `raw-request.md`
- relay-ready handoff: `relay-ready/<leaf-id>.md`
- frozen Done Criteria: `done-criteria/<leaf-id>.md`
- append-only events: `events.jsonl`

The normalized handoff must contain:
- `request_id`
- `leaf_id`
- `title`
- `goal`
- `in_scope`
- `out_of_scope`
- `assumptions`
- `done_criteria_path`
- `escalation_conditions`

If the request decomposes into multiple leaves, stop with:
- `TODO(#129): multi-leaf relay-intake handoff is not implemented yet`

## Persistence Step

Write a JSON contract file with:
- `source.kind`
- `request_text`
- `handoff.leaf_id`
- `handoff.title`
- `handoff.goal`
- `handoff.in_scope`
- `handoff.out_of_scope`
- `handoff.assumptions`
- `handoff.done_criteria_markdown`
- `handoff.escalation_conditions`

Persist it with:

```bash
${CLAUDE_SKILL_DIR}/scripts/persist-request.js --repo . --contract-file /tmp/relay-intake-contract.json --json
```

## Downstream Handoff

After persistence succeeds:
1. use `relay-ready/<leaf-id>.md` as the source-of-truth input for `relay-plan`
2. dispatch with:

```bash
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . \
  -b <branch> \
  --prompt-file <handoff-path> \
  --request-id <request-id> \
  --leaf-id <leaf-id> \
  --done-criteria-file <done-criteria-path>
```

3. let `relay-review` read the frozen snapshot from the run manifest anchor

Do not create a second lifecycle. Intake stops once the relay-ready contract is persisted.
