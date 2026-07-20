---
name: relay
argument-hint: "[task, issue, or natural-language handoff]"
description: Use when a GitHub issue, sprint item, task description, or natural-language handoff should be implemented through autonomous executor dispatch; stops at ready_to_merge — merge only on explicit request.
compatibility: Requires Claude Code or Codex, gh CLI, git, Node.js 18+.
metadata:
  related-skills: "relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge, relay-fleet, dev-backlog"
  keywords: "릴레이, 자동 실행, plan, dispatch, review, merge, relay cycle"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; role overrides use `RELAY_ORCHESTRATOR`/`RELAY_REVIEWER`.
- Files: task/issue text, optional sprint file, readiness probe inputs, `/tmp/dispatch-<N>.md`, and `/tmp/rubric-<N>.yaml`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Dev Relay

Execute the plan -> dispatch -> review cycle. Stop at `ready_to_merge` unless the user explicitly asks to merge. The public/internal/optional skill tiers are defined in `../../references/operator-surface.md`.

## Role Defaults

- Orchestrator: `unknown` until explicitly stamped; override with `RELAY_ORCHESTRATOR`.
- Executor: Codex by default; override with dispatch `--executor`.
- Reviewer: `unknown` until explicitly stamped; override with `--reviewer` or `RELAY_REVIEWER`.

Standard Codex path: stamp `RELAY_ORCHESTRATOR=codex` and review through `review-runner --reviewer codex`. Assigned manifest roles stay immutable; acting reviewer data is recorded separately.

## Route Preset Words

When the user gives a routing style, map only these clear words:
| User wording | Dispatch option |
| --- | --- |
| `가볍게`, `싸게`, `light` | `--route-preset light` |
| `리뷰 다양하게`, `diverse` | `--route-preset diverse` |
| `하드하게`, `hardened` | `--route-preset hardened` |

If no wording matches, list configured presets from routes config and ask/continue with defaults; do not guess.

## Step 1: Re-Anchor and Route

Run `git fetch origin`. Task evidence: collect the first available source—local task file, `gh issue view <N>`, or user description—and use its `track:` or `component:` value as the sprint ownership handle. If no issue number, use a descriptive branch name and skip issue-close in merge.

Before any sprint read, invoke the resolved dev-backlog `sprint-state.js --track <track> --json backlog` or `sprint-state.js --component <component> --json backlog` and use `active_sprint.path` as the owning sprint. With no handle, use `sprint-state.js --json backlog` only when exactly one sprint is active; if a selector lookup is unavailable or unresolved, allow that same fallback only when the single sprint's track/component matches. Never choose an arbitrary/global active sprint or parse sprint markdown in relay to resolve ownership. If no owner resolves, skip sprint tracking; otherwise re-read that sprint's Running Context, batch information, and completed/in-flight changes and apply previous-task context.

Run the deterministic route preflight; if readiness is already covered by a prior relay-ready artifact, explicit `--bypass-readiness`, or sprint-batch handoff, add `--bypass-readiness --skip-readiness-reason <reason>`.

```bash
PREFLIGHT=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" \
  --body-file "$ISSUE_BODY_FILE" --manifest "$RUN_MANIFEST" --json)
```

Branch on the JSON: follow `inflight.instruction` when `inflight.route != "continue"`, otherwise follow `readiness.decision.instruction`. The full branch table lives in [preflight-guards.md](references/preflight-guards.md). When `readiness.decision.route_decision == "needs_split"`, the instruction routes through proposal-first relay-ready shaping; accepted handoffs become the relay-plan source of truth before any dispatch.

Fast path: bypass relay-ready only for one relay-ready task with a stable review anchor and no clarification/decomposition needed. Otherwise run `relay-ready`; its handoff brief becomes the downstream source of truth.

## Step 2: Plan

**Always build a rubric.** Follow relay-plan's process: read task, recover Done Criteria, build rubric, emit handoff artifacts. Do NOT dispatch from relay-plan; Step 3 handles dispatch. Write the dispatch prompt and rubric YAML to temp files such as `/tmp/dispatch-<N>.md` and `/tmp/rubric-<N>.yaml`.

## Step 3: Dispatch (relay-dispatch)

`relay` owns lifecycle orchestration; `relay-dispatch` owns dispatch CLI semantics. When an operator needs a fixed executor or model, pass the dispatch options explicitly in this command. Common pass-through knobs are `--executor`, `--model`, and `--model-hints`; see `../relay-dispatch/references/model-routing.md` and `../relay-dispatch/references/cli-schema.md` for full route and option semantics.

For actor+model wording such as "opencode glm-5.2", run `relay-config resolve-model` or preset setup first and pass only explicit provider/model route intent. For model-only wording such as "glm-5.2", do not guess an actor; ask for actor context or offer matching configured presets/routes.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  -b issue-<N> --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml \
  --publish-policy after-internal-review --timeout 3600 --detach --json
# If relay-ready ran, append: --request-id <id> --leaf-id <id> --done-criteria-file <done-criteria-path>
# To pin a dispatch route, append: --executor <name> --model <provider/model> or --model-hints dispatch=<provider/model>
```

`--detach` prints a launch receipt with `runId`, `manifestPath`, `supervisorPid`, `stdoutLog`, `stderrLog`, and `reconcileCommand`; the supervisor continues if the calling shell dies. Poll the run until it leaves `dispatched`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/reconcile-run.js" --repo . --run-id "$RUN_ID" --dry-run --json
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/relay-recover.js" --repo . --run-id "$RUN_ID" --dry-run --json
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --json
```

Check the manifest/result:
- `status: "completed"`/`"completed-with-warning"` and `runState: "internal_review_pending"` → proceed to Step 4 (on warning, the executor timed out but made progress; check the worktree)
- `status: "failed"` and `runState: "escalated"` → inspect the dispatch error / manifest, fix and re-dispatch

Capture `runId`, `manifestPath`, `runState`; do not create or look up a PR yet (publication happens only after internal review LGTM). The manifest is under `~/.relay/runs/<repo-slug>/`. Before an in-flight write, resolve the owner through the same dev-backlog `sprint-state.js --track/--component --json` contract and matching-selector N==1 failure fallback, then update only its `active_sprint.path`; skip when no owner resolves.

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

If the run is `internal_review_pending`, invoke relay-review without `--pr`. A PASS verdict advances only to `publish_pending`, not `ready_to_merge`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" \
  --repo . --run-id "$RUN_ID" --reviewer codex --json
```

If review requests changes, re-dispatch and repeat Step 4. If review returns `publish_pending`, publish the branch:

```bash
PUBLISH_RESULT=$(node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/publish-run.js" \
  --repo . --run-id "$RUN_ID" --json)
PR_NUM=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.prNumber || ""));' "$PUBLISH_RESULT")
```

Now run the post-publication review — the round that can advance to `ready_to_merge` (it folds in PR CI/actions, GitHub review, and comment signals). Snapshot review state first:
```bash
REVIEW_BEFORE=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --json)
```

If `REVIEW_BEFORE.ready_status.status == "stale_ready"`, do not invoke relay-review yet. Recover the audited stale-ready transition first, then review the recovered run:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/recover-state.js" \
  --repo . --run-id "$RUN_ID" --to review_pending \
  --reason "PR HEAD advanced after ready_to_merge; rerun review for the live head" --json
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" \
  --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --json
```
If `REVIEW_BEFORE.ready_status.status == "merge_ready"`, skip the review invocation and continue to Step 5.

Invoke **relay-review** in an isolated context. It runs Spec Compliance then Code Quality, re-dispatches on issues, updates manifest state, and keeps the relay-plan rubric fixed as the review anchor. Review rounds use the assurance-derived cap (compact 1, standard 2, hardened 3) unless a higher run cap is explicit. Do NOT review inline.

After review returns, compare against the snapshot:
```bash
PREVIOUS_ROUNDS=<rounds>
PREVIOUS_VERDICT=<verdict>
REVIEW_AFTER=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage review --repo . --run-id "$RUN_ID" --pr "$PR_NUM" \
  --previous-rounds "$PREVIOUS_ROUNDS" --previous-verdict "$PREVIOUS_VERDICT" --json)
```

If `.comparison.stale == true`, treat review as stalled and recover by running the runner directly in the foreground:
```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" --repo . --run-id "$RUN_ID" --pr "$PR_NUM" --reviewer codex --json
```
Wait for exit, then repeat the same preflight comparison before Step 5.

## Step 5: Ready to Merge

If relay-review returns LGTM, the review runner should already have recorded `ready_to_merge`. Do not mark the sprint task complete yet. Only run relay-merge when the user explicitly wants to land the PR. Create follow-up issues if discovered during review.

## Batch Mode

When multiple independent tasks are ready, prepare a `relay-fleet` batch but preserve `/relay`'s `ready_to_merge` stop until the user explicitly authorizes landing it; after authorization, `relay-fleet` is the default parallel batch drive. See `references/batch-mode.md` for the remaining conflict-recovery note and the "when in doubt, run sequentially" principle.

## Summary Checklist

Verify Done Criteria fully implemented, relay-review LGTM/audit comment, `ready_to_merge` state, and any sprint/follow-up updates.
