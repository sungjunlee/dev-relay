# Relay Operator Guide

## Default Workflow

Start with `/relay`. It prepares the task, dispatches an executor in an isolated
worktree, invokes one independent primary reviewer, and stops at
`ready_to_merge`. Use `/relay-merge` only when you explicitly want to land the
reviewed PR.

## Skills

| Skill | Use |
| --- | --- |
| `/relay-config` | Check dispatch and primary-review adapter capability |
| `/relay-ready` | Clarify an ambiguous task |
| `/relay-plan` | Prepare Done Criteria and verification |
| `/relay-dispatch` | Dispatch or re-dispatch an executor |
| `/relay-review` | Run the independent primary review |
| `/relay-merge` | Gate, merge, and clean up |

## Manual Phase Control

### Dispatch

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  --executor pi --model openai/gpt-5 \
  -b issue-42 --prompt-file /tmp/dispatch.md
```

### Review

```bash
node skills/relay-review/scripts/review-runner.js \
  --repo . --run-id <id> --reviewer codex --json
```

Review runs in a fresh context. The structured primary verdict is the only
review authority. `changes_requested` remains blocking until a later review of
the corrected HEAD passes.

### Merge

```bash
node skills/relay-merge/scripts/finalize-run.js \
  --repo . --run-id <id> --merge-method squash --json
```

Merge verifies that the authorized passing review and execution evidence match
the current HEAD.

## Adapter Readiness Matrix

All seven built-in adapters support dispatch. Codex, Claude, OpenCode, Pi,
Antigravity, and Cursor support primary review. Cline is dispatch-only.
Detailed argv, containment, model, and live-canary notes live in
`skills/relay-dispatch/references/agent-adapter-platform.md`.

Fake-binary tests establish command contracts, not live provider health. Use
`skills/relay-dispatch/scripts/adapter-live-canary.js` and the primary-review or
dispatch scenarios in `live-dogfood.js` for adapter-specific evidence.

## Explicit Adapter Selection

```bash
node skills/relay-config/scripts/relay-config.js doctor --json
node skills/relay-config/scripts/relay-config.js \
  check review pi example/pi-model-fast --json
```

See [model-route-policy.md](model-route-policy.md).

## Recovery

Use `reconcile-run.js` when a dispatch supervisor died or completed without
settling state. Use `recover-commit.js` only for executor output that exists but
was not committed. Force-finalize remains an explicit operator escape hatch and
requires a reason; it does not manufacture review evidence.
