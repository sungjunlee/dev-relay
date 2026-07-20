---
id: RELAY-809
title: 'dispatch.js from a linked worktree records base_branch that does not exist on origin'
status: Done
labels:
  - bug
  - priority:high
  - workflow
priority: high
milestone: Route Config Simplification
created_date: '2026-07-06'
---
## Description

Dispatching from a linked local worktree can record a local-only `worktree-*` branch as `base_branch`, causing PR creation or later base-merge work to fail even after the executor succeeds.

## Acceptance Criteria

- [x] Linked-worktree dispatch from a local-only `worktree-*` branch records a remote-valid base branch.
- [x] PR creation uses the resolved remote-valid base, not the local-only branch.
- [x] Learnings/durability push paths do not publish `worktree-*` branches as a finalize side effect.
- [x] The behavior is coordinated with #795 so local-ahead and local-only branch rules do not conflict.
- [x] Recovery guidance covers cleanup for stale `origin/worktree-*` branches.

Completion evidence: resolved in PR #865; GitHub issue #809 closed on 2026-07-09.
