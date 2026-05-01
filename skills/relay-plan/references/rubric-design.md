# Rubric — Design & UX

Design candidate axes for product value, usability, visual hierarchy, and polish.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical design changes, one contract factor plus hygiene prerequisites is enough unless the Acceptance Criteria introduce real product or UX judgment.

## Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| UI tests | project Playwright/Cypress command | exit 0 |
| Accessibility baseline | project axe/pa11y command | exit 0 |
| Visual baseline | visual regression command, if present | no unintended changes |

## Contract Axes

Use when they verify a specific AC item:

| Axis | Example check | Target |
|---|---|---|
| Required state exists | screenshot or DOM assertion | state/control is visible and usable |
| Flow completion | Playwright/Cypress scenario | exit 0 |
| Responsive breakpoint | screenshot at named widths | no overflow or blocked action |
| Accessibility affordance | label/role/focus assertion | changed control is reachable |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Value clarity | user goal, primary action, outcome visibility | screen makes the job obvious |
| Usability | task flow, recovery, input effort, state feedback | common workflow is efficient and reversible |
| Hierarchy coherence | spacing, type scale, grouping, contrast | importance is visible without reading everything |
| Delight with restraint | motion, tone, feedback, finish | polish supports the task instead of distracting |

## Tool Mapping

Prefer browser screenshots, Playwright flow checks, accessibility audits, and visual regression tools. Use manual evaluation only for judgment that tools cannot capture.
