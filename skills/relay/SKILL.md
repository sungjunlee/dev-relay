---
name: relay
description: Overview and reference for the relay skill ecosystem. Describes the full dispatch-review-merge cycle between Claude Code and Codex. For execution, use relay-plan, relay-dispatch, relay-review, or relay-merge directly.
disable-model-invocation: true
metadata:
  related-skills: "relay-plan, relay-dispatch, relay-review, relay-merge, dev-backlog"
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
  ├─ 1. Plan + Rubric (relay-plan)     │
  │    (AC → scored factors)           │
  │                                    │
  └─ 2. Dispatch (relay-dispatch) ──→  │
                                       ├─ Implement
                                       ├─ Score rubric (automated + self-eval)
                                       ├─ LOOP: fix lowest factor → re-score
                                       ├─ All factors converged
                                       └─ Create PR with Score Log
  ├─ 3. Verify dispatch success        │
  │                                    │
  ├─ 4. Review (relay-review) ←───────┘
  │    (re-score rubric + simplify/review skills)
  │
  ├─ 5a. Issues → re-dispatch → re-review
  │
  ├─ 5b. LGTM → Merge (relay-merge)
  │
  └─ 6. Next task
```

## Prompt Template

See `references/prompt-template.md` for the base template. Use **relay-plan** to generate a rubric-enhanced version with automated checks and scored factors.

## Integration with dev-backlog

dev-relay is stateless — all progress tracking lives in the dev-backlog sprint file. See **relay-merge** for the post-merge sprint file update process.

### Pre-Dispatch: Sprint File → Dispatch Prompt

```
1. Read sprint file → find next unchecked batch
2. For each issue in the batch:
   a. Read task file (backlog/tasks/{PREFIX}-{N} - {Title}.md)
   b. Use relay-plan to build rubric from Acceptance Criteria
   c. Dispatch via relay-dispatch
3. After merge: relay-merge updates sprint file
```

**AC → Done Criteria mapping:**
The task file's `## Acceptance Criteria` checkboxes become Done Criteria verbatim.

**Branch naming:** `issue-<number>` for sprint tasks.

## Mandatory Checklist

Before dispatching:

1. [ ] Prompt includes Context section (relevant files, patterns, deps)
2. [ ] Prompt includes concrete Done Criteria (specific, verifiable)
3. [ ] Prompt includes "After Implementation" self-review + "Run tests" instruction
4. [ ] Prompt ends with "Create a PR, Do NOT merge"
5. [ ] `--timeout` set appropriately (1800/3600/5400 based on complexity)
6. [ ] `--copy-env` used if the project needs `.env`
