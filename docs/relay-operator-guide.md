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
$relay-config Use example/opencode-model-fast for personal advisory review
$relay-config Use my selected OpenCode provider/model route for personal dispatch and review dogfood
```

Route policy is based on provider/model routes, not only harness names. Managed Codex and Claude CLIs work by default when no policy exists. OpenCode, Pi, and advisory reviewers require explicit route approval. See [model-route-policy.md](model-route-policy.md) for the full policy shape and precedence order.

Project-local route UX lives outside the repo under `~/.relay/projects/<repo-slug>/project.json`, `~/.relay/projects/<repo-slug>/policy.json`, and `~/.relay/projects/<repo-slug>/routes.json`. Policy is authorization; `routes.json` stores preferences only and cannot grant routes. Use `relay-config plan-run --json` to preview the effective dispatch/review/advisory routing before dispatch, and use `--route-intent-file` for one-off run overrides. Dispatch persists the audited decision as `route-plan.json` in the run directory.

## Skills

| Skill | When to use |
| --- | --- |
| `/relay-config` | Configure route policy, allowed routes, defaults, and advisory review |
| `/relay` | Normal full-cycle handoff through review |
| `/relay-ready` | Clarify broad or ambiguous work before planning |
| `/relay-plan` | Build or inspect a rubric without dispatching |
| `/relay-dispatch` | Manually dispatch or re-dispatch an executor run |
| `/relay-review` | Manually review an existing relay PR |
| `/relay-merge` | Gate-check, merge, cleanup, and update sprint state |
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

Non-default reviewers and advisory lanes are advanced paths. Capability gates, model routes, timeouts, and adapter-specific isolation details live in `skills/relay-dispatch/references/agent-adapter-platform.md`; route policy syntax lives in [model-route-policy.md](model-route-policy.md).

Advisory review can run alongside the primary reviewer when route policy allows it. It records supplemental evidence but does not replace the primary verdict under standard assurance:

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer codex --advisory-reviewer <name> --advisory-profile blindspot --json
```

## Adapter Readiness Matrix

Implementation status describes the adapter surface shipped in relay. Live status describes dogfood evidence from real CLI runs. Do not treat implementation parity as production readiness: #609 added reviewer-role parity surfaces, #610 recorded live reviewer evidence and blockers, and #611 added healthy dispatch canary mode with live dispatch evidence and blockers.

| Adapter | Dispatch | Primary review | Advisory review |
| --- | --- | --- | --- |
| `claude` | Implementation: `stable`<br>Live: `stable` | Implementation: `stable`<br>Live: `stable` | Implementation: `not-supported`<br>Live: `not-supported` |
| `codex` | Implementation: `stable`<br>Live: `stable` | Implementation: `stable`<br>Live: `stable` | Implementation: `not-supported`<br>Live: `not-supported` |
| `opencode` | Implementation: `limited`<br>Live: `limited` after route-specific healthy dispatch evidence; otherwise blocked for that route | Implementation: `limited`<br>Live: `limited` by route policy and live reviewer evidence | Implementation: `limited`<br>Live: `limited` by route policy and advisory evidence |
| `pi` | Implementation: `stable`<br>Live: `limited` by route-specific healthy dispatch canaries | Implementation: `stable`<br>Live: `limited` by route-specific reviewer canaries | Implementation: `stable`<br>Live: `limited` by route-specific advisory evidence |
| `antigravity` | Implementation: `limited`<br>Live: `limited` by `google/antigravity-cli` healthy dispatch canary evidence | Implementation: `fail-safe-experimental`<br>Live: `blocked` until strict verdict JSON is accepted in a healthy live reviewer canary | Implementation: `fail-safe-experimental`<br>Live: `blocked` by current timeout/worktree-mutation blocker |
| `cursor` | Implementation: `limited`<br>Live: `blocked` until route-specific healthy dispatch canaries exist | Implementation: `limited`<br>Live: `blocked` until strict verdict JSON is accepted in a healthy live reviewer canary | Implementation: `not-supported`<br>Live: `not-supported` |

Status meanings:

| Status | Meaning |
| --- | --- |
| `stable` | Supported for normal operator use with healthy live evidence in the documented role. |
| `limited` | Implemented but constrained by route policy, containment limits, or route-specific evidence. Require current dogfood for the exact provider/model route before broad use. |
| `fail-safe-experimental` | Implemented only with fail-safe expectations; failures or malformed output must stop the run instead of producing reviewable success. |
| `blocked` | Do not promote the role yet. A known blocker or missing healthy dogfood evidence prevents production readiness. |
| `not-supported` | The adapter does not implement that role. |

Promotion criteria: fake-bin and unit tests are insufficient and do not prove live readiness. Healthy live dogfood evidence is required before promotion from `blocked`, `limited`, or `fail-safe-experimental` for the exact role, adapter, and route: dispatch must create the requested minimal PR and reach `review_pending`, primary review must return strict verdict JSON and reach the expected review state, and advisory review must return structured advisory output without mutating the reviewed worktree.

Timeouts are inconclusive unless the step is an intentionally bounded fail-safe timeout canary. A normal live timeout is not healthy evidence and should be recorded as a blocker or limitation; the fail-safe timeout canary only proves relay avoids converting a bounded timeout into reviewable false success.

### Antigravity Live Canary

Antigravity dispatch has route-specific healthy live canary evidence for `google/antigravity-cli`; primary and advisory review remain fail-safe experimental until healthy reviewer canaries pass. Fake-bin tests alone do not prove live executor or reviewer success.

Use the live dogfood harness for repeatable Pi, OpenCode, and Antigravity evidence. Full harness semantics and outcome meanings live in `skills/relay-dispatch/references/operator-utilities.md`; adapter status and healthy-path criteria live in `skills/relay-dispatch/references/agent-adapter-platform.md`.

`google/antigravity-cli` is the policy label for Antigravity; it is recorded for audit and not passed to `agy` as a model flag.

```bash
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --json --markdown
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --dispatch-canary --json
```

Interpretation: `failed/escalated` means relay failed safely or hit a live CLI limitation. `ready_to_merge` is healthy only when the dispatch PR contains the minimal requested change and the primary reviewer accepted strict verdict JSON within the configured timeout.

### Merge

Merge is explicit. The gate verifies review evidence, checks that the reviewed SHA matches the current PR head, and then finalizes the run.

```bash
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --merge-method squash --json
```

For exceptional hotfixes, skip-review requires a recorded reason:

```bash
node skills/relay-merge/scripts/finalize-run.js --run-id <id> --skip-review "hotfix: production outage" --json
```

## Batch And Advisory Work

Use `/relay-fleet` when multiple independent leaves are already planned and can run in parallel. Prefer sequential `/relay` when tasks share files, ordering is unclear, or merge conflicts are likely.

Use `/relay-review` advisory review when you need supplemental reviewer evidence for an existing run. Keep comparison implementation work in `/relay-fleet` or independent `/relay` leaves instead of adding a new lifecycle branch.

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

New executors live under `skills/relay-dispatch/scripts/executors/` and export the 7-field adapter contract documented in `skills/relay-dispatch/references/agent-adapter-platform.md`. Register the harness descriptor in `skills/relay-dispatch/scripts/agent-adapters/index.js`; update `skills/relay-dispatch/scripts/executors/index.js` only when stable compatibility display order needs it.

New reviewers use `skills/relay-review/scripts/invoke-reviewer-<name>.js`. The review runner resolves reviewers by name and expects a JSON verdict matching the local review schema.

Assigned roles are stamped in the run manifest. Acting reviewer overrides are recorded separately in review fields and events so analytics can distinguish assigned policy from actual execution.
