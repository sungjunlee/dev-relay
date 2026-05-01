# Rubric — Refactoring

Refactoring candidate axes for behavior preservation, concept reduction, and maintainability.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical refactors, one contract factor plus hygiene prerequisites is enough unless the Acceptance Criteria introduce real design judgment.

## Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Test baseline | project test command | exit 0 |
| Type/lint baseline | project typecheck/lint command | exit 0 |
| Public API check | existing contract tests, if present | exit 0 |

## Contract Axes

Use when they verify behavior preservation or a specific cleanup goal:

| Axis | Example command | Target |
|---|---|---|
| Behavior unchanged | targeted regression tests | exit 0 |
| Dead path removed | `rg '<old symbol>'` | only intentional references remain |
| API compatibility | contract tests or exported symbol check | no unintended break |
| Complexity budget | baseline-relative line/count/complexity check | no regression or explicit improvement |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Concept reduction | number of concepts, branches, helper layers | fewer concepts explain the same behavior |
| Dependency hygiene | coupling, import direction, shared utilities | dependencies move toward clearer ownership |
| Boundary clarity | module responsibilities, data ownership | callers know where behavior lives |
| Deletion discipline | removed code, compatibility shims, duplicate paths | old paths are retired without hidden behavior loss |

## Tool Mapping

Prefer tests for behavior preservation, `rg` for deleted symbols, dependency graph tools for coupling, and baseline-relative complexity checks when available.
