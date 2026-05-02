# Task Profile

`task_profile` is relay-plan metadata that makes guidance selection explicit and auditable before dispatch.

```yaml
task_profile:
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
```

## Derivation Inputs

Build the profile from the same planning evidence used for the rubric:

- Done Criteria: infer the work shape, touched domains, and scope boundary.
- probe signal: use available tests, CI, scripts, and detected project tools as evidence for domains and runnable verification, not as automatic commands.
- historical signal: use stuck factors, divergence hotspots, and average rounds to choose stronger working-style guidance when quality convergence has historically taken more rounds.
- task risk: surface trust boundaries, state machines, public APIs, migrations, data loss, prompt contracts, or backward-compatibility concerns as `risk_tags`.

## Planner Boundary

`task_profile` is planner metadata. It may be shown in dispatch artifacts so executors know why guidance was selected, but it is not a reviewer verdict field, manifest role binding, lifecycle state, or merge gate. Correctness still lives in Done Criteria and rubric factors.

The only prompt-visible behavior in this issue is the profile metadata block. Compact guidance pack text, dispatch persistence/events, and reliability analytics are follow-up work.

## Selection Hints

- Code tasks normally select `surgical-change` and `verification-evidence`.
- Documentation tasks select `docs-reader-success`.
- Refactors and quality-risk M+ code tasks select `simplify-pass`.
- Trust-boundary tasks select `trust-boundary` and usually use `execution_mode: fresh-context`.

When `guidance_packs` is empty, relay-plan must leave non-guidance dispatch prompt behavior unchanged.
