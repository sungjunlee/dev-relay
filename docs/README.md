# Documentation Index

Repo-local operator docs and current decisions. Nothing under `docs/` ships
with `npx skills add`; runtime guidance lives under `skills/*/references/`.
Historical files live under [archive/](./archive/) and are evidence only.

## Operator And Policy

| Doc | Purpose |
| --- | --- |
| [workflow-lanes.md](./workflow-lanes.md) | Fast / goal / relay / review-only lane selection |
| [external-tool-workflow.md](./external-tool-workflow.md) | gstack, superpowers, CE around relay (optional) |
| [direct-read-relay-operator-note.md](./direct-read-relay-operator-note.md) | Operate relay from a repo checkout without installed skills |
| [relay-operator-guide.md](./relay-operator-guide.md) | Operator workflow for `/relay`, setup, manual phases, recovery |
| [references/operator-surface.md](../references/operator-surface.md) | Public/internal/optional skill tiers |
| [model-route-policy.md](./model-route-policy.md) | Explicit adapter/model selection via `relay-config` |
| [script-inventory-and-cleanup.md](./script-inventory-and-cleanup.md) | Installed runtime inventory |

## Current Contract

| Doc | Purpose |
| --- | --- |
| [references/architecture.md](../references/architecture.md) | Immutable run, append-only facts, derived actions, recovery |
| [decisions/README.md](./decisions/README.md) | Current ADRs and historical records |
| [contracts/relay-runtime-contracts.v1.json](./contracts/relay-runtime-contracts.v1.json) | Named runtime invariants wired to tests |

## Maintenance Rules

- Keep local agent memory out of the repo.
- Installed skill references must stay self-contained. A file under `skills/`
  must not require `docs/` after install.
- When runtime behavior changes, update `references/architecture.md` first.
- Finished designs, closeouts, and ledgers go under `docs/archive/`. Do not
  leave superseded drafts in this lobby with a banner.
- New post-merge issue mirrors belong under `docs/archive/issues/`.
- Distill a durable invariant into `docs/decisions/`, then treat the source
  mirror as archive evidence.
