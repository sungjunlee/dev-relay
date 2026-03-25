---
name: dev-relay
description: Relay development tasks between Claude Code (planner/reviewer) and Codex (executor). Claude plans and writes a contract prompt, Codex implements with self-review and creates a PR, then Claude does an independent review before merging. Use for delegating implementation, sprint batch execution, or plan-dispatch-evaluate workflows.
version: 0.6.0
triggers:
  - "run in codex"
  - "dispatch to codex"
  - "relay"
  - "worktree"
  - "evaluate"
  - "until LGTM"
  - "codex에서 실행"
  - "워크트리"
---

# Dev Relay

Relay development work between Claude Code (brain) and Codex (hands).

## Principles

1. **Codex does the heavy lifting** — implement + self-review + fix + PR, all in one session
2. **Claude reviews with fresh eyes** — independent, bias-free, after Codex creates a PR
3. **Quota-aware** — maximize Codex work, minimize Claude review turns
4. **PR is the handoff boundary** — Codex delivers a PR; Claude reviews, merges, and handles follow-up

## Process

```
Claude Code                         Codex
  │                                    │
  ├─ 1. Plan + Contract               │
  │                                    │
  └─ 2. Dispatch ──────────────────→   │
                                       ├─ Implement
                                       ├─ Self-review + fix (iterate until solid)
                                       ├─ Run tests
                                       └─ Create PR (do NOT merge)
  ├─ 3. Verify dispatch success        │
  │    (check status, confirm PR)      │
  │                                    │
  ├─ 4. PR Review  ←──────────────────┘
  │    (fresh context, independent)
  │
  ├─ 5a. Issues → Codex fixes PR → re-review
  │
  ├─ 5b. LGTM →
  │    ├─ Merge PR
  │    ├─ Close related issues
  │    └─ Create follow-up issues if needed
  │
  └─ 6. Next task
```

## 1. Plan + Contract

Write a prompt with Done Criteria, codebase context, self-review instructions, and PR creation:

```markdown
Implement OAuth2 PKCE flow for the /auth endpoint.

## Context
- Entry point: src/routes/auth.ts
- Follow the pattern in src/routes/github-oauth.ts
- Dependencies available: passport-oauth2, jose (already installed)
- Related issue: #42

## Done Criteria
- /auth/login returns redirect URL with code_challenge
- /auth/callback exchanges code for tokens
- Tokens stored in httpOnly cookies, NOT localStorage
- Existing /api/* endpoints unchanged
- Tests pass

## After Implementation
Review your own work against the Done Criteria above.
Check for:
- Missing requirements or edge cases
- Unnecessary complexity (can anything be simpler?)
- Stubs, TODOs, placeholder returns, or mock data left behind
- Bugs, security issues (especially auth/token handling)
- Code style consistency with the existing codebase

Run the test suite. Fix failures. Repeat review-fix until solid.

## When Satisfied
Create a PR referencing #42 (e.g., "Refs #42") with a clear description.
Do NOT merge — leave open for review.
```

### Why each section matters

| Section | Purpose |
|---|---|
| **Context** | Points Codex to relevant files, patterns, and deps (it cannot explore the whole codebase) |
| **Done Criteria** | The contract — basis for both self-review and Claude's independent review |
| **After Implementation** | Self-review loop instruction — runs inside Codex's session where context and quota are abundant |
| **When Satisfied** | PR as handoff point — leaves merge authority to Claude |

## 2. Dispatch

```bash
# Foreground (blocking — simple tasks)
./scripts/dispatch.js . -b feature-auth -p "..." --copy-env

# Background (non-blocking — Claude continues working)
Bash(run_in_background=true):
  ./scripts/dispatch.js . -b feature-auth --prompt-file TASK.md --copy-env --json --timeout 3600
```

### Timeout guidance

| Task type | Timeout | Rationale |
|---|---|---|
| Simple implementation | `1800` (default) | No self-review needed |
| With self-review loop | `3600` | Codex iterates 2-3 times |
| Complex / multi-file | `5400` | Deep implementation + thorough self-review |

## 3. Verify Dispatch Success

Before proceeding to PR review, confirm Codex succeeded:

```bash
# Check dispatch result (JSON output includes status field)
# status: "completed" → proceed to PR review
# status: "failed" → check error, decide: re-dispatch with adjusted prompt or fix manually

# Verify PR exists
gh pr list --head <branch> --json number,url,title
```

### Handling Failures

| Failure | Action |
|---|---|
| Timeout | Increase `--timeout` or split task into smaller pieces |
| Codex error (non-zero exit) | Read result file for error details; fix prompt and re-dispatch |
| No commits made | Prompt was unclear or task was impossible; revise and re-dispatch |
| No PR created | Codex may have committed but not pushed PR; check `git log` in worktree |
| Branch conflicts | Resolve in worktree or create fresh worktree from updated main |

## 4. PR Review (Claude Code)

Get the PR diff and review in a **fresh Agent context**:

```bash
# Get PR info
PR_NUM=$(gh pr list --head <branch> --json number -q '.[0].number')
gh pr diff $PR_NUM > /tmp/pr-diff.txt
```

```
Agent(description="Independent PR review", prompt="
  You are reviewing code you did NOT write. Be objective.

  ## Contract (Done Criteria)
  - /auth/login returns redirect URL with code_challenge
  - /auth/callback exchanges code for tokens
  - Tokens stored in httpOnly cookies, NOT localStorage
  - Existing /api/* endpoints unchanged
  - Tests pass

  ## PR Diff
  [contents of /tmp/pr-diff.txt]

  Review for:
  1. Faithfulness — verify each Done Criteria item is met
  2. Stubs/placeholders — check for return null, empty bodies, TODO, mock data
  3. Simplification — unnecessary complexity, over-abstraction
  4. Quality — bugs, security, performance
  5. Integration — does it break callers/consumers of changed code?

  Reply: LGTM or specific issues with file:line references.
")
```

Why fresh context:
- No planning bias ("there was probably a reason for this")
- Judges only against the contract
- Codex already self-reviewed, so this catches only what Codex missed

## 5. Iterate or Merge

**Issues found** — targeted fix dispatch to Codex:
```bash
./scripts/dispatch.js . -b feature-auth \
  -p "Fix these issues in the PR: [specific issues with file:line].
      Do not change anything else. Push to the same branch."
```
Then re-review the PR. Max 2 rounds.

**LGTM** — Claude handles post-merge:
```bash
gh pr merge $PR_NUM --squash
gh issue close <number> -c "Resolved in PR #$PR_NUM"
# Create follow-up issues if discovered during review:
gh issue create --title "Follow-up: ..." --body "..."
```

Claude handles merge and issue management because it has sprint-level context for accurate follow-up decisions.

## Scripts

### `scripts/dispatch.js` — Worktree + Codex exec in one step

```bash
./scripts/dispatch.js <repo> -b <branch> -p <prompt> [options]
./scripts/dispatch.js <repo> -b <branch> --prompt-file <path> [options]
```

| Flag | Description |
|---|---|
| `--branch, -b` | Branch name (required) |
| `--prompt, -p` | Task prompt (include Context + Done Criteria + self-review) |
| `--prompt-file` | Read prompt from file (for large prompts) |
| `--model, -m` | Codex model override |
| `--sandbox` | `workspace-write` (default) or `read-only` |
| `--copy-env` | Copy `.env` to worktree |
| `--copy <files>` | Additional files to copy |
| `--timeout` | Timeout in seconds (default: 1800) |
| `--dry-run` | Show plan without executing |
| `--json` | Structured JSON output (for background dispatch) |

Creates worktree in `~/.codex/worktrees/` → runs `codex exec` → collects result.
Exits with non-zero code on failure.

### `scripts/register-worktree.js` — Worktree only (no exec)

For manual Codex App usage without dispatching a task.

```bash
./scripts/register-worktree.js <repo> -b <branch> [--register] [--pin]
```

## Background & Parallel

### Background dispatch

```
Bash(run_in_background=true):
  ./scripts/dispatch.js . -b task-42 --prompt-file tasks/42.md --json --timeout 3600
# Claude plans next task, reviews docs, talks to user...
# TaskOutput fires when Codex finishes → Claude verifies + reviews the PR
```

### Parallel dispatch (independent tasks)

```
# Single message, multiple background calls:
Bash(run_in_background=true):
  ./scripts/dispatch.js . -b task-42 --prompt-file tasks/42.md --json
Bash(run_in_background=true):
  ./scripts/dispatch.js . -b task-43 --prompt-file tasks/43.md --json
# Each completes independently → Claude reviews each PR
```

## Integration with dev-backlog

dev-relay is stateless — all progress tracking lives in the **dev-backlog sprint file**.

```
dev-backlog                         dev-relay
  Sprint file                         dispatch.js
  ├── Batch 1: #38, #39    →        parallel background dispatch
  │   (issue AC = Done Criteria)      (prompt includes Context + AC + self-review + create PR)
  │                         ←        Codex done: PRs created
  │                                  Claude: verify success → review each PR
  │                                    Issues → targeted fix → re-review
  │                                    LGTM → merge + close issues + follow-ups
  ├── Batch 2: #42          →        dispatch → PR → review → merge
  └── Sprint complete                 update sprint file
```

### Pre-Dispatch: Sprint File → Dispatch Prompt

Before dispatching, Claude reads the sprint file and task files to construct the prompt:

```
1. Read sprint file → find next unchecked batch
2. For each issue in the batch:
   a. Read task file (backlog/tasks/<issue-number>.md)
   b. Extract Acceptance Criteria (AC) → becomes Done Criteria in prompt
   c. Read codebase for Context (relevant files, patterns, deps)
   d. Construct dispatch prompt using the Prompt Template
3. Dispatch: ./scripts/dispatch.js . -b issue-<number> -p "..." --copy-env
```

**AC → Done Criteria mapping:**
The task file's `## Acceptance Criteria` checkboxes become the dispatch prompt's `## Done Criteria` section verbatim. If AC says `- [ ] Rate limiter returns 429 after 100 req/min`, the Done Criteria says `- Rate limiter returns 429 after 100 req/min`.

**Branch naming convention:**
Use `issue-<number>` for sprint tasks (e.g., `issue-38`, `issue-39`). This keeps branches traceable to GitHub issues and avoids conflicts between parallel dispatches.

### Post-Merge: Close the Loop

After merging a PR, Claude also updates local task state (dev-backlog convention):

```bash
# 1. Merge PR + close GitHub issue (dev-relay)
gh pr merge $PR_NUM --squash
gh issue close <number> -c "Resolved in PR #$PR_NUM"

# 2. Update task file status (dev-backlog)
# In backlog/tasks/<number>.md: set status: Done in frontmatter

# 3. Update sprint file (see below)

# 4. Create follow-up issues if needed
gh issue create --title "Follow-up: ..." --body "..."
```

### Sprint File Updates During Relay

After each dispatch-review-merge cycle, Claude updates the sprint file:

**Plan section** — check off completed items:
```markdown
### Batch 1 — Core auth (~2hr)
- [x] #38 OAuth2 flow
- [x] #39 Rate limiting
- [ ] #42 Input validation
```

**Progress section** — log what happened with timestamps and PR links:
```markdown
## Progress
- 2026-03-25 10:00: #38 dispatched → PR #45 created
- 2026-03-25 10:35: #38 PR reviewed, 1 issue found → re-dispatched
- 2026-03-25 10:50: #38 PR LGTM → merged. Follow-up #51 created (token refresh edge case)
- 2026-03-25 11:00: #39 dispatched → PR #46 created
- 2026-03-25 11:40: #39 PR LGTM → merged
```

**Running Context section** — capture learnings for remaining tasks:
```markdown
## Running Context
- OAuth2: PKCE flow using jose library. Tokens in httpOnly cookies.
- Rate limiting: in-memory approach for now (no Redis). May need to revisit for #42.
- The auth middleware in src/middleware/auth.ts was refactored — downstream tasks should reference the new pattern.
```

### Why Sprint File, Not a Separate Relay Log

| Option | Verdict | Reason |
|---|---|---|
| Sprint file (dev-backlog) | **Use this** | Already has Plan/Progress/Running Context structure; one source of truth |
| agents.log (codex-orchestrator style) | Not needed yet | Useful for multi-Claude parallel sessions; overkill for single session |
| Separate relay state file | Avoid | Creates two sources of truth; sprint file already tracks everything |

The sprint file serves as both the **planning document** and the **execution journal**. dev-relay reads it (to know what to dispatch) and Claude updates it (after each merge). No additional state files needed.

## Prompt Template

```markdown
[What to implement]

## Context
- Relevant files: [entry points, related modules]
- Patterns to follow: [e.g., "see src/auth/github.js for the OAuth pattern"]
- Dependencies available: [e.g., "passport-oauth2 already installed"]
- Related issue: #N

## Done Criteria
- [Specific, verifiable items]
- [What should change]
- [What should NOT change — scope boundary]
- Tests pass

## After Implementation
Review your own work against the Done Criteria.
Check for:
- Missing requirements or edge cases
- Unnecessary complexity (can anything be simpler?)
- Stubs, TODOs, placeholder returns, or mock data left behind
- Bugs, security issues, edge cases
- Code style consistency with the existing codebase

Run tests. Fix failures. Repeat review-fix until solid.

## When Satisfied
Create a PR referencing #N with a clear description.
Do NOT merge — leave open for review.
```

## Evaluate Criteria

See `references/evaluate-criteria.md` for the full review checklist.

Summary:
- **Phase A (Faithfulness):** Each Done Criteria item verified 1:1 against the diff
- **Phase B (Quality):** Classify findings as "re-dispatch immediately" or "ask user first"
- **Rule:** If a senior engineer would apply without discussion → re-dispatch immediately. If reasonable engineers could disagree → ask.

## Caveats

- **Timeout**: Use `--timeout 3600`+ when self-review is included
- **App restart**: Codex App needs restart to show new worktree threads
- **Fresh context for review**: Always use Agent() — reviewing in the planning session introduces bias
- **Targeted re-dispatch**: "Fix this specific issue" not "redo everything"
- **Max iterations**: Cap at 2 re-dispatches after Claude review to prevent loops
- **Exit codes**: dispatch.js exits non-zero on failure — check before proceeding to review

## Mandatory Checklist

Before dispatching:

1. [ ] Prompt includes Context section (relevant files, patterns, deps)
2. [ ] Prompt includes concrete Done Criteria (specific, verifiable)
3. [ ] Prompt includes "After Implementation" self-review + "Run tests" instruction
4. [ ] Prompt ends with "Create a PR, Do NOT merge"
5. [ ] `--timeout` set appropriately (1800/3600/5400 based on complexity)
6. [ ] `--copy-env` used if the project needs `.env`

After dispatch completes:

7. [ ] Dispatch status is "completed" (check JSON output or exit code)
8. [ ] PR exists (`gh pr list --head <branch>`)

When reviewing the PR:

9. [ ] Review uses Agent() with isolated context (not inline in planning session)
10. [ ] Each Done Criteria item checked against the diff
11. [ ] Checked for stubs/TODOs/placeholder returns
12. [ ] Re-dispatch specifies file:line and "do not change anything else"

## Future

- `scripts/cleanup.js` — Remove worktree + branch after merge
- Prompt generator — auto-create dispatch prompt from GitHub issue AC
- Sprint batch runner — read dev-backlog sprint file, dispatch all tasks
- Worktree overlay — write task-specific AGENTS.md into worktree before dispatch
- Hook-based auto-review — trigger independent review when dispatch completes
