# dev-relay

**Delegate implementation to AI agents. Keep planning and review in your hands.**

dev-relay orchestrates the handoff between [Claude Code](https://claude.ai/code) (planner/reviewer) and [Codex](https://chatgpt.com/codex) (executor). You define what to build. Codex builds it in an isolated worktree. Claude reviews the PR with fresh eyes — no planning bias. The result becomes ready to merge after an auditable review trail exists, and merge stays explicit.

```
Claude Code                  Codex                       GitHub
 │                            │                            │
 ├── plan + rubric ──────────►│                            │
 │                            ├── implement ──────────────►│  PR
 │                            │                            │
 ├── review (fresh context) ◄─┤                            │
 │   ├── contract checks      │                            │
 │   ├── rubric verification  │                            │
 │   ├── quality sweep        │                            │
 │   └── issues found? ──────►├── re-dispatch ───────────►│  PR updated
 │                            │                            │
 ├── LGTM ────────────────────────────────────────────────►│  ready_to_merge
 ├── explicit merge ──────────────────────────────────────►│  merged
 └── cleanup + sprint update                               │
```

## Why

AI coding agents are powerful executors but produce better results when given clear scope and independent review. dev-relay codifies this workflow:

- **Separation of concerns** — planning and review stay with you; implementation is delegated
- **Bias-free review** — the reviewer runs in a forked context with no memory of the plan
- **Audit trail** — every merge requires a documented review verdict on the PR
- **Convergence loop** — the reviewer can re-dispatch fixes until the PR meets the rubric, not just eyeball it once

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
- [`gh` CLI](https://cli.github.com/) — authenticated (`gh auth login`)
- Git 2.20+
- Node.js 18+

## Quick Start

### One command — full cycle

```
/relay 42
```

Reads issue #42, builds a scoring rubric if the task is complex, dispatches to Codex in a worktree, reviews the resulting PR, and stops at `ready_to_merge`. Use `/relay-merge` to land it explicitly.

### Step by step

Use individual skills when you want control over each phase:

```bash
/relay-plan 42          # Convert issue AC into a scoring rubric
/relay-dispatch         # Dispatch to Codex (worktree → implement → PR)
/relay-review fix/42    # Review PR in a fresh context
/relay-merge 123        # Gate-check → explicit merge → cleanup
```

## Skills

| Command | Phase | Description |
|---------|-------|-------------|
| `/relay [issue]` | All | Full cycle through `ready_to_merge` |
| `/relay-plan [issue]` | Plan | Build scoring rubric from acceptance criteria |
| `/relay-dispatch` | Execute | Dispatch to Codex via git worktree isolation |
| `/relay-review [branch]` | Review | Independent PR review with convergence loop |
| `/relay-merge [PR]` | Ship | Explicit merge after LGTM, cleanup worktree, update sprint |

## How It Works

### Plan — `/relay-plan`

Converts acceptance criteria into a **scoring rubric** that guides both the executor and the reviewer:

| Rubric element | Example |
|---------------|---------|
| **Automated checks** | `npm test` exits 0, `tsc --noEmit` passes |
| **Evaluated factors** | Code quality 8+, naming consistency 7+, edge cases covered |
| **Weights** | Required (must pass) vs best-effort (nice to have) |

The rubric travels with the task — Codex uses it to self-evaluate, and the reviewer re-scores independently.

> **When to skip:** Typos, one-liner fixes, simple bugs. Use rubrics for 3+ acceptance criteria or quality-sensitive work.

### Dispatch — `/relay-dispatch`

Creates an isolated git worktree, writes a relay run manifest, runs the executor with the task prompt, and collects results.

```bash
# Minimal
/relay-dispatch --branch fix/login-bug --prompt "Fix the null check in auth.ts"

# With rubric and extended timeout
/relay-dispatch --branch feat/search --prompt-file rubric.md --timeout 3600

# Resume the same retained run after review requested changes
/relay-dispatch --run-id issue-42-20260403120000000 --prompt-file review-round-2-redispatch.md

# Dry run — see the plan without executing
/relay-dispatch --branch feat/search --prompt "Add search" --dry-run
```

<details>
<summary>All dispatch options</summary>

| Flag | Description | Default |
|------|-------------|---------|
| `--branch, -b` | Branch name | *required* |
| `--run-id` | Resume an existing retained relay run | — |
| `--manifest` | Resume an existing retained relay run by manifest path | — |
| `--prompt, -p` | Task prompt | *required (or --prompt-file)* |
| `--prompt-file` | Read prompt from file | — |
| `--executor, -e` | Executor type | `codex` |
| `--model, -m` | Model override | — |
| `--sandbox` | `workspace-write` or `read-only` | `workspace-write` |
| `--copy-env` | Copy `.env` to worktree | `false` |
| `--copy` | Additional files to copy (comma-separated) | — |
| `--timeout` | Timeout in seconds | `1800` |
| `--register` | Register in executor app, keep worktree | `false` |
| `--no-cleanup` | Compatibility alias; worktree is already retained by default | `false` |
| `--dry-run` | Print plan, don't execute | `false` |
| `--json` | Structured JSON output | `false` |

**Timeout guidance:** 1800s for simple tasks, 3600s with self-review, 5400s for complex multi-file work.

Dispatch now writes one manifest to `.relay/runs/<run-id>.md` and one append-only history log to `.relay/runs/<run-id>/events.jsonl`. `run_id` is the canonical identity for follow-up review, merge, close, and reporting. JSON output includes `runId`, `manifestPath`, `runState`, and `cleanupPolicy`. A successful first-pass dispatch should usually end in `runState: review_pending`.

Successful dispatches retain their worktree by default so review, follow-up fixes, and manual inspection can continue in the same run context. When a run is resumed from `changes_requested`, dispatch reuses the retained worktree instead of creating a fresh run.

Dispatch, review, and merge helpers now all have run-id-aware entry points. `review-runner.js` reviews the retained checkout for the run, `finalize-run.js` enforces a fresh review at the current HEAD before merge, `close-run.js` explicitly closes abandoned non-terminal runs, `reliability-report.js` derives repo-local reliability metrics from manifests + events, and `cleanup-worktrees.js` acts as a repo-local stale-run janitor.
</details>

### Review — `/relay-review`

Runs in a **forked Agent context** — the reviewer has no memory of the planning phase, ensuring unbiased evaluation.

The review loops until convergence (most PRs: 1–3 rounds, safety cap: 20):

1. **Prompt bundle / invocation** — `review-runner.js --run-id <id> --reviewer codex|claude` can invoke an isolated reviewer directly, or `--prepare-only` writes the diff, done criteria, and round prompt into `.relay/runs/<run-id>/`
2. **Contract checks** — Is the implementation faithful to the AC? Any stubs or placeholders? Security issues?
3. **Rubric verification** — Re-run automated checks, re-score evaluated factors independently
4. **Quality sweep** — Structural review + code simplification pass
5. **Runner apply** — structured verdict JSON is validated, posted to the PR, and written back to the manifest

The final verdict is posted as a PR comment with a machine-readable marker:

```
Verdict: LGTM           # or
Verdict: ESCALATED      # with specific issues and file:line references
```

If changes are requested, the runner also writes a targeted `review-round-N-redispatch.md` artifact for the next worker pass. The runner records `review.last_reviewed_sha`, enforces `review.max_rounds`, fingerprints repeated issues across rounds, and escalates if the same issue repeats three consecutive rounds. When the runner invoked the reviewer itself, it saves `review-round-N-raw-response.txt` for debugging and escalates the run if the reviewer mutated the retained checkout.

### Merge — `/relay-merge`

Before merging, a **gate check** verifies the relay-review audit trail exists on the PR and that `review.last_reviewed_sha` still matches the current PR head. Missing or stale review → merge blocked.

After gate check passes:
1. `finalize-run.js` merges the PR and marks the manifest `merged`
2. It best-effort closes the linked issue
3. It removes the retained worktree, deletes the merged local branch, and prunes git worktree metadata
4. It records `cleanup.status` in the manifest so failures become explicit follow-up
5. Then update sprint state and create any follow-up issues

If cleanup fails because the retained worktree is dirty, the merge still stands, but the manifest stays on `next_action=manual_cleanup_required` instead of silently pretending everything is done.

For hotfixes, `finalize-run.js --skip-review "reason"` keeps one explicit audit path while still recording the merge in the run history.

<details>
<summary>Sprint file state transitions</summary>

```
[ ] Task                           ← not started
[~] Task → PR #M (reviewing)      ← in progress
[x] Task → PR #M (merged)         ← done
```
</details>

<details>
<summary>Gate check escape hatch</summary>

For hotfixes or emergencies, skip the review gate with a documented reason:

```bash
# Writes an audit comment on the PR explaining why review was skipped
gate-check.js 42 --skip "hotfix: production down"
```

The skip is recorded on the PR — there's always a paper trail.
</details>

## `.worktreeinclude`

Git worktrees don't include gitignored files (`.env`, config, keys). Add a `.worktreeinclude` file to your project root to auto-copy them into worktrees:

```
# .worktreeinclude — one pattern per line
.env
.env.local
config/*.key
```

**Safety:** Only files matching BOTH `.worktreeinclude` AND `.gitignore` are copied. This prevents accidentally including tracked files. Glob patterns are supported. Missing files are silently skipped.

The `--copy-env` and `--copy` dispatch flags work as explicit overrides for one-off cases.

## Stale Cleanup

Merged and explicitly closed runs should normally be cleaned by `/relay-merge`, not by dispatch.

For safety, a repo-local janitor is also available:

```bash
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --dry-run
node skills/relay-dispatch/scripts/cleanup-worktrees.js --repo . --older-than 72 --json
```

The janitor reads `.relay/runs/*.md`, cleans only terminal runs by default, and reports stale non-terminal runs without deleting them.

Explicit close path for stale non-terminal runs:

```bash
node skills/relay-dispatch/scripts/close-run.js --repo . --run-id <run-id> --reason "stale_non_terminal_run"
```

Reliability scorecard from raw run history:

```bash
node skills/relay-dispatch/scripts/reliability-report.js --repo .
node skills/relay-dispatch/scripts/reliability-report.js --repo . --json
```

## Works With dev-backlog

dev-relay works standalone — it reads acceptance criteria from GitHub issues or direct input.

For sprint-level orchestration, pair it with [dev-backlog](https://github.com/sungjunlee/dev-backlog):

- **GitHub Issues** define the work (AC, labels, milestones)
- **Sprint files** organize execution (batching, ordering, context, progress)
- **relay** reads from both, updates sprint files at each phase

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| PR as handoff boundary | Clean separation between execution and review; standard GitHub workflow |
| Fresh-context review | Prevents confirmation bias — the reviewer evaluates the diff, not the plan |
| Rubric-based scoring | Codex self-evaluates during execution; reviewer re-scores independently |
| Gate check before merge | Every merge has an audit trail; no silent approvals |
| Worktree isolation | Executor can't affect your working directory; parallel dispatches are safe |
| Stateless by default | No database, no daemon — state lives in GitHub and optional sprint files |

## Contributing

Issues and PRs welcome. Please open an issue first for non-trivial changes.

## License

MIT
