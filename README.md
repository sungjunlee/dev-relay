# dev-relay

Relay development work between [Claude Code](https://claude.ai/code) (planner/reviewer) and [Codex](https://chatgpt.com/codex) (executor).

You plan and review. Codex does the heavy lifting. A PR is the handoff boundary.

```
You (Claude Code)          Codex (worktree)          GitHub
 │                          │                         │
 ├─ plan + rubric ─────────►│                         │
 │                          ├─ implement ────────────►│ PR created
 │◄─────────────────────────┤                         │
 ├─ review (fresh context) ─┤                         │
 │  └─ fix issues? ────────►├─ re-dispatch ──────────►│ PR updated
 │                          │                         │
 ├─ LGTM ──────────────────────────────────────────►│ merged
 └─ cleanup + sprint update                           │
```

## Install

```bash
npx skills add sungjunlee/dev-relay
```

This installs all 5 skills. Add `-g -y` for global install without prompts:

```bash
npx skills add sungjunlee/dev-relay -g -y
```

From a local clone:

```bash
npx skills add . -g -y
```

## Skills

| Skill | Command | What it does |
|-------|---------|--------------|
| **relay** | `/relay [issue]` | Full cycle — plan, dispatch, review, merge |
| **relay-plan** | `/relay-plan [issue]` | Build scoring rubric from acceptance criteria |
| **relay-dispatch** | `/relay-dispatch` | Dispatch to Codex via worktree isolation |
| **relay-review** | `/relay-review [branch]` | Independent PR review with convergence loop |
| **relay-merge** | `/relay-merge [PR]` | Merge after LGTM, cleanup, update sprint file |

## Quick Start

### Full cycle (most common)

```
/relay 42
```

Reads issue #42, builds a rubric if needed, dispatches to Codex, reviews the PR, and merges on LGTM. One command, end to end.

### Step by step

```bash
/relay-plan 42          # Build rubric from issue AC
/relay-dispatch         # Dispatch to Codex (creates worktree + PR)
/relay-review fix/42    # Review the PR in fresh context
/relay-merge 123        # Merge PR #123 after LGTM
```

Each skill works independently — use the full cycle or pick the phase you need.

## How It Works

### 1. Plan (`/relay-plan`)

Converts acceptance criteria into a **scoring rubric** with:

- **Automated checks** — commands that return exit 0/1 (tests, lint, type-check)
- **Evaluated factors** — agent scores 1–10 (code quality, naming, edge cases)
- **Weights** — required vs best-effort

Skip for simple tasks (typos, one-liners). Use for 3+ AC items or quality-sensitive work.

### 2. Dispatch (`/relay-dispatch`)

Creates an isolated git worktree, runs Codex with the task prompt, and collects results.

```bash
# The dispatch script supports these options:
--branch, -b <name>       # Branch name (required)
--prompt, -p <text>       # Task prompt (or --prompt-file <path>)
--executor, -e <type>     # Executor (default: codex)
--model, -m <model>       # Model override
--sandbox <mode>          # workspace-write | read-only
--copy-env                # Copy .env to worktree
--copy <files>            # Additional files to copy (comma-separated)
--timeout <seconds>       # Default: 1800 (30 min)
--register                # Register in executor app (keeps worktree)
--no-cleanup              # Keep worktree after success
--dry-run                 # Show plan without executing
--json                    # Structured JSON output
```

**Timeout guidance:**

| Task type | Timeout |
|-----------|---------|
| Simple (bug fix, small feature) | 1800s (default) |
| With self-review loop | 3600s |
| Complex (multi-file, rubric-driven) | 5400s |

### 3. Review (`/relay-review`)

Runs in a **forked Agent context** — no planning bias, fresh eyes on the diff.

The review loops until convergence (most PRs: 1–3 rounds, safety cap: 20):

1. **Contract checks** — faithfulness to AC, no stubs, no security issues
2. **Rubric verification** — re-run automated checks, re-score evaluated factors
3. **Quality checks** — runs `/review` + `/simplify`
4. **Drift detection** — catches scope creep or stuck loops

Verdict is posted as a PR comment: **LGTM** or **ESCALATED** (with specific issues).

If issues are found, the reviewer can re-dispatch Codex with targeted fix instructions.

### 4. Merge (`/relay-merge`)

Before merging, a **gate check** verifies the relay-review audit trail exists on the PR.

Then:
- Merge PR + close linked issue
- Update sprint file (if using [dev-backlog](https://github.com/sungjunlee/dev-backlog))
- Create follow-up issues if needed
- Auto-cleanup worktree and remote branch

**Sprint file state transitions:**

```
[ ] Task                           ← not started
[~] Task → PR #M (reviewing)      ← in progress
[x] Task → PR #M (merged)         ← done
```

The gate check has an escape hatch for hotfixes:

```bash
# Skip review with documented reason (writes audit comment on PR)
gate-check.js 42 --skip "hotfix: production down"
```

## `.worktreeinclude`

Gitignored files (`.env`, config, keys) don't exist in worktrees. Add a `.worktreeinclude` in your project root to auto-copy them:

```
# .worktreeinclude
.env
.env.local
config/*.key
```

**Rules:**
- Only files matching BOTH `.worktreeinclude` AND `.gitignore` are copied (safety gate)
- Glob patterns supported
- Missing files are silently skipped
- `--copy-env` and `--copy` flags work as explicit overrides

## Integration with dev-backlog

dev-relay works standalone, but pairs with [dev-backlog](https://github.com/sungjunlee/dev-backlog) for sprint-level orchestration:

- **Issues** define the work (acceptance criteria, labels, milestones)
- **Sprint files** organize execution (batching, ordering, context, progress)
- **relay** reads from both, updates sprint files at each phase

Without dev-backlog, relay reads AC directly from GitHub issues or user input.

## Requirements

- [Claude Code](https://claude.ai/code) or [Codex](https://chatgpt.com/codex)
- [`gh` CLI](https://cli.github.com/) (authenticated)
- Git
- Node.js 18+

## License

MIT
