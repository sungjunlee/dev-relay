---
name: relay-fleet
description: Drive already-planned relay leaves through fan-out, review, serial merge, crash recovery, and fleet status.
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

- Driving already planned relay leaves through fan-out, review/publication/redispatch, serial merge, and close
- Re-running the same fleet command after a crashed or killed session
- Continuing an existing fleet from persisted child/fleet state
- Printing read-only aggregate status for a fleet

## Do not use when

- Decomposing raw or ambiguous requests into leaves — use `relay-ready`
- Authoring per-leaf rubrics or dispatch prompts — use `relay-plan`
- Dispatching a single task or run — use `relay-dispatch`
- Reviewing one standalone child PR — use `relay-review`

Run multi-leaf orchestration after `relay-ready` and `relay-plan` have already produced leaf artifacts. The default command is the full crash-only drive: fan-out -> review/publication/redispatch loop -> serial merge queue -> `closed` when every child is terminal.

Design rationale, rejected alternatives, non-goals, and the Phase 2/3 roadmap: [references/design.md](references/design.md).

To run a dev-backlog sprint batch as one fleet wave, use the mapping recipe in [references/sprint-to-leaves.md](references/sprint-to-leaves.md).

## Input Contract

Use a JSON file containing a non-empty `leaves[]` array. Each leaf must include:

- `leaf_ref`: stable fleet child key, usually the relay-ready `leaf_id`
- `issue_number`: GitHub issue number for fleet issue-lock admission
- `branch`: child dispatch branch
- `prompt_file`: prepared dispatch prompt
- `rubric_file`: prepared relay-plan rubric
- `done_criteria_file`: frozen Done Criteria snapshot
- `ownership`: validated `{ "sprint", "track", "component" }` copied from the dev-backlog sprint-state JSON that supplied the batch

relay-fleet only fans out already-decomposed leaf contracts; it never splits a raw or ambiguous request itself — route that intake through `relay-ready` first and pass its leaf output here.

All leaves must carry the same normalized owner. Missing, malformed, contradictory, or mixed-track ownership is rejected before a fleet manifest or child dispatch exists: one fleet is one track.

Optional per-leaf fields are passed through to `dispatch.js`: `request_id`, `leaf_id`, `executor`, `model`, `model_hints`, `sandbox`, `network_access`, `timeout`, `reasoning`, `copy`, `test_command`, and `register`. An optional `depends_on` array of `leaf_ref` strings records ordering intent: a reference to another leaf in the *same* leaves file fails closed at load time (dispatch that leaf in an earlier wave and drop the reference here); a reference to a `leaf_ref` outside this file is accepted silently and assumed already satisfied.
If a leaf's executor route is denied or its model is unresolved, pause that leaf and use `relay-config` to register the route or set the default before resuming the fleet.

## Commands

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --leaves-file /tmp/fleet-481-leaves.json \
  --parallel 4
```

Read-only aggregate status:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" \
  --repo . \
  --fleet-id fleet-481 \
  --status
```

Omit `--fleet-id` to list every fleet for the current repository without modifying manifests:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-fleet/scripts/relay-fleet.js" --repo . --status
```

Deprecated primary entry points, to be sunset within one release: `relay-fleet.js --resume` is accepted as an alias for re-running the default drive; `relay-fleet.js --review` and `merge-queue.js` remain internal re-entry/debug paths but should not be the operator loop.

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

- The default command invokes `skills/relay-dispatch/scripts/dispatch.js` as a subprocess once per undispatched leaf and always passes `--fleet-id` plus the typed `--ownership-json` owner.
- Existing fleet manifests are continued idempotently. With the same `--leaves-file`, already-dispatched children are not re-dispatched; with no `--leaves-file`, persisted fleet leaves are reused when dispatch recovery needs them.
- Re-runs fail closed if a child manifest owner differs from its persisted leaf; relay-fleet never rewrites `manifest.ownership`.
- The drive invokes `skills/relay-review/scripts/review-runner.js` for children in `internal_review_pending` or `review_pending`, publishes `publish_pending` children, and redispatches `changes_requested` children until each reaches `ready_to_merge` or `escalated`.
- The drive then invokes the serial merge queue, which calls `skills/relay-merge/scripts/finalize-run.js` for one `ready_to_merge` child at a time. When a child merge fails, it marks that child `merge_blocked` and continues with the next ready child.
- The fleet moves to `closed` only when every child is terminal: `merged`, `closed`, or `escalated`. Escalated children close the fleet with a nonzero exit and operator-attention summary; `merge_blocked` keeps the fleet open in `merging`.
- Each child dispatch owns worktree creation, in-flight run checks, executor invocation, and child run manifest writes.
- Fleet issue locks are checked before each child spawn; `dispatch.js --fleet-id` performs the durable lock during the actual child run.
- Re-runs reconcile both directions: they re-adopt child run manifests whose `fleet_id` points back to this fleet, mark no-manifest interrupted children as `dispatch_failed_pre_manifest`, skip still-running child subprocesses, and continue recoverable work.
- `--status` is read-only and uses the relay-dispatch fleet summary derivation rules. Without `--fleet-id`, it lists repo-scoped fleets and their terminal/total child counts.
- `--status` operator_attention may include `stalled_executor` when a child's run lease is live, `dispatch-stdout.log` is still 0 bytes, and lease age exceeds 15 minutes (`RELAY_FLEET_STALL_THRESHOLD_MS` override only). Visibility only — no kill. Mid-run stalls after the first stdout byte are not detected.

## SPOF

There is intentionally no daemon. A fleet makes progress only while `relay-fleet` is actively running. Pause by killing the process. Resume by re-running the same primary command with the same `--fleet-id` and, when available, the same `--leaves-file`; the command reconciles child manifests, skips still-running children, and continues recoverable pre-manifest failures.

## /goal Persistence

For long fleets, the operator may activate host `/goal` after fan-out to keep one session driving the daemonless loop. Use the copy-paste condition and idempotent operating loop in [references/goal-persistence.md](references/goal-persistence.md); the condition must name the transcript-visible `--status --json` check, not just an operator process.
