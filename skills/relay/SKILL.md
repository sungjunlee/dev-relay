---
name: relay
argument-hint: "[task, issue, or natural-language handoff]"
description: Use when a GitHub issue, sprint item, task description, or natural-language handoff should be implemented through autonomous executor dispatch; GitHub stops at ready_to_merge, while local delivery closes as reviewed_result_ready.
compatibility: Requires Claude Code or Codex, git, and Node.js 18+; gh CLI is needed only for the supported GitHub route. Relay launches directly on the trusted local host on supported OSes.
metadata:
  related-skills: "relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge, relay-fleet, dev-backlog"
  keywords: "릴레이, 자동 실행, plan, dispatch, review, merge, relay cycle"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; role overrides use `RELAY_ORCHESTRATOR`/`RELAY_REVIEWER`.
- Files: task/issue text, optional sprint file, `/tmp/dispatch-<N>.md`, and `/tmp/rubric-<N>.yaml`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Dev Relay

Execute the plan -> dispatch -> review cycle. GitHub delivery stops at `ready_to_merge` unless the user explicitly asks to merge; local delivery runs canonical recovery and stops at terminal `reviewed_result_ready`. The public/internal/optional skill tiers are defined in `../../references/operator-surface.md`.

## Role Defaults

- Orchestrator: `unknown` until explicitly stamped; override with `RELAY_ORCHESTRATOR`.
- Executor: Codex by default; override with dispatch `--executor`.
- Reviewer: `unknown` until explicitly stamped; override with `--reviewer` or `RELAY_REVIEWER`.

Standard Codex path: stamp `RELAY_ORCHESTRATOR=codex` and review through `review-runner --reviewer codex`. Assigned `run.json` roles stay immutable; acting reviewer data is recorded separately.

## Step 1: Source and Re-Anchor

Classify the repository before any fetch, forge lookup, worktree, run-directory,
or executor effect. Relay requires Git and never runs `git init` for you. Run
the route preflight first; it performs the read-only source gate and then
route-specific in-flight checks (the existing duplicate-PR guard on GitHub and
local-only run facts without a remote):

```bash
PREFLIGHT=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" --json)
```

If `source.route` is `local-reviewed-result`, use local task text or the user
description and do not run `git fetch`, `gh issue view`, or any PR lookup. The
run continues through Git verification, independent review, and canonical
Reviewed Result closure without a forge. If `source.route` is `github`, use
the reported `source.remote_name` for the existing re-anchor fetch, then use
`gh issue view <N>` when issue text is needed. That route retains its current
GitHub deduplication and requires authenticated GitHub access plus the selected
executor/reviewer's ordinary ambient CLI authentication and network
availability. GitLab and
other forges are unsupported; configure GitHub, remove all remotes for local
delivery, or use direct `delegate`. A `SOURCE_NOT_GIT` error recommends
explicit `git init` or direct `delegate`.

Task evidence is the first available source after that gate: local task file,
GitHub issue on the GitHub route, or user description. Use its `track:` or
`component:` value as the sprint ownership handle. If no issue number, use a
descriptive branch name and skip issue-close in merge.

Sprint tracking is optional; when in use, resolve ownership per [sprint-integration.md](references/sprint-integration.md).

Follow `inflight.instruction` whenever `inflight.route != "continue"`; that dedup guard is binding and the route table lives in [preflight-guards.md](references/preflight-guards.md). On `continue`, judge readiness yourself using the checklist in `../relay-ready/SKILL.md`; no script scores it. When that judgment is `needs_split`, route through proposal-first relay-ready shaping, and the accepted handoff becomes the relay-plan source of truth before any dispatch.

Fast path: skip relay-ready only for one ready leaf with a stable review anchor and no clarification or decomposition needed. Otherwise run `relay-ready`; its handoff brief becomes the downstream source of truth.

## Step 2: Plan

**Always build a rubric.** Follow relay-plan's process: read task, recover Done Criteria, build rubric, emit handoff artifacts. Do NOT dispatch from relay-plan; Step 3 handles dispatch. Write the dispatch prompt and rubric YAML to temp files such as `/tmp/dispatch-<N>.md` and `/tmp/rubric-<N>.yaml`.

## Step 3: Dispatch (relay-dispatch)

`relay` owns lifecycle orchestration; `relay-dispatch` owns dispatch CLI semantics. Pass a fixed executor or model explicitly with `--executor` and `--model`; no catalog, preset, or model-hint fallback participates in selection.

For actor+model wording such as "opencode glm-5.2", pass both values explicitly. For model-only wording such as "glm-5.2", do not guess an actor; ask for actor context.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . \
  -b issue-<N> --prompt-file /tmp/dispatch-<N>.md --rubric-file /tmp/rubric-<N>.yaml \
  --done-criteria-file <done-criteria-path> --timeout 3600 --detach --json
# To pin dispatch selection, append: --executor <name> --model <provider/model>
```

If the rubric itself is the frozen Done Criteria, omit `--done-criteria-file`. `--detach` returns a snake_case launch receipt containing `status`, `run_id`, `run_dir`, `worktree`, `attempt_id`, `host_handle`, `dispatcher_pid`, and `inspection`; attempt log paths are durable facts. The dispatcher continues if the calling shell dies. Poll read-only inspection while the recommendation is `wait`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/relay-recover.js" inspect --repo . --run-id "$RUN_ID" --json
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" --stage review --repo . --run-id "$RUN_ID" --json
```

Follow `inspection.recommended_action` exactly:
- `recover` → run canonical `relay-recover recover` with the returned action key; it alone commits, pushes, and records or creates the exact PR.
- `review` → proceed to Step 4.
- `redispatch` → call dispatch with the immutable `run_id`; all other resume attempts fail before writing.
- `wait` → keep polling; `operator_attention` or `none` → stop and resolve the blocker.

Capture `run_id`, `run_dir`, and the current action key. The immutable record is `~/.relay/runs/<repo-slug>/<run-id>/run.json`; lifecycle state is folded from `events.jsonl` plus live observations, never stored as mutable lifecycle state. For in-flight writes, resolve ownership per the same [sprint-integration.md](references/sprint-integration.md) contract.

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

**Verify before review — orchestrator-enforced for shell-free completion.** When the dispatched executor's dispatch capability declares no command-execution tool (today Pi; resolve with `relay-config check --executor <name> --phase dispatch --json`), the executor returned observation checks, not executed-test claims. Before invoking relay-review, the orchestrator performs each returned verification against the retained worktree and states the result; if the executor returned a stuck note, that becomes the blocking reason instead. Review must not begin on unverified changes. This is the orchestrator's obligation, not the executor's prompt — the executor-facing template cannot enforce it.

Invoke relay-review only when inspection recommends `review`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" \
  --repo . --run-id "$RUN_ID" --reviewer codex --json
```

Invoke **relay-review** in an isolated context. It records immutable review evidence and facts while keeping frozen Done Criteria as the review anchor. A requested change remains blocking until the corrected HEAD receives a passing primary review. Do NOT review inline.

The runner returns `verdict` and a fresh `recommended_action`. On the GitHub route, `lgtm` must recommend `merge` before Step 5. On the local route, `lgtm` must recommend `recover`; run canonical recovery with that action key to append the terminal `reviewed_result_ready` result. `changes_requested` must recommend `redispatch`; send a new prompt through `dispatch --run-id`, follow any recovery needed to publish the corrected GitHub revision or retain the corrected local commit, then review again. A runtime invocation failure may recommend one explicit `review` retry bound to that failure; a second failure, model-returned `escalated`, `operator_attention`, or a mismatched action stops for investigation.

## Step 5: Finish the Selected Route

For `source.route=github`, LGTM must derive `merge/ready_to_merge`; stop there until the user explicitly authorizes `relay-merge`. For `source.route=local-reviewed-result`, LGTM must derive `recover/reviewed_result_ready`; run that exact recovery action and stop only after inspection reports the terminal Reviewed Result. Create follow-up issues if discovered during review.

## Batch Mode

When multiple independent tasks are ready, prepare a `relay-fleet` batch but preserve `/relay`'s `ready_to_merge` stop until the user explicitly authorizes landing it; after authorization, `relay-fleet` is the default parallel batch drive. See `references/batch-mode.md` for the remaining conflict-recovery note and the "when in doubt, run sequentially" principle.
## Summary Checklist

Verify Done Criteria fully implemented, relay-review LGTM/audit evidence, and the selected route's exact finish state: `ready_to_merge` for GitHub or terminal `reviewed_result_ready` for local delivery. Then apply any sprint/follow-up updates per [sprint-integration.md](references/sprint-integration.md). For a shell-free executor, orchestrator-performed verification (Step 4) must be recorded before review.
