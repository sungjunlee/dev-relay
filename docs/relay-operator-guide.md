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

OpenCode, Pi, and Antigravity can be used as reviewer roles only when the adapter can represent the phase and route policy allows the model route. OpenCode primary review uses prompt-only read-only plus a dirty-worktree guard; Pi uses a read/grep/find/ls allowlist; Antigravity targets the `agy` CLI. Antigravity dispatch has route-specific healthy live canary evidence for `google/antigravity-cli`; Antigravity primary and advisory review remain fail-safe experimental until healthy reviewer evidence exists.

OpenCode review uses a bounded parent-process timeout. Set `RELAY_OPENCODE_REVIEW_TIMEOUT` to a positive duration such as `120s`, `10m`, or `1h`; the default is `1800s`. If an OpenCode review returns empty stdout or times out, first validate the CLI/provider path with a minimal `opencode run -m <model> '<json prompt>'` command before treating the route as healthy.

For an OpenCode provider/model route you want to dogfood, authorize and check each role explicitly. Relay does not special-case or bundle any OpenCode model route:

```bash
node skills/relay-config/scripts/relay-config.js allow-route '<opencode-provider>/<opencode-model>' \
  --phase dispatch,review,advisory_review \
  --executor opencode \
  --reviewer opencode

node skills/relay-config/scripts/relay-config.js check dispatch opencode '<opencode-provider>/<opencode-model>'
node skills/relay-config/scripts/relay-config.js check review opencode '<opencode-provider>/<opencode-model>'
node skills/relay-config/scripts/relay-config.js check advisory_review opencode '<opencode-provider>/<opencode-model>'

opencode run -m '<opencode-provider>/<opencode-model>' \
  'Do not edit files. Reply exactly OPENCODE_ROUTE_OK and nothing else.'
```

Pi can be used as dispatch executor or trusted primary reviewer when `pi` is on `PATH` (or `RELAY_PI_BIN` is set for review), authenticated for the selected provider, and route policy allows the model route:

```bash
node skills/relay-dispatch/scripts/dispatch.js . -e pi -m openai/gpt-5 \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml

node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer pi --reviewer-model openai/gpt-5 --json

node skills/relay-config/scripts/relay-config.js plan-run --repo . \
  --dispatch pi:example/pi-model-fast --review codex --json
```

Pi primary review uses a bounded parent-process timeout. Set `RELAY_PI_REVIEW_TIMEOUT` to a positive duration such as `120s`, `10m`, or `1h`; the default is `1800s`. Relay invokes Pi with prompt-template, skill, theme, extension, and context-file discovery disabled so non-interactive review does not hang on optional startup integrations. If a Pi review still times out, first validate the CLI/provider path with a minimal `pi --no-session --no-context-files --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --print` command before treating the route as healthy. If that minimal command succeeds while `pi-primary` still times out, record the result as a prompt/scope or route-latency blocker rather than parser failure or healthy evidence.

When Pi's model-list probe times out in `relay-config doctor`, treat it as an optional discovery warning unless the exact route check or minimal Pi command also fails. Authorize the selected Pi route explicitly, then prove the non-interactive CLI path:

```bash
node skills/relay-config/scripts/relay-config.js allow-route '<pi-provider>/<pi-model>' \
  --phase dispatch,review,advisory_review \
  --executor pi \
  --reviewer pi

node skills/relay-config/scripts/relay-config.js check review pi '<pi-provider>/<pi-model>'

pi --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools read,grep,find,ls --print \
  'Do not edit files. Reply exactly PI_READONLY_OK and nothing else.'
```

Cursor can be used as dispatch executor or trusted primary reviewer when `agent` is on `PATH` (or `RELAY_CURSOR_AGENT_BIN` overrides the binary for dispatch and review), authenticated via `agent login` or `CURSOR_API_KEY`, and route policy allows the model route (add `cursor` to `managed_cli` for slug-only models such as `composer-2.5`):

```bash
node skills/relay-dispatch/scripts/dispatch.js . -e cursor -m composer-2.5 \
  -b issue-42 --prompt-file /tmp/dispatch-42.md --rubric-file /tmp/rubric-42.yaml

node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer cursor --reviewer-model composer-2.5 --json
```

Cursor primary review uses a bounded parent-process timeout. Set `RELAY_CURSOR_REVIEW_TIMEOUT` to a positive duration such as `120s`, `10m`, or `1h`; the default is `1800s`. Relay passes `--workspace` only and never `agent --worktree`.

Advisory review can run alongside the primary reviewer when route policy allows it:

```bash
node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer codex --advisory-reviewer opencode --advisory-profile blindspot --json

node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer codex --advisory-reviewer pi --advisory-reviewer-model openai/gpt-5 --advisory-profile blindspot --json

node skills/relay-review/scripts/review-runner.js --repo . --run-id <id> --pr <number> \
  --reviewer codex --advisory-reviewer antigravity --advisory-reviewer-model google/antigravity-cli --advisory-profile blindspot --json
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

Antigravity dispatch has route-specific healthy live canary evidence for `google/antigravity-cli` when the relay prompt binds work to the relay worktree. Antigravity primary and advisory review remain fail-safe experimental until healthy live reviewer canaries pass. Fake-bin tests alone do not prove live executor or reviewer success.

Healthy-path criteria are exact: primary review must return strict verdict JSON within timeout, dispatch must create a minimal repository change and reach a recoverable/reviewable state, or the operator must record a documented CLI limitation instead of claiming live success. The fail-safe timeout canary is not healthy success; it only proves relay avoids turning a bounded timeout into a reviewable false positive.

For Antigravity, use `google/antigravity-cli` as the current policy label. Relay records that label for policy and audit, but it is not passed to `agy`; do not claim Gemini model variant selection until `agy` exposes a real model-selection flag.

For repeatable multi-executor dogfood, use the harness:

```bash
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --json --markdown
node skills/relay-dispatch/scripts/live-dogfood.js --repo . --dispatch-canary --json
node skills/relay-dispatch/scripts/live-dogfood.js --repo . \
  --opencode-model '<opencode-provider>/<opencode-model>' \
  --pi-model '<pi-provider>/<pi-model>' \
  --scenario opencode-advisory \
  --scenario pi-primary \
  --json --markdown
```

By default the harness creates a temporary `RELAY_HOME`, writes a scoped route policy there, and runs Pi, OpenCode, and Antigravity probes plus bounded live canaries. OpenCode and Pi review canaries use realistic healthy timeouts by default; Antigravity primary and advisory review do too, while `--antigravity-fail-safe-timeout` controls the intentionally short fail-safe timeout canary. Use `--dry-run` to print `not-run` planned steps without invoking live CLIs, `--probe-only` to skip review/dispatch canaries, or repeated `--scenario <name>` filters such as `--scenario opencode-primary`, `--scenario pi-primary`, `--scenario pi-advisory`, or `--scenario antigravity-advisory` when one adapter needs isolated evidence without waiting on unrelated live canaries.

Add `--dispatch-canary` to run healthy dispatch canaries for Pi, OpenCode, and Antigravity. The harness anchors those dispatches in a temporary clean worktree from `--dispatch-base-ref` (default `origin/main`) so implementation branches do not become the PR base. Each canary asks for a unique minimal repository change and passes only when dispatch returns `review_pending` with a PR number. The default healthy dispatch timeout is bounded at 180 seconds via `--dispatch-timeout`, and branches use `--dispatch-branch-prefix` with the default `dogfood-dispatch`.

The harness still keeps a separate Antigravity no-op/fail-safe dispatch canary. That no-op path is successful only when it avoids a reviewable false success; a PR from the no-op path is a failure, not proof of live dispatch health.

Run the dispatch canary only after route policy allows `google/antigravity-cli` for Antigravity dispatch:

```bash
cat > /tmp/relay-antigravity-live-prompt.md <<'EOF'
Create or update relay-antigravity-live-canary.txt with exactly one line:
antigravity live canary
Commit that file and do not change anything else.
EOF

cat > /tmp/relay-antigravity-live-rubric.yaml <<'YAML'
criteria:
  - id: minimal-change
    description: Creates or updates only relay-antigravity-live-canary.txt with the requested line.
    weight: 1
YAML

node skills/relay-dispatch/scripts/dispatch.js . \
  --executor antigravity --model google/antigravity-cli \
  --branch "antigravity-live-canary-$(date +%Y%m%d%H%M%S)" \
  --prompt-file /tmp/relay-antigravity-live-prompt.md \
  --rubric-file /tmp/relay-antigravity-live-rubric.yaml \
  --timeout 120 --json
```

If dispatch produces a PR, run the primary-review healthy canary against that run:

```bash
RELAY_ANTIGRAVITY_REVIEW_TIMEOUT=120s \
node skills/relay-review/scripts/review-runner.js --repo . --run-id "$RUN_ID" --pr "$PR_NUM" \
  --reviewer antigravity --reviewer-model google/antigravity-cli --json
```

Interpretation: `failed/escalated` means relay failed safely or hit a live CLI limitation, so keep Antigravity marked experimental. `ready_to_merge` is the healthy signal only when the dispatch PR contains the minimal requested change and the primary reviewer accepted strict verdict JSON within the configured timeout.

Harness outcomes are intentionally distinct: `pass` proves a healthy live canary returned the expected structured output, `fail-safe-pass` means relay avoided a reviewable false success and is not healthy success, `timeout` is inconclusive, `fail` is actionable failure, and `not-run` is dry-run or skipped coverage.

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
