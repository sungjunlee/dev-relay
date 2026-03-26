# Evaluate Criteria

> Review checklist for Claude's independent PR review (Step 4 of the dev-relay process).
> The Codex self-review prompt is in SKILL.md's Prompt Template — not duplicated here.

## Phase A: Faithfulness (Contract Check)

For each Done Criteria item in the contract:

| Check | Question |
|---|---|
| Missing requirement | Listed in contract but not implemented? |
| Scope creep | Not in contract but added anyway? |
| Misinterpretation | Requirement interpreted differently than intended? |
| Boundary violation | Areas marked "do not change" were modified? |

Method: Walk through `gh pr diff` and check each contract item 1:1.

## Background: Why Fresh Review Matters

Codex has full implementation context, which paradoxically makes it blind to certain issues:

| Issue | Why Codex misses it |
|---|---|
| Over-complexity | Accumulated incrementally; feels "necessary" to the author |
| Stubs/placeholders | `return null`, `return []`, TODO, empty bodies — author planned to fill but forgot |
| Convention violations | Didn't fully absorb existing codebase style |
| Integration issues | Focused on changed files; didn't check callers/callees |
| Security blind spots | Focused on functionality, not threat modeling |
| Unnecessary deps | "This library makes it easier" — may conflict with project policy |

## Phase B: Quality Checklist

### Re-dispatch immediately (no need to ask user)

| Item | Example |
|---|---|
| Dead code | Unused imports, functions, variables |
| Stale comments | Comments that don't match the code |
| Magic numbers | `if (retries > 3)` → `MAX_RETRIES` constant |
| N+1 queries | DB/API calls inside loops |
| Missing boundary validation | External input not validated |
| Style inconsistency | Naming/patterns that break project conventions |
| Stubs left behind | `return null`, empty function bodies, TODO/FIXME in prod paths |

### Ask user before re-dispatching

| Item | Example |
|---|---|
| Security decisions | Auth approach, XSS defense, encryption choices |
| Design decisions | Architecture changes, API shape changes |
| Large refactors | Changes spanning 20+ lines |
| User-visible behavior | Removing/changing functionality |
| Race conditions | Potential concurrency issues |

**Rule:** If a senior engineer would apply without discussion → re-dispatch immediately.
If reasonable engineers could disagree → ask user first.

Note: Claude does NOT fix code directly — all fixes go through Codex via targeted re-dispatch.
This maintains the PR as the single source of truth for all changes.

## Decision: LGTM vs Re-dispatch

**LGTM when:**
- All Phase A items pass (faithfulness verified)
- No critical security/data issues in Phase B
- No stubs/placeholders remaining
- Remaining issues are nitpick-level (don't block for perfectionism)

**Re-dispatch when:**
- Phase A failure (missing/misunderstood requirement)
- Security or data integrity issue found
- Stubs or placeholder code in production paths
- Structural problem that needs code changes

**Re-dispatch rules:**
- Specify exact file:line references
- State what to fix, not how to fix it
- Include "Do not change anything else"
- Max 2 re-dispatch rounds; escalate to manual review after that
