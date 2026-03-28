---
name: relay
argument-hint: "[issue-number or task description]"
description: Route relay workflow between Claude Code and Codex. Determines whether to use relay-plan or dispatch directly, then guides through the plan-dispatch-review-merge cycle. Use when delegating work to Codex, codex에서 실행, 워크트리, relay.
compatibility: Requires Claude Code or Codex, gh CLI, git, and Node.js 18+.
metadata:
  related-skills: "relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
---

# Dev Relay

Relay development work between Claude Code (brain) and Codex (hands).

## Quick Start

When asked to relay a task to Codex:

1. **Simple task** (bug fix, typo, 1-2 AC items) → use base template from `references/prompt-template.md` → **relay-dispatch** directly
2. **Substantial task** (3+ AC items, quality-sensitive) → **relay-plan** (build rubric) → **relay-dispatch**
3. After dispatch completes → **relay-review** (fresh context PR review)
4. LGTM → **relay-merge** (merge + cleanup + sprint file update)

## Process

```
Claude Code                         Codex
  │                                    │
  ├─ 1. Plan + Rubric (relay-plan)     │
  │    or base template (simple tasks) │
  │                                    │
  └─ 2. Dispatch (relay-dispatch) ──→  │
                                       ├─ Implement + score rubric
                                       ├─ LOOP: fix lowest → re-score
                                       └─ Create PR with Score Log
  ├─ 3. Review (relay-review) ←───────┘
  │    (re-score + /simplify + /review)
  │
  ├─ 4a. Issues → re-dispatch → re-review (max 2)
  ├─ 4b. LGTM → Merge (relay-merge)
  │
  └─ 5. Next task
```

## Script Path

All scripts live in the **relay-dispatch** skill directory. When invoking from another skill, use a relative path from the calling skill's directory:
```bash
# From relay-plan or other sibling skills:
${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/dispatch.js . -b issue-42 --prompt-file /tmp/dispatch-42.md --timeout 3600
```

## Integration with dev-backlog

dev-relay is stateless — all progress tracking lives in the dev-backlog sprint file.

**Pre-Dispatch flow:**
1. Read sprint file → find next unchecked batch
2. For each issue: read task file → relay-plan (or base template) → relay-dispatch
3. After merge: relay-merge updates sprint file

**AC → Done Criteria:** Task file's `## Acceptance Criteria` checkboxes become Done Criteria verbatim.

**Branch naming:** `issue-<number>` for sprint tasks.
