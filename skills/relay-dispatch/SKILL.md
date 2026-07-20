---
name: relay-dispatch
argument-hint: "<repo-path> (-b <branch> | --run-id <id>) -p <prompt> [options]"
description: Dispatch implementation tasks via worktree isolation. Use when delegating work to an executor, running background dispatches, or parallelizing independent tasks.
compatibility: Requires executor CLI (e.g., codex), git, and Node.js 18+.
metadata:
  related-skills: "relay, relay-ready, relay-plan, relay-review, relay-merge"
  keywords: "디스패치, 실행, dispatch, executor, worktree"
---
## Inputs
- Env: optional `RELAY_SKILL_ROOT` defaults to `skills`.
- Files: dispatch prompt (`--prompt-file` or `--prompt`), required evaluation artifact or legacy rubric via `--rubric-file`, optional Done Criteria file, request/leaf ids, copied files, and retained run manifest.
- Sibling scripts: `${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js`.

# Relay Dispatch

## Use when

- Delegating implementation to an executor (`codex`, `claude`, `opencode`, `pi`, `antigravity`, `cursor`, `cline`) via worktree isolation
- Resuming a same-run after a `changes_requested` review
- Running background or parallel dispatches for independent tasks

## Do not use when

- Authoring rubrics or planning — use `relay-plan`
- Reviewing executor output — use `relay-review`
- Task lacks frozen Done Criteria — anchor it via `relay-ready` first

## Usage

```bash
# Foreground (blocking — simple tasks, default executor: codex)
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml

# Detached (recommended for long/background work; survives caller shell exit)
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -b feature-auth -p "..." --rubric-file rubric.yaml --detach --json

# Same-run resume after a changes-requested review
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md

# With explicit executor
node "${RELAY_SKILL_ROOT:-skills}/relay-dispatch/scripts/dispatch.js" . -e codex -b feature-auth -p "..." --rubric-file rubric.yaml
```

For background and parallel dispatch, see `../relay/SKILL.md` § Batch Mode (single source of truth for the parallel-fork flow).

Supported executors: `codex`, `claude`, `opencode`, `pi`, `antigravity`, `cursor`, and `cline`. For non-default routes, pass `--executor pi`, `--executor antigravity`, `--executor cursor`, `--executor cline`, or another supported executor with a route-policy-approved model.

Default timeouts are `codex: 2400` and `claude/opencode/pi/antigravity/cursor/cline: 1800`. Model examples, capability gates, and the 7-field executor contract are documented in `references/agent-adapter-platform.md` and `references/model-routing.md`.

## Options

All CLI flags are registered with an explicit `parsed` or `verbatim` read mode. See `references/cli-schema.md` before adding or changing flags.

Essential flags:

- `--branch, -b` starts a new retained run; `--run-id` or `--manifest` resumes one.
- `--prompt, -p` or `--prompt-file` supplies the executor prompt.
- `--rubric-file` is required for new dispatches from relay-plan and carries either structured evaluation channels or a readable legacy rubric.
- `--executor, -e`, `--model, -m`, and `--model-hints` select harness/model routes subject to policy.
- `--review-assurance compact | standard | hardened`, `--request-id`, `--leaf-id`, and `--done-criteria-file` persist review and readiness anchors. Fleet dispatch also requires typed `--ownership-json` with `sprint`, `track`, and `component`; it is immutable on resume.
- `--detach` starts a detached dispatch supervisor, prints a receipt, and returns before executor completion.
- `--dry-run` validates without executing; `--json` returns structured output for orchestration.

Manifest layout is `~/.relay/runs/<repo-slug>/<run-id>.md` plus `events.jsonl`; readiness linkage is persisted as `source.request_id`, `source.leaf_id`, and `anchor.done_criteria_path`. Model precedence and route-policy behavior are documented in `references/model-routing.md`.

Detached JSON receipts include `runId`, `manifestPath`, `supervisorPid`, `stdoutLog`, `stderrLog`, and a copy-pasteable `reconcileCommand`. The supervisor writes `lease.json` and runtime logs in the run directory; use `reconcile-run.js --dry-run --json` to poll or diagnose a detached run.

### Executor model routing

For precedence, managed CLI defaults, unmanaged route requirements, and optional `~/.relay/executors.json` overrides, see `references/model-routing.md`. Short version: explicit `--model` wins; `model_hints` are hints, not approval; unmanaged executors need allowed provider/model routes.

### Timeout guidance

Use defaults for simple work, `--timeout 3600` when implementation plus verification needs more time, and `--timeout 5400` only for complex multi-file work with a long final gate.

## Verify Success

JSON output reports `status`, `runId`, `manifestPath`, `runState`, `cleanupPolicy`. Map status → next step:
- `completed` + `internal_review_pending` → run relay-review before PR publication (`--publish-policy after-internal-review`)
- `completed-with-warning` + `internal_review_pending` → inspect worktree, then run internal relay-review
- `completed` + `review_pending` → proceed to relay-review (default immediate publication path)
- `completed-with-warning` + `review_pending` → inspect uncommitted work, then review
- `failed` + `escalated` → inspect error, fix or re-dispatch

Successful dispatches retain the worktree by default — use the returned `runId` to continue. Resume only from `changes_requested`; dispatch reuses the same run + worktree. On re-dispatch, previous attempt evidence + reviewer feedback are auto-prepended, including legacy Score Log content when present (storage: `~/.relay/runs/<slug>/<run-id>/previous-attempts.json`).

Publication policy:
- Default direct dispatch behavior is `--publish-policy immediate`: push/open PR, then `review_pending`.
- Full `/relay` orchestration uses `--publish-policy after-internal-review`: retain the branch locally in `internal_review_pending`, require relay-review LGTM, then run `publish-run.js` to push/open PR and move to `review_pending`.
- `publish-run.js` is valid only from `publish_pending`; it writes a `publish_result` event and stamps `git.pr_number`.

Risk-aware task profiles derive compact/standard/hardened from task properties, never model identity. Compact keeps the same permission, sandbox, network, repository, SHA, audit, publication, and merge boundaries with a one-round review cap; hardened uses the existing delayed-publication and advisory-gated path. See `../relay-plan/references/risk-assurance.md`.

### Handling Failures

| Failure | Action |
|---|---|
| Timeout (with commits) | `completed-with-warning` — check worktree for uncommitted changes, proceed to review |
| Timeout (no commits) | Increase `--timeout` or split task into smaller pieces |
| Executor error / no commits | Read result file; revise prompt and re-dispatch |
| Route denied or model unresolved | Run `relay-config` to register the route or set the executor default model, then re-dispatch |
| Branch publication / PR creation failed | Inspect the dispatch error and outer-shell GitHub auth. `relay-dispatch` handles publication from the orchestrator shell. |
| Branch conflicts | Resolve in worktree or create fresh worktree from updated main |
| Network/transient error | Wait 30s, retry once. If it fails again, escalate to user |

## Recovery and operator utilities

- Crash-only settlement after signal/reboot/OOM or from another shell → `references/recovery-playbook.md` (`reconcile-run.js`).
- Executor finished but did not commit / push / open the PR → `references/recovery-playbook.md` (`recover-commit.js`).
- Manifest state needs adjustment after an external event (direct push, hung dispatch, escalation) → `references/recovery-playbook.md` (`recover-state.js`, includes the whitelist transition table).
- Standalone worktree creation, cleanup, run-close, reliability report → `references/operator-utilities.md`.

## Caveats

- `dispatch.js` exits non-zero on failure; check before review.
- Successful dispatch retains the worktree by default.
- If parallel PRs touch the same files, merge one at a time and rebase the other.
