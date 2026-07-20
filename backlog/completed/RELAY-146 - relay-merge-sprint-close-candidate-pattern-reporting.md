---
id: RELAY-146
title: 'relay-merge: sprint-close candidate pattern reporting'
status: To Do
labels:
  - enhancement
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

At sprint close, scan the sprint's run retros for factors scored high (9/10+) across 2+ runs in the same sprint. Report these as candidate patterns for manual promotion to `_context.md`. **No file mutation** — report only.

## Motivation

From `docs/agentic-patterns-adoption.md` Phase 3.1. Originally proposed as auto-append to `_context.md` — Codex correctly flagged: "Many runs produce issue-local fixes, not conventions. Auto-appending creates another stale-review queue."

The narrowed form: terminal report during sprint-close. Human decides what's worth promoting. No dev-backlog contract change.

## Depends On

- **#143** (retrospective integration) — need per-run retro data to aggregate
- **#139** (reliability-report consumption) — aggregation logic lives alongside existing report

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `sprint-close.sh` (dev-backlog) or equivalent entry point scans sprint's completed runs
- [ ] Threshold: factor scored >=9/10 across >=2 runs in the same sprint = candidate
- [ ] Output to terminal: "Candidate patterns this sprint: [list]. Promote manually to _context.md if applicable."
- [ ] No auto-write to `_context.md` or any shared file
- [ ] No dev-backlog integration contract change
- [ ] Tunable threshold via backlog config (floor prevents noise)
<!-- AC:END -->

## Context

- Design doc: `docs/agentic-patterns-adoption.md` Phase 3.1
- Codex: "Replace #5 with sprint-close reporting of candidate patterns, not file mutation."
