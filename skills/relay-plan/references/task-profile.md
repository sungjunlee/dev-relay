# Task Profile

`task_profile` is relay-plan metadata that makes guidance selection explicit and auditable before dispatch.

Guidance pack names refer to the compact non-binding library in `references/guidance-packs.md`.

```yaml
task_profile:
  task_class: code | design | documentation | operations_security | data_change
  size: S | M | L | XL
  change_type: bugfix | feature | refactor | docs | test | infra | visual | prompt
  domains:
    - relay-plan
    - docs
    - tests
  risk_tags:
    - trust-boundary
    - public-api
    - backward-compatibility
  execution_mode: quick | standard | fresh-context | batch-wave
  guidance_packs:
    - surgical-change
    - verification-evidence
    - user-replay-evidence
```

## Derivation Inputs

Build the profile from the same planning evidence used for the rubric:

- Done Criteria: infer the work shape, touched domains, and scope boundary.
- probe signal: use available tests, CI, scripts, and detected project tools as evidence for domains and runnable verification, not as automatic commands.
- task risk: surface trust boundaries, state machines, public APIs, migrations, data loss, prompt contracts, or backward-compatibility concerns as `risk_tags`.
- calibration class: select the primary observation surface as `task_class`; do not add a second class merely because implementation code is involved.
- readiness route: when the orchestrator's ready-light readiness judgment (per the relay-ready SKILL.md checklist) applies, default to `size: S` and `execution_mode: quick` unless risk tags require stronger review or fresh context.

## Planner Boundary

`task_profile` is planner metadata. It may be shown in dispatch artifacts so executors know why guidance was selected, but it is not a reviewer verdict field, manifest role binding, lifecycle state, or merge gate. Correctness still lives in Done Criteria and rubric factors.

When `guidance_packs` is non-empty, dispatch prompts render both the profile metadata block and a Working Guidance section using the selected pack guidance bullets. Working Guidance is non-binding and must not override Done Criteria, rubric commands, or scope boundaries. Dispatch persistence/events and reliability analytics are separate follow-up work.

## Selection Hints

- Code tasks normally select `surgical-change` and `verification-evidence`.
- Ready-light code tasks should stay S-size, keep binary outcomes in the Outcome Contract, use Verification for evidence, and allow zero Earned Rubric factors.
- Documentation tasks select `docs-reader-success`.
- User-visible product-flow tasks can select `user-replay-evidence` for concise replay notes.
- Refactors and quality-risk M+ code tasks select `simplify-pass`.
- Trust-boundary tasks select `trust-boundary` and usually use `execution_mode: fresh-context`.

When `guidance_packs` is empty, relay-plan must leave non-guidance dispatch prompt behavior unchanged.
