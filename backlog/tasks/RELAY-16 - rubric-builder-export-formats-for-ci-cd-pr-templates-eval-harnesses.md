---
id: RELAY-16
title: 'rubric-builder: export formats for CI/CD, PR templates, eval harnesses'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Summary

Support multiple export formats beyond relay-dispatch YAML — CI pipeline checks, PR review templates, standalone eval harnesses.

## Motivation

Rubrics are useful beyond Codex dispatch. Teams want the same quality criteria enforced in CI (automated checks as pipeline steps), PR reviews (evaluated factors as reviewer checklist), and standalone eval runs.

## Possible Formats

- **relay-dispatch YAML** (current): for Codex autonomous iteration
- **GitHub Actions workflow**: automated checks as CI steps, evaluated factors as PR comment
- **PR template**: factors as reviewer checklist with scoring guide
- **promptfoo config**: for systematic eval harness testing
- **Standalone script**: bash/node script that runs all checks and outputs a score report

## Context

- Research doc: `docs/rubric-builder-research.md`
- Part of Phase 2 (standalone rubric-builder skill)
