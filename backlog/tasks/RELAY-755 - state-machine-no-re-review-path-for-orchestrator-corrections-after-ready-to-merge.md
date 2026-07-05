---
id: RELAY-755
title: 'State machine: no re-review path for orchestrator corrections after ready_to_merge'
status: To Do
labels:
  - enhancement
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Problem (hit live on #695 / PR #752, 2026-07-03)

After a run reaches `ready_to_merge`, an orchestrator-correction commit (post-PASS final-check fix) cannot be re-reviewed: `review-runner.js` requires `internal_review_pending` or `review_pending`, and `ALLOWED_TRANSITIONS` offers only `ready_to_merge -> merged | merge_blocked | closed` (`merge_blocked -> ready_to_merge` is a dead loop for this purpose). The fresh-review gate then correctly reports `stale`, and the only path forward is `finalize-run.js --skip-review <reason>` — an audited bypass, not a review.

## Proposal sketch (pick one at design time)

- Allow `ready_to_merge -> review_pending` guarded to head-SHA advancement (i.e. only when the branch moved past `review.reviewed_head_sha`), or
- Give `merge_blocked` a `-> review_pending` edge so gate-stale runs can formally re-enter review.

Either way the transition must go through `validateTransition()` and append a journal event from the existing EVENTS enum (`REVIEW_APPLY` round increment covers the re-review itself; check whether a transition event already fits before adding anything — consumer-first gate applies).

## Acceptance criteria

- An orchestrator correction after `ready_to_merge` can be re-reviewed by `review-runner.js` without manual manifest surgery, and the fresh-review gate passes afterward.
- `--skip-review` remains available as the fallback; its decision-tree docs mention the new path.
- State-machine tests cover the new edge (allowed + still-forbidden reverse cases).

## Non-goals

- No relaxation of the explicit-merge boundary; `ready_to_merge` still stops for the operator.
