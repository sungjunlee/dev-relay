# Documentation Index

Repo-local design notes, operator workflow docs, audit ledgers, and archived issue evidence. Nothing under `docs/` ships with `npx skills add`; runtime guidance lives under `skills/*/references/`.

## Operator And Policy

| Doc | Purpose |
| --- | --- |
| [workflow-lanes.md](./workflow-lanes.md) | Fast / goal / relay / review-only / sidecar lane selection |
| [external-tool-workflow.md](./external-tool-workflow.md) | gstack, superpowers, CE around relay (optional) |
| [direct-read-relay-operator-note.md](./direct-read-relay-operator-note.md) | Operate relay from a repo checkout without installed skills |
| [relay-operator-guide.md](./relay-operator-guide.md) | Operator workflow for `/relay`, setup, manual phases, sidecars, batch dispatch, recovery, and extension points |
| [model-route-policy.md](./model-route-policy.md) | Provider/model route policy via `relay-config` (`~/.relay/policy.json`) — company defaults, personal opt-in, routing rules, advisory reviewers, sidecars |
| [reviewer-policy-opencode.md](./reviewer-policy-opencode.md) | OpenCode trust boundary and review policy |
| [script-inventory-and-cleanup.md](./script-inventory-and-cleanup.md) | Runtime script classification and cleanup backlog |

## Architecture Decisions

Distilled ADRs (current rules):

| Doc | Purpose |
| --- | --- |
| [decisions/README.md](./decisions/README.md) | ADR index — orchestrator publication, manifest slices, worktree runtime, review-runner facade, rubric policy, merge-gate contention |

Specialized ledgers (not ADRs): [rubric-fail-closed-history.md](./rubric-fail-closed-history.md), [relay-resolver-audit-history.md](./relay-resolver-audit-history.md).

## Design And Roadmaps

| Doc | Purpose |
| --- | --- |
| [references/architecture.md](../references/architecture.md) | **Canonical** manifest schema, state machine, events (prefer over legacy design draft) |
| [relay-lifecycle-manifest-design.md](./relay-lifecycle-manifest-design.md) | 2026-04 design history (#34–#46); superseded for runtime paths |
| [relay-ready-routing-and-handoff-design.md](./relay-ready-routing-and-handoff-design.md) | relay-ready intake routing (#127–#132) |
| [relay-scenario-tests.md](./relay-scenario-tests.md) | Scenario-test matrix for lifecycle and reporting |
| [agentic-patterns-adoption.md](./agentic-patterns-adoption.md) | Willison-pattern adoption roadmap (Phase 0 complete) |

## Analysis And Validation

| Doc | Purpose |
| --- | --- |
| [codex-app-server-analysis.md](./codex-app-server-analysis.md) | Codex app-server vs `codex exec` (RELAY-32/33 input) |
| [codex-orchestrator-e2e-validation-2026-04-03.md](./codex-orchestrator-e2e-validation-2026-04-03.md) | Direct-read relay E2E validation report |

## Rubric And Review History

| Doc | Purpose |
| --- | --- |
| [rubric-fail-closed-history.md](./rubric-fail-closed-history.md) | Fail-closed rubric incident ledger (distilled in `skills/relay-plan/references/rubric-fail-closed-patterns.md`) |
| [relay-resolver-audit-history.md](./relay-resolver-audit-history.md) | Resolver selector/call-site audit lineage |

## Archive

Historical epics, dispatch plans, issue evidence mirrors, and research live under [archive/](./archive/). Issue mirrors: [archive/issues/](./archive/issues/).

## Maintenance Rules

- Keep local agent memory out of the repo. Durable lessons belong in `docs/` history files or compact `skills/*/references/` guidance.
- Historical issue evidence may quote orchestrator-local `memory/*` paths or absolute host paths. Treat those as incident context, not files to recreate.
- Keep installed skill references self-contained. A file under `skills/` must not require `docs/` after install.
- New post-merge issue mirrors belong under `docs/archive/issues/`, not `docs/` root.
- When a mirror encodes a durable invariant, add or update an ADR under `docs/decisions/`, then delete the mirror once the ADR (or a specialized ledger) holds the rule.
- Keep mirrors while audit tables or grep proof are not yet distilled. Sprint logs and PR bodies may still cite old paths.
- When runtime behavior changes, update `references/architecture.md` first; add a supersede banner to older design drafts rather than deleting them.
