# Operator Surface Policy

dev-relay is a bundle-installed relay runtime exposed through thin skill command surfaces. The supported install path is the full bundle because the phase skills share manifest storage, event journals, route policy, review anchors, and cross-skill scripts. Per-skill standalone installs are not an operator contract.

## Surface Tiers

| Tier | Skills | Contract |
| --- | --- | --- |
| Public operator surface | `relay-config`, `relay`, `relay-merge` | Normal day-to-day commands. These should read as stable product entrypoints and hide most phase internals. |
| Internal phase surface | `relay-ready`, `relay-plan`, `relay-dispatch`, `relay-review` | Direct controls for advanced operation, debugging, recovery, and explicit manual phase work. They stay callable, but they are not the primary product surface. |
| Optional/advanced surface | `relay-fleet` | Specialized fan-out for already-planned independent leaves. It should point to narrow references rather than expanding the core command surface. |
| Optional/advanced surface | `braid` | v0 experimental, read-only. Decompose one goal into a cheap tree of relay-able leaves and fold relay's durable evidence back up; leaves are driven by ordinary relay. A sibling to the relay skillset (not a relay-* skill), successor to the frozen `relay-orca`. Keep it thin and reference-heavy. |
| Superseded / frozen | `relay-orca` | ⛔ FROZEN 2026-07-24, do not use or invoke. Retired learning-spike program-altitude coordinator; superseded by a decompose-deep/execute-flat successor (in design). Tombstone: [../skills/relay-orca/SUPERSEDED.md](../skills/relay-orca/SUPERSEDED.md); index: [../skills/SUPERSEDED.md](../skills/SUPERSEDED.md). |

## Placement Rules

`SKILL.md` files are decision spines. Keep the trigger, inputs, stop condition, canonical commands, and phase handoff contract there. A user or agent should be able to choose the right next action from the spine without loading a full manual.

`references/` files hold durable operator policy, detailed flow notes, adapter matrices, option semantics, recovery playbooks, and examples that change as the runtime grows. If a detail is likely to change with a model, provider, CLI version, or route-policy rule, put it in a reference first.

Scripts own runtime behavior. State transitions, manifest writes, route selection, adapter invocation, review gates, and cleanup semantics must stay in scripts and tests, not prose-only instructions.

## Update Rule

Model, adapter, and CLI churn should update references and adapter docs before touching a skill spine. Change a `SKILL.md` only when the stable operator decision tree, required input contract, canonical command, or stop boundary changes.

Keep public skills small and explicit. Internal skills may expose more mechanics, but they should still link to references for exhaustive flag tables, adapter specifics, and recovery playbooks.
