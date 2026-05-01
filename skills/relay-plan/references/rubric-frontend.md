# Rubric — Frontend

Frontend candidate axes for user-visible behavior, accessibility, responsiveness, and component quality.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical frontend changes, one contract factor plus hygiene prerequisites is enough unless the Acceptance Criteria introduce real UX or state-management judgment.

## Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Type safety | `npx tsc --noEmit` or project typecheck | exit 0 |
| Lint/format baseline | project lint/format command | exit 0 |
| Unit test baseline | project test command | exit 0 |

## Contract Axes

Use when they verify a specific AC item:

| Axis | Example command | Target |
|---|---|---|
| User flow works | `npx playwright test <spec>` | exit 0 |
| Accessibility | `npx axe <url>` or `npx pa11y <url>` | 0 violations for changed surface |
| Layout stability | Lighthouse CLS audit | `<= 0.1` or baseline-relative |
| Bundle budget | `npx size-limit` or `du -b dist/*` | no regression beyond budget |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Interaction fidelity | loading, optimistic updates, errors, transitions | state changes feel intentional and recoverable |
| Information hierarchy | visual weight, progressive disclosure, empty states | primary action and next step are obvious |
| Component boundaries | state ownership, prop flow, abstraction cost | data flow is traceable and abstractions earn their cost |
| Responsive integrity | touch targets, content priority, input modes | mobile is touch-first, not a shrunken desktop |

## Tool Mapping

Prefer Playwright/Cypress for flows, axe/pa11y for accessibility, Lighthouse for performance/layout, visual regression tooling for UI drift, and browser screenshots for responsive checks.
