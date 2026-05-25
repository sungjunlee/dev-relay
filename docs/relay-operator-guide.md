# Relay Operator Guide

This guide keeps operational detail out of the top-level README. Most users should start with `/relay`; use the lower-level skills only when you need manual phase control, debugging, batch execution, or adapter work.

## Default Workflow

Use `/relay` as a natural-language handoff:

```text
/relay Work through the issues above
/relay Handle issue #42
/relay Implement the search filter task from the sprint file
```

The orchestrator reads the available task evidence, prepares a rubric, dispatches an executor in a worktree, reviews the PR in a fresh context, and stops at `ready_to_merge`.

Use `/relay-merge` only after you decide to land the reviewed PR:

```text
/relay-merge Merge the reviewed relay PR
/relay-merge 130
```

## Setup Workflow

Use `/relay-config` to set route policy rather than editing JSON by hand:

```text
/relay-config Set up relay for my company environment
/relay-config Only allow OpenCode through example/opencode-model-* at work
$relay-config Use opencode-go/deepseek-v4-pro for personal sidecar review
```

Route policy is based on provider/model routes, not only harness names. Managed Codex and Claude CLIs work by default when no policy exists. OpenCode, Pi, advisory reviewers, and sidecars require explicit route approval. See [model-route-policy.md](model-route-policy.md) for the full policy shape and precedence order.

## Skills

| Skill | When to use |
| --- | --- |
| `/relay-config` | Configure route policy, allowed routes, defaults, sidecars, and advisory review |
| `/relay` | Normal full-cycle handoff through review |
| `/relay-ready` | Clarify broad or ambiguous work before planning |
| `/relay-plan` | Build or inspect a rubric without dispatching |
| `/relay-dispatch` | Manually dispatch or re-dispatch an executor run |
| `/relay-review` | Manually review an existing relay PR |
| `/relay-merge` | Gate-check, merge, cleanup, and update sprint state |
| `/relay-sidecar` | Run advisory artifact-only sidecars for an existing run |
| `/relay-fleet` | Fan out prepared independent leaves in parallel |

## Manual Phase Control

The full cycle is plan -> dispatch -> review -> ready_to_merge -> explicit merge. `/relay` normally drives these steps for you.

### Readiness

`/relay` invokes readiness handling when a request is too broad, ambiguous, or missing a stable review anchor. The readiness artifact is persisted under `~/.relay/requests/<repo-slug>/` and becomes the downstream source of truth.

Use `/relay-ready` directly when you want to split or clarify work before implementation:

```text
/relay-ready Clarify the auth redirect cleanup into relay-ready leaves
```

### Plan

Planning turns task evidence and acceptance criteria into a rubric. The rubric travels with the run: the executor self-evaluates against it, and the reviewer re-scores independently.

Use `/relay-plan` directly when you want to inspect or adjust the rubric before dispatch:

```text
/relay-plan Build a rubric for issue #42
```

### Dispatch

Dispatch creates an isolated git worktree, writes the relay manifest, runs the executor, and records the run state under `~/.relay/runs/<repo-slug>/`.

Direct dispatch is mostly for advanced recovery, dry runs, or experiments:

```bash
node skills/relay-dispatch/scripts/dispatch.js . \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml

node skills/relay-dispatch/scripts/dispatch.js . \
  --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md
```

Useful dispatch flags:

| Flag | Purpose |
| --- | --- |
| `--executor` | Select `codex`, `claude`, `opencode`, or `pi` |
| `--model` | Pass a model override when the harness supports it; Pi should use an explicit provider/model route |
| `--network-access enabled` | Enable Codex workspace-write network access for supported runs |
| `--copy` | Copy extra gitignored files into the worktree |
| `--register` | Register a Codex app thread or Claude relay-side receipt |
| `--dry-run` | Validate the plan without executing |

### Review

Review runs in a fresh context and checks spec compliance, rubric results, scope drift, and code quality. It posts a machine-readable PR comment and either marks the run `ready_to_merge`, requests changes, or escalates.

Manual review command:

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> --reviewer codex --json
```

Pi can be used as dispatch executor or trusted primary reviewer when `pi` is on `PATH` (or `RELAY_PI_BIN` is set for review), authenticated for the selected provider, and route policy allows the model route:

```bash
node skills/relay-dispatch/scripts/dispatch.js . -e pi -m openai/gpt-5 \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml

node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer pi --reviewer-model openai/gpt-5 --json
```

Advisory review can run alongside the primary reviewer when route policy allows it:

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer codex --advisory-reviewer opencode --advisory-profile blindspot --json
```

### Merge

Merge is explicit. The gate verifies review evidence, checks that the reviewed SHA matches the current PR head, and then finalizes the run.

```bash
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --merge-method squash --json
```

For exceptional hotfixes, skip-review requires a recorded reason:

```bash
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --skip-review "hotfix: production outage" --json
```

## Batch And Sidecars

Use `/relay-fleet` when multiple independent leaves are already planned and can run in parallel. Prefer sequential `/relay` when tasks share files, ordering is unclear, or merge conflicts are likely.

Use `/relay-sidecar` for artifact-only advisory checks on an existing run. Sidecars should not block the normal lifecycle by default; they add supplemental evidence for the orchestrator or reviewer.

## Worktree Includes

Git worktrees do not include gitignored files such as `.env` and local config. Add `.worktreeinclude` to a project root when executors need specific ignored files:

```text
# .worktreeinclude
.env
.env.local
config/*.key
```

Only files matching both `.worktreeinclude` and `.gitignore` are copied. Missing files are skipped.

## Recovery And Cleanup

Merged and explicitly closed runs are cleaned by `/relay-merge`. For stale worktrees or interrupted runs:

```bash
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --older-than 72 --json
node skills/relay-dispatch/scripts/close-run.js --repo . --run-id <run-id> --reason "stale"
```

Reliability reports summarize historical run behavior:

```bash
node skills/relay-dispatch/scripts/reliability-report.js --repo .
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
node skills/relay-dispatch/scripts/reliability-report.js --repo . --by-role --json
node skills/relay-dispatch/scripts/reliability-report.js --repo . --by-acting-reviewer --json
```

## Extending Relay

New executors live under `skills/relay-dispatch/scripts/executors/` and are registered in `executors/index.js`. The adapter contract is documented in `skills/relay-dispatch/scripts/executors/README.md`.

New reviewers use `skills/relay-review/scripts/invoke-reviewer-<name>.js`. The review runner resolves reviewers by name and expects a JSON verdict matching the local review schema.

Assigned roles are stamped in the run manifest. Acting reviewer overrides are recorded separately in review fields and events so analytics can distinguish assigned policy from actual execution.
