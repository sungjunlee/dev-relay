# Rubric — Security

Security candidate axes for trust boundaries, secrets, inputs, files, dependencies, and auditability.

> See also: `rubric-trust-model.md` for auth-boundary tasks in the relay runtime itself (manifest anchors, trust roots, gate callsites). That reference adds a distinct enforcement-layer / authentication-factor check on top of this file.

## Candidate Axis Library

Use this file to choose task-relevant rubric axes, not as a template to paste wholesale. For S-size mechanical security-adjacent changes, one contract factor plus hygiene prerequisites is enough unless explicit AC, inferred Done Criteria, or concrete risk introduce real trust-boundary judgment.

## Hygiene Prerequisites

Use only when they apply to any PR in the repo:

| Check | Example command | Target |
|---|---|---|
| Secret scan | `npx gitleaks detect --no-git` or repo equivalent | 0 findings |
| Dependency audit | `npm audit --audit-level=high` or ecosystem equivalent | no new high/critical issue |
| Security lint | project security lint command | exit 0 |

## Contract Axes

Use when they verify a specific Done Criteria item:

| Axis | Example command | Target |
|---|---|---|
| Input validation | targeted tests for malformed/hostile input | invalid input rejected safely |
| Auth gate present | targeted test or static check at callsite | unauthorized path blocked |
| Secret not persisted | `rg '<secret pattern>' <changed paths>` | 0 leaked values |
| Path handling | symlink/traversal fixture test | unsafe path rejected |

## Quality Axes

Pick only axes earned by the task:

| Axis | What to inspect | High-score shape |
|---|---|---|
| Trust boundary discipline | source of truth, authorization point, caller assumptions | untrusted claims are verified at the gate |
| Data exposure control | logs, errors, artifacts, PR comments | sensitive values are redacted or absent |
| File/dependency safety | symlink behavior, temp files, subprocess args, package trust | file and dependency inputs fail closed |
| Auditability | events, reason strings, operator evidence | security-relevant decisions are traceable |

## Tool Mapping

Prefer targeted security tests, gitleaks, dependency audit tools, static checks for dangerous APIs, and explicit path traversal/symlink fixtures.
