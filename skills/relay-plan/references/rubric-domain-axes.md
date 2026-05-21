## Rubric — Backend

Backend candidate axes for production behavior, data safety, and operational failure modes.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical backend changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real production-design judgment.

### Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Correctness baseline | `npm test`, `pytest`, or project test command | exit 0 |
| Type/lint baseline | project lint/typecheck command | exit 0 |
| Secret scan | `npx gitleaks detect --no-git` or repo equivalent | 0 findings |

### Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example command | Target |
|---|---|---|
| Endpoint response shape | `curl -s <endpoint> | jq <path>` | expected field/value present |
| Query count or N+1 guard | ORM query logger or test log grep | `<= N` for the changed flow |
| Response time | `curl -w '%{time_total}' -so /dev/null <endpoint>` | project SLA or baseline-relative threshold |
| Migration safety | migration dry-run or schema inspection | no unintended destructive change |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Failure mode design | timeouts, retries, fallback, caller-visible errors | failures are bounded, actionable, and do not cascade |
| Data integrity | transaction boundary, constraints, idempotency | multi-step mutations are atomic and retry-safe |
| Resource discipline | bounded queries, streaming, connection use, async side effects | work and memory scale with the request |
| API contract clarity | naming, error schema, pagination, compatibility | consumers get predictable shapes and version-safe changes |

### Tool Mapping

Prefer automated checks when available: unit/integration tests for correctness, k6/autocannon for load, DB `EXPLAIN` for query plans, gitleaks for secrets, and endpoint smoke checks for response contracts.

## Rubric — Frontend

Frontend candidate axes for user-visible behavior, accessibility, responsiveness, and component quality.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical frontend changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real UX or state-management judgment.

### Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Type safety | `npx tsc --noEmit` or project typecheck | exit 0 |
| Lint/format baseline | project lint/format command | exit 0 |
| Unit test baseline | project test command | exit 0 |

### Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example command | Target |
|---|---|---|
| User flow works | `npx playwright test <spec>` | exit 0 |
| Accessibility | `npx axe <url>` or `npx pa11y <url>` | 0 violations for changed surface |
| Layout stability | Lighthouse CLS audit | `<= 0.1` or baseline-relative |
| Bundle budget | `npx size-limit` or `du -b dist/*` | no regression beyond budget |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Interaction fidelity | loading, optimistic updates, errors, transitions | state changes feel intentional and recoverable |
| Information hierarchy | visual weight, progressive disclosure, empty states | primary action and next step are obvious |
| Component boundaries | state ownership, prop flow, abstraction cost | data flow is traceable and abstractions earn their cost |
| Responsive integrity | touch targets, content priority, input modes | mobile is touch-first, not a shrunken desktop |

### Tool Mapping

Prefer Playwright/Cypress for flows, axe/pa11y for accessibility, Lighthouse for performance/layout, visual regression tooling for UI drift, and browser screenshots for responsive checks.

## Rubric — Design & UX

Design candidate axes for product value, usability, visual hierarchy, and polish.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical design changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real product or UX judgment.

### Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| UI tests | project Playwright/Cypress command | exit 0 |
| Accessibility baseline | project axe/pa11y command | exit 0 |
| Visual baseline | visual regression command, if present | no unintended changes |

### Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example check | Target |
|---|---|---|
| Required state exists | screenshot or DOM assertion | state/control is visible and usable |
| Flow completion | Playwright/Cypress scenario | exit 0 |
| Responsive breakpoint | screenshot at named widths | no overflow or blocked action |
| Accessibility affordance | label/role/focus assertion | changed control is reachable |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Value clarity | user goal, primary action, outcome visibility | screen makes the job obvious |
| Usability | task flow, recovery, input effort, state feedback | common workflow is efficient and reversible |
| Hierarchy coherence | spacing, type scale, grouping, contrast | importance is visible without reading everything |
| Delight with restraint | motion, tone, feedback, finish | polish supports the task instead of distracting |

### Tool Mapping

Prefer browser screenshots, Playwright flow checks, accessibility audits, and visual regression tools. Use manual evaluation only for judgment that tools cannot capture.

## Rubric — Documentation

Documentation candidate axes for reader success, maintainability, and executable examples.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical docs changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real reader-success judgment.

### Hygiene Prerequisites

Use only when they apply to any docs PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Markdown lint | `npx markdownlint-cli2 docs/**/*.md` | exit 0 |
| Link baseline | `npx lychee docs/` or repo link check | exit 0 |
| Spelling baseline | `npx cspell docs/` | no new findings or `<= baseline` |

### Contract Axes

Use when they verify the changed document or workflow:

| Axis | Example command | Target |
|---|---|---|
| Links valid | `npx markdown-link-check <file>` | 0 broken links |
| Examples run | extract/run fenced code blocks | exit 0 |
| Referenced artifacts exist | `test -e <path>` or targeted grep | 0 orphan references |
| Required section present | `rg '<heading or token>' <file>` | expected content present |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Zero-context completeness | prerequisites, exact steps, success/failure signs | a new reader can complete the workflow |
| Reader testing | likely questions answerable from the doc alone | core questions have unambiguous answers |
| Information architecture | order, headings, skimmability, why-before-how | readers can scan, then deepen |
| Maintenance resilience | source-of-truth links, version-stable wording, runnable examples | docs resist drift |

### Tool Mapping

Prefer markdown-link-check/lychee for links, markdownlint for structure, cspell/vale for language, and code-block runners for executable examples.

## Rubric — Refactoring

Refactoring candidate axes for behavior preservation, concept reduction, and maintainability.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical refactors, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real design judgment.

### Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Test baseline | project test command | exit 0 |
| Type/lint baseline | project typecheck/lint command | exit 0 |
| Public API check | existing contract tests, if present | exit 0 |

### Contract Axes

Use when they verify behavior preservation or a specific cleanup goal:

| Axis | Example command | Target |
|---|---|---|
| Behavior unchanged | targeted regression tests | exit 0 |
| Dead path removed | `rg '<old symbol>'` | only intentional references remain |
| API compatibility | contract tests or exported symbol check | no unintended break |
| Complexity budget | baseline-relative line/count/complexity check | no regression or explicit improvement |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Concept reduction | number of concepts, branches, helper layers | fewer concepts explain the same behavior |
| Dependency hygiene | coupling, import direction, shared utilities | dependencies move toward clearer ownership |
| Boundary clarity | module responsibilities, data ownership | callers know where behavior lives |
| Deletion discipline | removed code, compatibility shims, duplicate paths | old paths are retired without hidden behavior loss |

### Tool Mapping

Prefer tests for behavior preservation, `rg` for deleted symbols, dependency graph tools for coupling, and baseline-relative complexity checks when available.

## Rubric — Security

Security candidate axes for trust boundaries, secrets, inputs, files, dependencies, and auditability.

> See also: `rubric-trust-model.md` for auth-boundary tasks in the relay runtime itself (manifest anchors, trust roots, gate callsites). That reference adds a distinct enforcement-layer / authentication-factor check on top of this file.

### Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical security-adjacent changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real trust-boundary judgment.

### Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Secret scan | `npx gitleaks detect --no-git` or repo equivalent | 0 findings |
| Dependency audit | `npm audit --audit-level=high` or ecosystem equivalent | no new high/critical issue |
| Security lint | project security lint command | exit 0 |

### Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example command | Target |
|---|---|---|
| Input validation | targeted tests for malformed/hostile input | invalid input rejected safely |
| Auth gate present | targeted test or static check at callsite | unauthorized path blocked |
| Secret not persisted | `rg '<secret pattern>' <changed paths>` | 0 leaked values |
| Path handling | symlink/traversal fixture test | unsafe path rejected |

### Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Trust boundary discipline | source of truth, authorization point, caller assumptions | untrusted claims are verified at the gate |
| Data exposure control | logs, errors, artifacts, PR comments | sensitive values are redacted or absent |
| File/dependency safety | symlink behavior, temp files, subprocess args, package trust | file and dependency inputs fail closed |
| Auditability | events, reason strings, operator evidence | security-relevant decisions are traceable |

### Tool Mapping

Prefer targeted security tests, gitleaks, dependency audit tools, static checks for dangerous APIs, and explicit path traversal/symlink fixtures.
