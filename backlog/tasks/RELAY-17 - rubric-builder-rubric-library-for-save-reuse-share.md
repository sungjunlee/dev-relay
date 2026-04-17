---
id: RELAY-17
title: 'rubric-builder: rubric library for save/reuse/share'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Allow users to save and reference past rubrics as inspiration for new task-specific designs.

## Motivation

Good rubric criteria are hard to write. Past rubrics that produced consistent scores and caught real issues are valuable as **design references** — not as reusable templates. The same way domain references (rubric-*.md) provide expert perspective, a personal library of past rubrics provides project-specific perspective.

## Key design constraint

Rubrics are task-specific by design. A "library" should NOT encourage copy-paste reuse. Instead:
- Save past rubrics with their scoring outcomes (did they catch real issues? were scores consistent?)
- Surface relevant past rubrics during Q3 of the guided interview as inspiration
- The user designs new criteria informed by past patterns, not copied from them

## Possible Approach

- Save rubrics to a project-local directory (e.g., `.rubrics/` or alongside sprint files)
- Tag with task type, scoring consistency, and effectiveness notes
- During guided interview, surface relevant past rubrics: "A similar task last month used these criteria with consistent scores"
- Git-friendly format (YAML) for natural versioning

## Context

- Research doc: `docs/rubric-builder-research.md`
- Same relationship as domain references: inspiration, not menus
- Depends on: enough real usage to have rubrics worth saving
