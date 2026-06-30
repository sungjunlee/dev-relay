---
name: relay-fleet
description: Fan out already-planned relay leaves into parallel child dispatches, review child runs, merge ready children serially, resume crashed fleet dispatch, and print fleet status.
compatibility: Requires git, gh CLI, Node.js 18+, and sibling relay-dispatch/relay-merge skills.
argument-hint: --fleet-id <id> --leaves-file <path>
metadata:
  related-skills: relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge
  keywords: relay-fleet, fleet, fan-out, parallel dispatch, resume, status, 병렬, 재개, 상태
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: leaves JSON passed by `--leaves-file`, child prompt/rubric/Done Criteria files, and fleet/child run manifests under `~/.relay/runs/`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js`, `${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/merge-queue.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`, `${RELAY_SKILL_ROOT:-skills}/relay-merge/scripts/finalize-run.js`.

# relay-fleet

## Use when

- Fanning out already planned relay leaves into parallel child dispatches
- Driving foreground internal review, publication, post-publication review, and redispatch loops for children in a dispatched fleet
- Merging `ready_to_merge` fleet children one at a time after review orchestration
- Resuming a crashed fleet dispatch or review loop from persisted child/fleet state
- Printing read-only aggregate status for a fleet

## Do not use when

- Decomposing raw or ambiguous requests into leaves — use `relay-ready`
- Authoring per-leaf rubrics or dispatch prompts — use `relay-plan`
- Dispatching a single task or run — use `relay-dispatch`
- Reviewing one standalone child PR — use `relay-review`

Run Phase 1 multi-leaf orchestration after `relay-ready` and `relay-plan` have already produced leaf artifacts. It only fans out prepared leaf contracts to `relay-dispatch`, records crash-safe fleet progress, and reports aggregate status.

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
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --leaves-file /tmp/fleet-481-leaves.json \
  --parallel 4
```

Resume after a terminal/session crash:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --resume
```

Drive review for each child currently in `internal_review_pending`, `publish_pending`, `review_pending`, or `changes_requested` until it reaches `ready_to_merge` or `escalated`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --review
```

Merge ready children serially:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/merge-queue.js" \
  --repo . \
  --fleet-id fleet-481
```

Read-only aggregate status:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --status
```

Dry-run validates the leaf file and invokes child `dispatch.js --dry-run` for each leaf without writing a fleet manifest:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --leaves-file /tmp/fleet-481-leaves.json \
  --dry-run \
  --json
```

## Behavior

- The fleet script invokes `skills/relay-dispatch/scripts/dispatch.js` as a subprocess once per leaf and always passes `--fleet-id`.
- `--review` invokes `skills/relay-review/scripts/review-runner.js` as foreground subprocesses for children in `internal_review_pending` or `review_pending`. Internal PASS advances to `publish_pending`, where fleet invokes `skills/relay-dispatch/scripts/publish-run.js`; `changes_requested` invokes `dispatch.js --manifest <child-manifest>` and re-enters the loop until the child reaches `ready_to_merge` or `escalated`.
- `merge-queue.js` invokes `skills/relay-merge/scripts/finalize-run.js` as a subprocess for one `ready_to_merge` child at a time. It stops at the first merge failure and marks that child `merge_blocked`.
- Each child dispatch owns worktree creation, in-flight run checks, executor invocation, and child run manifest writes.
- Fleet issue locks are checked before each child spawn; `dispatch.js --fleet-id` performs the durable lock during the actual child run.
- `--resume` reconciles both directions: it re-adopts child run manifests whose `fleet_id` points back to this fleet, marks no-manifest interrupted children as `dispatch_failed_pre_manifest`, skips still-running child subprocesses, and re-enters the review/publication/redispatch loop for children in `internal_review_pending`, `publish_pending`, `review_pending`, or `changes_requested`.
- `--status` is read-only and uses the relay-dispatch fleet summary derivation rules.

## SPOF

There is intentionally no daemon. A fleet makes progress only while `relay-fleet` is actively running. If the session dies, the fleet pauses; re-run with `--resume` to reconcile child manifests, skip still-running children, and continue recoverable pre-manifest failures.
