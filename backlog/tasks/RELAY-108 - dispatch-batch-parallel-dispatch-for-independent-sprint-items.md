---
id: RELAY-108
title: 'dispatch: batch parallel dispatch for independent sprint items'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Dispatch multiple independent sprint items to N worktrees simultaneously, reducing total execution time for batches with no inter-task dependencies.

## Background

Currently relay-dispatch processes one task at a time in a single worktree. When a sprint batch contains independent items (no shared file modifications), they could run in parallel. The worktree infrastructure (`create-worktree.js`, `cleanup-worktrees.js`) already exists, making the extension cost low.

Community evidence shows that parallel worktree patterns (e.g., 16 parallel rule-fixers producing 16 PRs from a single command) are practical and deliver significant throughput gains.

## Proposed Behavior

```
Sprint Plan:
- [ ] #38 DB schema (~15min)     → worktree-1
- [ ] #39 Seed data (~10min)     → worktree-2  (concurrent)
- [ ] #40 Config update (~10min) → worktree-3  (concurrent)
```

- Auto-detect independent items within the same sprint batch
- `relay-dispatch --batch` or `relay-dispatch --parallel N` flag for concurrent dispatch
- Each worktree gets its own manifest and produces its own PR
- Sprint file updated in bulk after completion (`[ ]` → `[~]` → `[x]`)

## Considerations

- **Dependency detection**: Identify items that may touch the same files (heuristic or explicit annotation)
- **Manifest uniqueness**: Ensure run-id collision is impossible under concurrent creation
- **Executor quota**: Limit concurrent dispatches to respect API rate limits / subscription caps
- **Integration contract**: Extend dev-backlog checkpoint regex patterns for bulk state transitions
- **Failure isolation**: One worktree failure should not block others; partial success should be reportable

## Existing Infrastructure

- `create-worktree.js` — worktree creation + optional app registration
- `cleanup-worktrees.js` — stale worktree pruning
- `relay-manifest.js` — manifest CRUD with state machine
- `relay-events.js` — event journal per run
