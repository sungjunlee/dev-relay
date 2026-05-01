# Rubric — Backend

Backend candidate axes for production behavior, data safety, and operational failure modes.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical backend changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real production-design judgment.

## Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Correctness baseline | `npm test`, `pytest`, or project test command | exit 0 |
| Type/lint baseline | project lint/typecheck command | exit 0 |
| Secret scan | `npx gitleaks detect --no-git` or repo equivalent | 0 findings |

## Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example command | Target |
|---|---|---|
| Endpoint response shape | `curl -s <endpoint> | jq <path>` | expected field/value present |
| Query count or N+1 guard | ORM query logger or test log grep | `<= N` for the changed flow |
| Response time | `curl -w '%{time_total}' -so /dev/null <endpoint>` | project SLA or baseline-relative threshold |
| Migration safety | migration dry-run or schema inspection | no unintended destructive change |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Failure mode design | timeouts, retries, fallback, caller-visible errors | failures are bounded, actionable, and do not cascade |
| Data integrity | transaction boundary, constraints, idempotency | multi-step mutations are atomic and retry-safe |
| Resource discipline | bounded queries, streaming, connection use, async side effects | work and memory scale with the request |
| API contract clarity | naming, error schema, pagination, compatibility | consumers get predictable shapes and version-safe changes |

## Tool Mapping

Prefer automated checks when available: unit/integration tests for correctness, k6/autocannon for load, DB `EXPLAIN` for query plans, gitleaks for secrets, and endpoint smoke checks for response contracts.
