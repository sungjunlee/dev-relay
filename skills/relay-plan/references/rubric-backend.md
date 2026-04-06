# Rubric — Backend

Metrics a senior backend engineer actually checks. Not "does the API return 200" but "what happens at 3 AM when the database is slow and traffic spikes."

## Automated Checks

| Factor | Command | Target | Why it matters |
|--------|---------|--------|---------------|
| Correctness | `npm test` or project test command | exit 0 | Table stakes. But test *what* — happy path alone is a false sense of safety. |
| Query count per request | `grep -c 'SELECT\|INSERT\|UPDATE' <test-log>` or ORM query logger | ≤ N (define per endpoint) | N+1 is the #1 performance killer in every ORM codebase. Measure it, don't guess. |
| Response time | `curl -w '%{time_total}' -so /dev/null <endpoint>` | p95 < 200ms (or project SLA) | Measure the endpoint you changed, not just "tests pass." A 2s response that passes tests still ruins UX. |
| Migration safety | `psql -c '\d <table>'` schema check or migration dry-run | No destructive changes without plan | A column rename in production is a deploy-order bomb. Check before it's live. |
| No secrets in code | `npx gitleaks detect --no-git` or `grep -rn 'API_KEY\|SECRET' src/` | 0 findings | One leaked key in git history lives forever. Check on every commit, not every quarter. |

## Evaluated Factors

These separate "it works" from "it works in production at scale under failure."

### Failure mode design (target: ≥ 8/10)

Everything fails. The question is how.

- **Graceful degradation**: When a downstream service is slow (not down — *slow*), does your code timeout and serve a partial response? Or does it hold the connection and cascade the slowness to every caller?
- **Retry strategy**: Retries without backoff + jitter are a DDoS against your own infrastructure. Retries on non-idempotent operations are data corruption. Does the code know the difference?
- **Circuit breaking**: After N failures, does the code stop trying and fail fast? Or does every request wait for a timeout on a service that's clearly down?
- **Error messages**: Does the error tell the *caller* what they can do? "Internal server error" helps nobody. "Service X is temporarily unavailable, retry after 30s" is actionable.

Scoring guide:
- **low**: No timeouts on external calls, retry-on-everything, errors swallowed silently, cascading failures possible.
- **mid**: Timeouts on external calls, basic retry exists but without backoff/jitter or idempotency awareness.
- **high**: All four criteria met — graceful degradation, idempotency-aware retry with backoff, circuit breaking, actionable error messages.
- **fix_hint**:
  - low→mid: Add timeout (default 5s) to every external HTTP/DB call; gate retries behind an idempotency check
  - mid→high: Add exponential backoff with jitter to retries; wrap downstream calls in a circuit breaker (open after 3 consecutive failures); return structured error with caller-actionable message

### Data integrity (target: ≥ 8/10)

The database outlives every other part of your system. Treat it accordingly.

- **Transactions at the right boundary**: Is the unit of work atomic? A user signup that creates an account but fails to create the profile leaves an orphan. The whole thing should succeed or fail together.
- **Idempotency**: If the same request arrives twice (network retry, user double-click), does it produce the same result? Or does it create two orders, send two emails, charge twice?
- **Constraint enforcement**: Business rules in application code alone are a suggestion. Unique constraints, foreign keys, NOT NULL — the database should be the last line of defense, not the only line.
- **Query plan stability**: Does your query perform the same at 100 rows and 10M rows? An index scan that degrades to a full table scan under growth is a time bomb. Check `EXPLAIN` on new queries.

Scoring guide:
- **low**: No database constraints backing application validations, no idempotency keys on mutations, transactions missing on multi-step operations.
- **mid**: DB constraints on critical fields, transactions on obvious multi-step ops, but idempotency not considered for mutation endpoints.
- **high**: Constraints + transactions + idempotency keys on all mutations, query plans checked for new queries at scale.
- **fix_hint**:
  - low→mid: Add UNIQUE/NOT NULL/FK constraints to critical fields; wrap multi-step mutations in a transaction
  - mid→high: Add idempotency key header to all mutation endpoints; run EXPLAIN on new queries with expected production row counts

### Resource discipline (target: ≥ 7/10)

Your code runs on shared infrastructure. Be a good neighbor.

- **Connection management**: Are database/Redis/HTTP connections pooled and bounded? A leak under load exhausts the pool and brings down everything, not just your service.
- **Memory proportionality**: Does memory usage grow with input size? Loading a 10MB CSV into memory to count rows is a choice — usually the wrong one. Stream when you can.
- **Work proportionality**: Are you doing work the caller didn't ask for? Fetching 50 columns when the endpoint needs 3. Computing aggregates that get cached but never invalidated. Every wasted cycle is latency and cost.
- **Background offloading**: Is the HTTP response waiting for email delivery, webhook dispatch, or log shipping? If the caller doesn't need the result, don't make them wait for it.

Scoring guide:
- **low**: Unbounded queries (no LIMIT), full-table loads into memory, synchronous side effects in request path, no connection pooling.
- **mid**: Connection pooling in place, queries bounded, but background offloading not considered; memory grows linearly with input.
- **high**: Pooled + bounded + streamed where appropriate, side effects offloaded, work proportional to what the caller asked for.

### API contract clarity (target: ≥ 7/10)

Your API is a promise. Breaking it is expensive.

- **Consistent naming and structure**: If one endpoint returns `created_at` and another returns `createdAt`, consumers will write defensive code and curse your name.
- **Error schema**: Errors should be as structured as success responses. A JSON API that returns HTML on 500 breaks every client parser.
- **Pagination by default**: Any list endpoint without pagination is a production incident waiting for enough data.
- **Versioning awareness**: If this change breaks existing callers, is that intentional and communicated? If not, it shouldn't ship.

Scoring guide:
- **low**: Inconsistent field naming, errors as plaintext, unbounded list responses, breaking changes without versioning.
- **mid**: Consistent naming and structured error schema, but no pagination or versioning awareness.
- **high**: All four criteria met — consistent, structured, paginated, versioning-aware. Contract is predictable and safe.

## Tool → Automated Check Mapping

If the executor environment has these tools, consider converting evaluated factors to automated:

| Tool | Automated check | Replaces evaluated |
|------|----------------|-------------------|
| Jest / Vitest / pytest | `npm test` or `pytest` → exit 0 | Correctness (partial) |
| Playwright / Cypress | `npx playwright test` → exit 0 | E2E integration flows |
| gitleaks | `npx gitleaks detect --no-git` → 0 findings | Secrets in code |
| eslint + security plugins | `npx eslint --max-warnings 0` → exit 0 | Code quality baseline |
| k6 / autocannon | `k6 run load-test.js` → p95 < threshold | Response time under load |
| `/browse` skill | Hit endpoints, verify response structure | API contract clarity (partial) |
