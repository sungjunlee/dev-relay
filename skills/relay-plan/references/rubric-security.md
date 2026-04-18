# Rubric — Security

Metrics a security-minded engineer actually checks. Not "did we run a scanner" but "did we close the trust boundary this task just opened."

Use this alongside the primary domain rubric when a task touches user input, auth, APIs, file uploads, secrets, or sensitive data. Pull in only the relevant factors for the task; security should sharpen the rubric, not create a separate review phase.

> **See also**: `rubric-trust-model.md` for **auth-boundary** tasks in the relay runtime itself (manifest anchors, trust roots, gate callsites). That reference adds a distinct enforcement-layer / authentication-factor check on top of this file. The two are complementary: this file covers the broad security surface; `rubric-trust-model.md` covers the narrower case where a schema change can preserve a vulnerability under a new shape.

## Prerequisites (Hygiene)

Use this section only for checks that would apply to ANY PR in this repo. They gate the run and do not count toward factor totals.

| Check | Command | Target | Why it matters |
|-------|---------|--------|----------------|
| No hardcoded secrets or credentials in code | `npx gitleaks detect --no-git` or `grep -RIn 'API_KEY\\|SECRET\\|TOKEN\\|PASSWORD' src/ config/` | 0 findings | Secrets checked into source become a permanent incident. Keep this as repo hygiene, not task-specific proof. |
| Dependency audit baseline | `npm audit --omit=dev --audit-level=high` or `osv-scanner --lockfile=<lockfile>` | 0 newly introduced high/critical CVEs in runtime dependencies | Newly added runtime dependencies should be trusted and clean before they ever reach factor scoring. |

## Automated Checks (Contract-tier)

These stay in `factors` because they verify a SPECIFIC AC item is implemented on the changed surface.

| Factor | Tier | Command | Target | Why it matters |
|--------|------|---------|--------|---------------|
| Input validation rejects malformed payloads | `contract` | Send malformed or out-of-policy input to the changed endpoint or form (wrong type, missing required field, unexpected field, HTML/script payload) | `4xx` with field-level validation error; untrusted output is escaped or rejected | Validation belongs at the trust boundary. If malformed input reaches core logic, every downstream layer becomes a sanitizer by accident. |
| Parameterized query path resists injection | `contract` | Exercise search/filter/mutation inputs with payloads like `' OR 1=1 --` while checking query builder/SQL logs or integration tests | Query uses parameterized placeholders/bind parameters; injection payload is treated as data, not code | "Works on happy path" is irrelevant if one interpolated string can widen a query or mutate unintended rows. |
| Auth middleware protects new endpoints | `contract` | Call each new protected endpoint without credentials and with insufficient-role credentials | `401/403` before handler side effects; unauthorized caller cannot reach business logic | New endpoints fail open by default if auth is forgotten once. Catch that in the rubric, not after deploy. |
| File upload path rejects unsafe files | `contract` | Upload oversized files, wrong MIME types, double extensions, or disallowed formats to the new upload path | `4xx`; file is not stored, parsed, or made reachable | Uploads are attacker-controlled binaries. Reject unsafe files before storage or processing. |
| Logs and error responses stay redacted | `contract` | Trigger validation/auth/storage failures and inspect response bodies plus captured logs | No passwords, tokens, cookies, API keys, connection strings, raw PII, or secret-bearing stack traces | Failure paths leak first. A secure happy path with insecure logs is still an incident. |

## Evaluated Factors

These separate "basic protections exist" from "the changed surface is actually defensible."

### Trust boundary discipline (target: ≥ 8/10)

tier: quality

Every new trust boundary is a place where attacker-controlled data tries to become application behavior.

- **Ingress validation is explicit**: Every externally supplied field is validated at the first boundary with schema rules, allowlists, length limits, and type checks. No ad-hoc truthiness checks standing in for validation.
- **Escaping matches the sink**: HTML is escaped in HTML contexts, SQL is delegated to parameterized queries, shell and file path inputs are never string-interpolated, and serialization does not smuggle executable content downstream.
- **Auth is enforced before side effects**: New endpoints attach authentication middleware before handler logic, and authorization scope matches the resource being read or mutated. "Authenticated user" is not enough if tenant or role boundaries are missing.
- **Validation failures are actionable but safe**: Error responses tell the caller which field failed and why without echoing back secrets, raw tokens, stack traces, or internal implementation details.

Scoring guide:
- **low**: Missing schema validation on some inputs, manual string concatenation in queries or rendered output, or a new route can execute handler logic before auth.
- **mid**: Schema validation and auth middleware exist, but escaping is inconsistent, authorization scope is coarse, or some errors still leak raw input/internal details.
- **high**: Validation happens at ingress, escaping is context-appropriate, parameterized queries are used everywhere relevant, auth executes before side effects, and failures are safe plus actionable.

### Secret and data exposure control (target: ≥ 8/10)

tier: quality

Security failures often come from what the code reveals, not just what it accepts.

- **Secrets stay out of source**: No hardcoded credentials, API keys, tokens, connection strings, or private cert material in source, fixtures, examples, or test helpers. Configuration reads from environment or secret storage, with inert local placeholders only where necessary.
- **Logs and errors are redacted by default**: Structured logging drops or masks auth headers, cookies, passwords, tokens, connection strings, and sensitive PII. Error wrappers do not serialize entire request bodies "for debugging."
- **Data access is least-privilege**: The change fetches, returns, and persists only the fields required for the task. Sensitive columns are not added to DTOs, responses, or logs just because they are available.
- **Security-sensitive branches fail closed**: Missing auth context, missing secret configuration, or redaction failures stop the request or job rather than silently continuing in a degraded but unsafe state.

Scoring guide:
- **low**: Secret-like values appear in code or examples, full request bodies or tokens are logged, or sensitive fields are exposed in responses for debugging convenience.
- **mid**: Secrets are externalized and major logs are redacted, but edge-case errors still leak internals or responses over-return sensitive data.
- **high**: No hardcoded secrets remain, redaction is systematic across logs and errors, data exposure is least-privilege, and missing security context causes fail-closed behavior.

### File and dependency safety (target: ≥ 7/10)

tier: quality

Files and third-party packages extend your attack surface faster than almost any other feature.

- **Upload validation is server-side and multi-dimensional**: If the task accepts files, validation checks MIME/type, extension, size, count, and destination before storage or parsing. Client-side checks are only UX.
- **Storage path is non-executable**: Uploaded filenames are normalized or replaced, dangerous extensions are blocked unless explicitly required, and stored files do not land in executable or web-served paths by default.
- **Dependencies are trusted at merge time**: Newly added or upgraded runtime dependencies come from maintained sources and have no known CVEs at the accepted severity threshold. Deferred remediation requires an explicit containment plan, not silence.
- **Risky parsers are constrained**: Image/document/archive processing libraries are pinned, isolated, or moved off the request path when possible so a malformed file cannot monopolize the request worker.

Scoring guide:
- **low**: Upload handling trusts client MIME or filename, stores raw files in a served path, or introduces dependencies with unresolved advisories and no mitigation.
- **mid**: Type/size checks and dependency audit exist, but filename/path handling is weak, parser isolation is not considered, or advisory triage is deferred without containment.
- **high**: Upload surfaces are tightly validated and isolated, runtime dependencies are trusted and clean, and risky parsers are constrained so malformed files cannot easily escalate impact.

## Tool → Automated Check Mapping

If the executor environment has these tools, consider converting evaluated factors to automated:

| Tool | Automated check | Replaces evaluated |
|------|----------------|-------------------|
| gitleaks | `npx gitleaks detect --no-git` → 0 findings | Hardcoded secrets |
| npm audit / pnpm audit / osv-scanner | Dependency audit → 0 known high/critical CVEs in runtime deps | Dependency trust baseline |
| Jest / Vitest / pytest API tests | Invalid input, auth failure, and upload rejection tests → expected `4xx/401/403` | Input validation, auth coverage, upload validation |
| semgrep / eslint security rules | Detect string-built SQL, unsafe interpolation, or secret-like literals → 0 findings | Query injection risk (partial), hardcoded secrets (partial) |
| Playwright / `@playwright/test` | Submit malicious form or upload payloads and assert safe rejection | Trust boundary discipline (partial) |
| `/browse` skill | Exercise auth-gated UI flows and verify sanitized rendering | Auth coverage, escaping behavior (partial) |
