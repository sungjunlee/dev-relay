---
id: RELAY-15
title: 'rubric-builder: self-improving rubrics via autoloop'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Apply the autoloop pattern to rubric criteria themselves — iteratively refine how task-specific rubrics are designed based on scoring outcomes.

## Motivation

Even with the guided interview (Q1-Q5), the quality of criteria varies. A rubric that consistently scores 10/10 on mediocre code has weak criteria. A factor that always flags issues nobody cares about is noise. Tracking scoring patterns across dispatches can inform better rubric design.

## What this is NOT

This is not about improving domain reference files. References are inspiration, not templates. This is about improving the **design process** — e.g., "criteria written as X pattern tend to produce more consistent scores than Y pattern."

## Possible Approach

- Track scoring outcomes: which factors actually differentiate good from bad implementations
- Identify criteria patterns that produce high variance (calibration data, if available)
- Surface insights like "factors with concrete count thresholds score more consistently than prose descriptions"
- Feed insights back into the guided interview (e.g., Q3 suggests stronger criteria patterns)

## Context

- Research doc: `docs/rubric-builder-research.md`
- Inspired by: mager.co's "description as learnable parameter" + autoresearch keep/discard
- Depends on: enough real relay-plan usage to have scoring data
