---
name: relay
argument-hint: "[task, issue, or natural-language handoff]"
description: Use when a GitHub issue, sprint item, task description, or natural-language handoff should be implemented through autonomous executor dispatch; stops at ready_to_merge — merge only on explicit request.
compatibility: Requires Claude Code or Codex, gh CLI, git, Node.js 18+; Linux independent isolation requires Node.js 22+.
metadata:
  related-skills: "relay-ready, relay-plan, relay-dispatch, relay-review, relay-merge, relay-fleet, dev-backlog"
  keywords: "릴레이, 자동 실행, plan, dispatch, review, merge, relay cycle"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`; role overrides use `RELAY_ORCHESTRATOR`/`RELAY_REVIEWER`.
- Files: task/issue text, optional sprint file, `/tmp/dispatch-<N>.md`, and `/tmp/rubric-<N>.yaml`.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js`, `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`, `${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js`.

# Dev Relay

Execute the plan -> dispatch -> review cycle. Stop at `ready_to_merge` unless the user explicitly asks to merge. The public/internal/optional skill tiers are defined in `../../references/operator-surface.md`.

## Role Defaults

- Orchestrator: `unknown` until explicitly stamped; override with `RELAY_ORCHESTRATOR`.
- Executor: Codex by default; override with dispatch `--executor`.
- Reviewer: `unknown` until explicitly stamped; override with `--reviewer` or `RELAY_REVIEWER`.

Standard Codex path: stamp `RELAY_ORCHESTRATOR=codex` and review through `review-runner --reviewer codex`. Assigned `run.json` roles stay immutable; acting reviewer data is recorded separately.

## Step 1: Re-Anchor

Run `git fetch origin`. Task evidence: collect the first available source—local task file, `gh issue view <N>`, or user description—and use its `track:` or `component:` value as the sprint ownership handle. If no issue number, use a descriptive branch name and skip issue-close in merge.

Sprint tracking is optional; when in use, resolve ownership per [sprint-integration.md](references/sprint-integration.md).

Run the route preflight. It answers one question: does this issue already have a PR or an in-flight Relay run?

```bash
PREFLIGHT=$(node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/run-preflight.js" \
  --stage route --repo . --issue-number "$ISSUE_NUMBER" --branch "$BRANCH" --json)
```

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

Capture `run_id`, `run_dir`, and the current action key. The immutable record is `~/.relay/runs/<repo-slug>/<run-id>/run.json`; lifecycle state is folded from `events.jsonl` plus live observations, not mutated in a manifest. For in-flight writes, resolve ownership per the same [sprint-integration.md](references/sprint-integration.md) contract.

## Step 4: Review (relay-review)

**MANDATORY. Do NOT skip this step.**

**Verify before review — orchestrator-enforced for shell-free completion.** When the dispatched executor's dispatch capability declares no command-execution tool (today Claude and Pi; resolve with `relay-config check --executor <name> --phase dispatch --json`), the executor returned observation checks, not executed-test claims. Before invoking relay-review, the orchestrator performs each returned verification against the retained worktree and states the result; if the executor returned a stuck note, that becomes the blocking reason instead. Review must not begin on unverified changes. This is the orchestrator's obligation, not the executor's prompt — the executor-facing template cannot enforce it.

Invoke relay-review only when inspection recommends `review`:

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay-review/scripts/review-runner.js" \
  --repo . --run-id "$RUN_ID" --reviewer codex --json
```

Invoke **relay-review** in an isolated context. It records immutable review evidence and facts while keeping frozen Done Criteria as the review anchor. A requested change remains blocking until the corrected HEAD receives a passing primary review. Do NOT review inline.

The runner returns `verdict` and a fresh `recommended_action`. `lgtm` must recommend `merge` before Step 5. `changes_requested` must recommend `redispatch`; send a new prompt through `dispatch --run-id`, follow any recovery needed to republish the corrected HEAD, then review again. `escalated`, `operator_attention`, or a mismatched action stops the loop for investigation.

## Step 5: Ready to Merge

If relay-review returns LGTM, the review runner should already have recorded `ready_to_merge`. Do not mark the sprint task complete yet. Only run relay-merge when the user explicitly wants to land the PR. Create follow-up issues if discovered during review.

## Batch Mode

When multiple independent tasks are ready, prepare a `relay-fleet` batch but preserve `/relay`'s `ready_to_merge` stop until the user explicitly authorizes landing it; after authorization, `relay-fleet` is the default parallel batch drive. See `references/batch-mode.md` for the remaining conflict-recovery note and the "when in doubt, run sequentially" principle.
## Summary Checklist

Verify Done Criteria fully implemented, relay-review LGTM/audit comment, `ready_to_merge` state, and any sprint/follow-up updates per [sprint-integration.md](references/sprint-integration.md). For a shell-free executor, orchestrator-performed verification (Step 4) must be recorded before review.
