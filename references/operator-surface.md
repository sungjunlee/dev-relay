# Operator Surface Policy

dev-relay is a bundle-installed relay runtime exposed through thin skill command surfaces. The supported install path is the full bundle because the phase skills share immutable run records, append-only facts, source-route checks, review anchors, and cross-skill scripts. Per-skill standalone installs are not an operator contract.

## Surface Tiers

| Tier | Skills | Contract |
| --- | --- | --- |
| Public operator surface | `relay-config`, `relay`, `relay-merge` | Normal day-to-day commands. These should read as stable product entrypoints and hide most phase internals. |
| Internal phase surface | `relay-ready`, `relay-plan`, `relay-dispatch`, `relay-review` | Direct controls for advanced operation, debugging, recovery, and explicit manual phase work. They stay callable, but they are not the primary product surface. |
| Optional/advanced surface | `relay-fleet` | Specialized fan-out for already-planned independent leaves. It should point to narrow references rather than expanding the core command surface. |

## Placement Rules

`SKILL.md` files are decision spines. Keep the trigger, inputs, stop condition, canonical commands, and phase handoff contract there. A user or agent should be able to choose the right next action from the spine without loading a full manual.

`references/` files hold durable operator policy, detailed flow notes, adapter matrices, option semantics, recovery playbooks, and examples that change as the runtime grows. If a detail is likely to change with a model, provider, CLI version, or source-route rule, put it in a reference first.

Scripts own runtime behavior. Immutable run creation, source-route selection, adapter invocation, review gates, and cleanup semantics must stay in scripts and tests, not prose-only instructions.

## Source contract

Relay is Git-required and forge-optional. The public route classifies the
checkout before any fetch, forge lookup, worktree, run-directory, or executor
effect. A Git checkout with no remotes uses local Reviewed Result delivery and
does not call GitHub or remote transport. A supported GitHub origin uses the
existing PR/in-flight dedup guard and its explicit GitHub, executor, and
reviewer prerequisites. Other forges fail closed; there is no GitLab adapter.

## Update Rule

Model, adapter, and CLI churn should update references and adapter docs before touching a skill spine. Change a `SKILL.md` only when the stable operator decision tree, required input contract, canonical command, or stop boundary changes.

Keep public skills small and explicit. Internal skills may expose more mechanics, but they should still link to references for exhaustive flag tables, adapter specifics, and recovery playbooks.
