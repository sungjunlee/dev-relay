# dev-relay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Delegate implementation to AI agents. Keep planning and review in your hands.**

dev-relay orchestrates the handoff between a planner, an executor, and a reviewer. You define what to build. The executor builds it in an isolated worktree. The reviewer evaluates the PR with fresh eyes, no planning bias. The result becomes ready to merge only after an auditable review trail exists.

Roles are bound per-run, not hardcoded. Any supported agent can plan, execute, or review.

```
Orchestrator             Executor                    GitHub
 |                        |                            |
 +-- plan + rubric ------>[Codex | Claude]             |
 |                        +-- implement ------------->[ PR ]
 |                        |                            |
 +-- review (fresh ctx) <-+   [Codex | Claude]         |
 |   +- contract checks   |                            |
 |   +- rubric scoring    |                            |
 |   +- scope drift check |                            |
 |   +- quality sweep     |                            |
 |   +- issues found? --->+-- re-dispatch ----------->[ PR updated ]
 |                        |                            |
 +-- LGTM ------------------------------------------>[ ready_to_merge ]
 +-- explicit merge ----------------------------------[ merged ]
 +-- cleanup + sprint update                           |
```

## Why

AI coding agents produce better results when given clear scope and independent review. dev-relay codifies this into a repeatable workflow:

- **Separation of concerns** ... planning and review stay with you; implementation is delegated
- **Agent-agnostic** ... Codex and Claude Code are supported as both executor and reviewer. Roles bind at run time.
- **Bias-free review** ... the reviewer runs in a forked context with no memory of the plan
- **Audit trail** ... every merge requires a documented review verdict on the PR
- **Convergence loop** ... the reviewer can re-dispatch fixes until the PR meets the rubric, with scope drift detection across rounds
- **Manifest-backed lifecycle** ... each run is a stateful contract with immutable role bindings, policy fields, and review anchors

## State Machine

Each relay run follows a manifest-backed state machine stored at `~/.relay/runs/<repo-slug>/<run-id>.md`:

```
  +----------+
  |  draft   |-----------------------------------------+
  +----+-----+                                         |
       v                                               v
  +-----------+                                  +---------+
  | dispatched|------------------------+         | closed  |
  +-----+-----+                        |         +---------+
        v                              v              ^
  +-----------------+            +-----------+        |
  | review_pending  |----------->| escalated |--------+
  +--+-----------+--+            +-----------+
     |           |
     v           v
+-------------------+     +----------------+
| changes_requested |     | ready_to_merge |
+---------+---------+     +-------+--------+
          |                       |
          v (re-dispatch)         v
     dispatched              +--------+
                             | merged |
                             +--------+
```

Terminal states: `merged`, `closed`. Transitions are enforced in code. Direct state assignment is a bug. An append-only event journal at `~/.relay/runs/<repo-slug>/<run-id>/events.jsonl` records every transition.

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Installs all 5 skills as [Claude Code custom slash commands](https://docs.anthropic.com/en/docs/claude-code/skills). Add `-g -y` for global install without prompts:

```bash
npx skills add sungjunlee/dev-relay -g -y
```

<details>
<summary>Install from a local clone</summary>

```bash
git clone https://github.com/sungjunlee/dev-relay.git
cd dev-relay
npx skills add . -g -y
```
</details>

Working from a repo checkout without installing skills? See [docs/direct-read-relay-operator-note.md](docs/direct-read-relay-operator-note.md).

### Prerequisites

- [Claude Code](https://claude.ai/code) or [Codex](https://chatgpt.com/codex)
- [`gh` CLI](https://cli.github.com/) ... authenticated (`gh auth login`)
- Git 2.20+
- Node.js 18+

## Quick Start

### One command, full cycle

```
/relay 42
```

Reads issue #42, builds a scoring rubric if the task is complex, dispatches to the executor in a worktree, reviews the resulting PR, and stops at `ready_to_merge`. It runs all four phases (plan, dispatch, review, gate check) but does not auto-merge. Use `/relay-merge` to land it explicitly.

### Step by step

Use individual skills when you want control over each phase:

```bash
/relay-plan 42          # Convert issue AC into a scoring rubric
/relay-dispatch         # Dispatch to executor (worktree -> implement -> PR)
/relay-review fix/42    # Review PR in a fresh context
/relay-merge 123        # Gate-check -> explicit merge -> cleanup
```

## Skills

| Command | Phase | Description |
|---------|-------|-------------|
| `/relay [issue]` | All | Full cycle through `ready_to_merge` |
| `/relay-plan [issue]` | Plan | Build scoring rubric from acceptance criteria |
| `/relay-dispatch` | Execute | Dispatch to executor via git worktree isolation |
| `/relay-review [branch]` | Review | Independent PR review with convergence loop |
| `/relay-merge [PR]` | Ship | Explicit merge after LGTM, cleanup worktree, update sprint |

## How It Works

### Plan ... `/relay-plan`

Converts acceptance criteria into a **scoring rubric** that guides both the executor and the reviewer:

| Rubric element | Example |
|---------------|---------|
| **Automated checks** | `npm test` exits 0, `tsc --noEmit` passes |
| **Evaluated factors** | Code quality 8+, naming consistency 7+, edge cases covered |
| **3-anchor scoring** | Each factor defines low/mid/high anchors for consistent grading |
| **Weights** | Required (must pass) vs best-effort (nice to have) |

The rubric travels with the task. The executor uses it to self-evaluate, and the reviewer re-scores independently.

Before building the rubric, `probe-executor-env.js` scans the project for available tools (npm scripts, Makefiles, pytest, etc.) so automated checks target real capabilities, not assumptions.

For L/XL tasks (5+ acceptance criteria), an optional stress-test catches gaming vectors and coverage gaps before dispatch.

> **When to skip rubrics:** Typos, one-liner fixes, simple bugs. Use rubrics for 3+ acceptance criteria or quality-sensitive work.

### Dispatch ... `/relay-dispatch`

Creates an isolated git worktree, merges the base branch for freshness, writes a relay run manifest, runs the executor with the task prompt, and collects results.

```bash
# Minimal
/relay-dispatch --branch fix/login-bug --prompt "Fix the null check in auth.ts"

# With rubric and extended timeout
/relay-dispatch --branch feat/search --prompt-file rubric.md --timeout 3600

# Resume after review requested changes (reuses retained worktree)
/relay-dispatch --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md

# Dry run
/relay-dispatch --branch feat/search --prompt "Add search" --dry-run
```

On re-dispatch, iteration history (prior scores + reviewer feedback) is automatically prepended to the executor prompt so it has full context on what to fix.

<details>
<summary>All dispatch options</summary>

| Flag | Description | Default |
|------|-------------|---------|
| `--branch, -b` | Branch name | *required* |
| `--run-id` | Resume an existing retained relay run | ... |
| `--manifest` | Resume an existing retained relay run by manifest path | ... |
| `--prompt, -p` | Task prompt | *required (or --prompt-file)* |
| `--prompt-file` | Read prompt from file | ... |
| `--executor, -e` | Executor type (`codex` or `claude`) | `codex` |
| `--model, -m` | Model override | ... |
| `--sandbox` | `workspace-write` or `read-only` | `workspace-write` |
| `--copy-env` | Copy `.env` to worktree | `false` |
| `--copy` | Additional files to copy (comma-separated) | ... |
| `--timeout` | Timeout in seconds | `1800` |
| `--register` | Additionally register in executor app (worktrees are retained by default) | `false` |
| `--dry-run` | Print plan, don't execute | `false` |
| `--json` | Structured JSON output | `false` |

**Timeout guidance:** 1800s for simple tasks, 3600s with self-review, 5400s for complex multi-file work.

Manifests are stored at `~/.relay/runs/<repo-slug>/<run-id>.md` with an append-only event journal at `~/.relay/runs/<repo-slug>/<run-id>/events.jsonl`.

Successful dispatches retain their worktree by default so review, follow-up fixes, and manual inspection can continue in the same run context.
</details>

### Review ... `/relay-review`

Runs in a **forked context**. The reviewer has no memory of the planning phase, ensuring unbiased evaluation.

The review loops until convergence (most PRs: 1-3 rounds, configurable cap, default 20):

1. **Contract checks** ... Is the implementation faithful to the AC? Any stubs or placeholders?
2. **Rubric verification** ... Re-run automated checks, re-score evaluated factors independently
3. **Scope drift detection** ... Flag out-of-scope changes (creep) and incomplete acceptance criteria (missing)
4. **Quality sweep** ... Structural review, code simplification, churn metric tracking across rounds
5. **Structured verdict** ... JSON verdict with per-issue `file:line`, category, severity

The verdict is posted as a PR comment with a machine-readable marker:

```
Verdict: LGTM           # or
Verdict: ESCALATED      # with specific issues and file:line references
```

If changes are requested, the runner writes a targeted `review-round-N-redispatch.md` for the next executor pass. Repeated issues are fingerprinted across rounds. The same issue recurring 3 consecutive rounds triggers escalation.

### Merge ... `/relay-merge`

Before merging, a **gate check** verifies:
- The relay-review audit trail exists on the PR
- `review.last_reviewed_sha` matches the current PR head (stale review = merge blocked)
- CI checks pass and merge queue is clear

After gate check passes:
1. Merge the PR and mark the manifest `merged`
2. Best-effort close the linked GitHub issue
3. Remove the retained worktree, delete the merged local branch, prune git metadata
4. Record `cleanup.status` in the manifest (failures become explicit follow-up)
5. Update sprint state and create follow-up issues if needed

For hotfixes, `finalize-run.js --skip-review "reason"` bypasses the review gate while recording the skip reason in both the manifest and the PR. There's always a paper trail.

## What You Get vs. Manual AI Coding

| | Manual (copy-paste to AI) | dev-relay |
|---|---|---|
| **Review independence** | Same context, confirmation bias | Fresh context, no planning memory |
| **Audit trail** | Hope you saved the chat | Every round recorded in manifest + PR comments |
| **Scope drift** | Invisible | Detected per-round, flagged in verdict |
| **Convergence** | "Looks good enough" | Loop until rubric passes or escalate |
| **Worktree isolation** | AI edits your working directory | Isolated worktree, your files untouched |
| **Re-dispatch context** | Start over or copy-paste feedback | Prior scores + feedback auto-prepended |
| **Merge safety** | Trust and merge | Gate check: stale review = blocked, CI must pass |
| **Cleanup** | Forget to delete the branch | Worktree + branch + metadata cleaned automatically |

## Real-World Scenarios

### Hotfix: production is down

```bash
/relay-dispatch -b hotfix/null-check -p "Fix NPE in auth.ts:47, null session token" --timeout 600
# Review comes back clean in 1 round
/relay-merge 128   # finalize-run.js --skip-review "hotfix: production 500s"
```

Skip review is recorded in the audit trail. You'll see it later.

### Complex feature: 6 acceptance criteria

```bash
/relay-plan 42                    # Builds rubric with 3-anchor scoring, stress-tests for gaps
/relay-dispatch -b feat/search    # Executor self-evaluates against rubric
/relay-review feat/search         # Reviewer re-scores independently, scope drift check
# Round 1: changes_requested (missing edge case)
/relay-dispatch --run-id ...      # Iteration history auto-prepended
/relay-review feat/search         # Round 2: LGTM
/relay-merge 130
```

### Batch dispatch: 3 independent tasks

```bash
# Dispatch all three in parallel
/relay-dispatch -b fix/typo-1 -p "Fix typo in header"
/relay-dispatch -b fix/typo-2 -p "Fix typo in footer"  
/relay-dispatch -b feat/badge -p "Add status badge to README"

# Review and merge as they complete
/relay-review fix/typo-1 && /relay-merge 131
/relay-review fix/typo-2 && /relay-merge 132
/relay-review feat/badge && /relay-merge 133
```

Worktree isolation makes parallel dispatch safe. Each executor works in its own directory.

## Extending

dev-relay is designed to support new agents. No framework changes needed.

### Adding a new executor

1. Add an entry to `EXECUTOR_CLI` in `skills/relay-dispatch/scripts/dispatch.js`:
   ```js
   const EXECUTOR_CLI = { codex: "codex", claude: "claude", yourAgent: "your-agent-cli" };
   ```

2. Add an execution branch in the same file to wire up CLI arguments for the new executor

3. Optional: app registration uses `create-worktree.js --register` (executor-agnostic)

### Adding a new reviewer

1. Create `skills/relay-review/scripts/invoke-reviewer-<name>.js`
2. The script receives: `--repo <path> --prompt-file <path> [--model <name>] [--json]`
3. It must write a JSON verdict to stdout matching the schema in `review-schema.js`
4. `review-runner.js` resolves adapters by constructing `invoke-reviewer-<name>.js` from the `--reviewer` flag or manifest role binding

### Role binding

Roles are set at manifest creation time and are immutable for the run:

```yaml
roles:
  orchestrator: codex     # who drives the lifecycle
  executor: codex         # who implements
  reviewer: claude        # who reviews (isolated context)
```

Override the reviewer at review time with `--reviewer` or the `RELAY_REVIEWER` environment variable.

## `.worktreeinclude`

Git worktrees don't include gitignored files (`.env`, config, keys). Add a `.worktreeinclude` file to your project root to auto-copy them into worktrees:

```
# .worktreeinclude
.env
.env.local
config/*.key
```

**Safety:** Only files matching BOTH `.worktreeinclude` AND `.gitignore` are copied. This prevents accidentally including tracked files. Glob patterns are supported. Missing files are silently skipped.

The `--copy-env` and `--copy` dispatch flags work as explicit overrides for one-off cases.

## Reliability and Cleanup

### Stale cleanup

Merged and explicitly closed runs are cleaned by `/relay-merge`. For safety, a repo-local janitor is also available:

```bash
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --older-than 72 --json
```

Close stale non-terminal runs explicitly:

```bash
node skills/relay-dispatch/scripts/close-run.js --repo . --run-id <run-id> --reason "stale"
```

### Reliability scorecard

Aggregate metrics from run history:

```bash
node skills/relay-dispatch/scripts/reliability-report.js --repo .
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
```

Tracks: resume success rate, median review rounds, stale run count, terminal state distribution.

## Works With dev-backlog

dev-relay works standalone. It reads acceptance criteria from GitHub issues or direct input.

For sprint-level orchestration, pair it with [dev-backlog](https://github.com/sungjunlee/dev-backlog):

- **GitHub Issues** define the work (AC, labels, milestones)
- **Sprint files** organize execution (batching, ordering, context, progress)
- **relay** reads from both, updates sprint files at each phase

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| PR as handoff boundary | Clean separation between execution and review; standard GitHub workflow |
| Manifest-backed lifecycle | Roles, state, policy, and review anchors in `~/.relay/runs/`, not transient prompts |
| Fresh-context review | Prevents confirmation bias. The reviewer evaluates the diff, not the plan |
| Rubric-based scoring | Executor self-evaluates during implementation; reviewer re-scores independently |
| Gate check before merge | Every merge has an audit trail; stale reviews block merge |
| Worktree isolation | Executor can't affect your working directory; parallel dispatches are safe |
| Agent-agnostic roles | Executors and reviewers are adapters, not hardcoded. New agents added by convention |
| Scope drift detection | Creep and missing criteria tracked across review rounds, not just eyeballed |
| Stateless by default | No database, no daemon. State lives in manifests, GitHub, and optional sprint files |

## Contributing

Issues and PRs welcome. Please open an issue first for non-trivial changes.

See [Extending](#extending) for how to add new executors and reviewers.

## License

MIT
