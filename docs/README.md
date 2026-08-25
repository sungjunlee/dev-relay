# Documentation Index

Repo-local operator docs and current decisions. Nothing under `docs/` ships
with `npx skills add`. Installed playbooks live under `skills/*/references/`.
The live runtime contract is [architecture.md](./architecture.md) (clone-only).
Finished designs stay in git history. Do not recreate `docs/archive/`.

dev-relay is a bundle-installed relay runtime. Install the complete bundle;
phase skills share the dispatch core.

## Operator surface

| Tier | Skills | Contract |
| --- | --- | --- |
| Public operator surface | `relay`, `relay-merge` | Day-to-day entrypoints. |
| Internal phase surface | `relay-ready`, `relay-plan`, `relay-dispatch`, `relay-review` | Advanced, debug, and explicit phase work. |
| Optional/advanced surface | `relay-fleet` | Fan-out for already-planned independent leaves. |

Installed skill files stay self-contained. `SKILL.md` is the spine,
`references/` hold playbooks, and scripts own runtime behavior. A file under
`skills/` must not require `docs/` after install.

## Operator and policy

| Doc | Purpose |
| --- | --- |
| [workflow-lanes.md](./workflow-lanes.md) | Fast / goal / relay / review-only lane selection |
| [relay-operator-guide.md](./relay-operator-guide.md) | Operator workflow, clone path, adapter/model selection |

## Current contract

| Doc | Purpose |
| --- | --- |
| [architecture.md](./architecture.md) | Immutable run, append-only facts, derived actions, recovery |
| [decisions/README.md](./decisions/README.md) | Current ADRs and historical records |
| [contracts/relay-runtime-contracts.v1.json](./contracts/relay-runtime-contracts.v1.json) | Named runtime invariants wired to tests |

## Maintenance

- Keep local agent memory out of the repo.
- When runtime behavior changes, update `docs/architecture.md` first.
- Model, adapter, and CLI churn updates skill `references/` and adapter docs
  before the `SKILL.md` spine. Change a spine only when the decision tree,
  input contract, canonical command, or stop boundary changes.
- Distill a durable invariant into `docs/decisions/`. Do not keep a second
  tree of finished designs, closeouts, or issue mirrors.
