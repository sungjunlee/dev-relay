---
name: relay
description: Relay development work between Claude Code (planner/reviewer) and Codex (executor). Overview of the full dispatch→review→merge cycle. Use when planning to delegate work to Codex, or when you need the prompt template and integration guide. For individual phases, see relay-dispatch, relay-review, relay-merge.
metadata:
  related-skills: dev-backlog, relay-dispatch, relay-review, relay-merge
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

**Phase skills:** `relay-dispatch` (steps 1-3), `relay-review` (step 4-5a), `relay-merge` (step 5b-6)

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

## Integration with dev-backlog

dev-relay is stateless — all progress tracking lives in the **dev-backlog sprint file**.

### Pre-Dispatch: Sprint File → Dispatch Prompt

```
1. Read sprint file → find next unchecked batch
2. For each issue in the batch:
   a. Read task file (backlog/tasks/{PREFIX}-{N} - {Title}.md)
   b. Extract Acceptance Criteria (AC) → becomes Done Criteria in prompt
   c. Read codebase for Context (relevant files, patterns, deps)
   d. Construct dispatch prompt using the Prompt Template above
3. Dispatch via relay-dispatch skill
```

**AC → Done Criteria mapping:**
The task file's `## Acceptance Criteria` checkboxes become the prompt's `## Done Criteria` verbatim.

**Branch naming:** `issue-<number>` for sprint tasks.

### Post-Merge: Close the Loop

After merging, three things happen:

```bash
# 1. GitHub cleanup (relay-merge handles this)
gh pr merge $PR_NUM --squash
gh issue close <number> -c "Resolved in PR #$PR_NUM"
git worktree remove <worktree-path> && git branch -d <branch>

# 2. Sprint file update (the essential part)
# - Plan: check off [x] #N
# - Progress: add timestamped log entry
# - Running Context: add learnings if any

# 3. Follow-up (if needed)
gh issue create --title "Follow-up: ..." --body "..."
```

Task file cleanup (move to `backlog/completed/`) happens at sprint end, not per-issue.

## Mandatory Checklist

Before dispatching:

1. [ ] Prompt includes Context section (relevant files, patterns, deps)
2. [ ] Prompt includes concrete Done Criteria (specific, verifiable)
3. [ ] Prompt includes "After Implementation" self-review + "Run tests" instruction
4. [ ] Prompt ends with "Create a PR, Do NOT merge"
5. [ ] `--timeout` set appropriately (1800/3600/5400 based on complexity)
6. [ ] `--copy-env` used if the project needs `.env`
