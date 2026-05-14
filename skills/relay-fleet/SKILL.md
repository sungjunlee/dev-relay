---
name: relay-fleet
description: Fan out already-planned relay leaves into parallel child dispatches, resume crashed fleet dispatch, and print fleet status.
compatibility: Requires git, Node.js 18+, and the sibling relay-dispatch skill.
argument-hint: --fleet-id <id> --leaves-file <path>
metadata:
  related-skills: relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge
  keywords: relay-fleet, fleet, fan-out, parallel dispatch, resume, status, 병렬, 재개, 상태
---

# relay-fleet

Run Phase 1 multi-leaf orchestration after `relay-ready` and `relay-plan` have already produced leaf artifacts. This skill does not plan raw issues. It only fans out prepared leaf contracts to `relay-dispatch`, records crash-safe fleet progress, and reports aggregate status.

Design rationale, rejected alternatives, non-goals, and the Phase 2/3 roadmap: [references/design.md](references/design.md).

## Input Contract

Use a JSON file containing a non-empty `leaves[]` array. Each leaf must include:

- `leaf_ref`: stable fleet child key, usually the relay-ready `leaf_id`
- `issue_number`: GitHub issue number for fleet issue-lock admission
- `branch`: child dispatch branch
- `prompt_file`: prepared dispatch prompt
- `rubric_file`: prepared relay-plan rubric
- `done_criteria_file`: frozen Done Criteria snapshot

Optional per-leaf fields are passed through to `dispatch.js`: `request_id`, `leaf_id`, `executor`, `model`, `model_hints`, `sandbox`, `network_access`, `timeout`, `reasoning`, `copy`, `test_command`, and `register`.

## Commands

```bash
node ${CLAUDE_SKILL_DIR}/scripts/relay-fleet.js \
  --repo . \
  --fleet-id fleet-481 \
  --leaves-file /tmp/fleet-481-leaves.json \
  --parallel 4
```

Resume after a terminal/session crash:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/relay-fleet.js \
  --repo . \
  --fleet-id fleet-481 \
  --resume
```

Read-only aggregate status:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/relay-fleet.js \
  --repo . \
  --fleet-id fleet-481 \
  --status
```

Dry-run validates the leaf file and invokes child `dispatch.js --dry-run` for each leaf without writing a fleet manifest:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/relay-fleet.js \
  --repo . \
  --fleet-id fleet-481 \
  --leaves-file /tmp/fleet-481-leaves.json \
  --dry-run \
  --json
```

## Behavior

- The fleet script invokes `skills/relay-dispatch/scripts/dispatch.js` as a subprocess once per leaf and always passes `--fleet-id`.
- Each child dispatch owns worktree creation, in-flight run checks, executor invocation, and child run manifest writes.
- Fleet issue locks are checked before each child spawn; `dispatch.js --fleet-id` performs the durable lock during the actual child run.
- `--resume` reconciles both directions: it re-adopts child run manifests whose `fleet_id` points back to this fleet, and it marks no-manifest interrupted children as `dispatch_failed_pre_manifest` so they can be retried from the persisted leaf store.
- `--status` is read-only and uses the relay-dispatch fleet summary derivation rules.

## SPOF

There is intentionally no daemon. A fleet makes progress only while `relay-fleet` is actively running. If the session dies, the fleet pauses; re-run with `--resume` to reconcile child manifests, skip still-running children, and continue recoverable pre-manifest failures.
