# Architecture Decision Records

ADRs here are the **current rule** an operator or contributor should read first,
or a marked historical record of a deleted module. Detailed audit tables from
post-merge mirrors are not retained once distilled.

For the live runtime contract, prefer [`references/architecture.md`](../../references/architecture.md).

## Current

| Record | Decision |
| --- | --- |
| [0007-review-subject-contract-freeze.md](./0007-review-subject-contract-freeze.md) | Derived ReviewSubject; Git-required, forge-optional |
| [2026-08-03-harness-complexity-criterion.md](./2026-08-03-harness-complexity-criterion.md) | What earns its size |
| [2026-08-03-migration-overlay-disposition.md](./2026-08-03-migration-overlay-disposition.md) | Delete the migration overlay; a run dir is claimed by `mkdir` |
| [2026-08-12-trusted-local-execution-contract.md](./2026-08-12-trusted-local-execution-contract.md) | One trusted-local execution path; native isolation when available |

## Historical

These describe deleted modules or retired policy. Do not restore them.
Current behavior is in `references/architecture.md`.

| Record | Was | Source |
| --- | --- | --- |
| [0001-orchestrator-owns-publication.md](./0001-orchestrator-owns-publication.md) | Manifest-era dispatch publication | `#198` |
| [0002-manifest-slice-ownership.md](./0002-manifest-slice-ownership.md) | `manifest/*` slices + `relay-manifest.js` | `#188` |
| [0003-worktree-runtime-single-owner.md](./0003-worktree-runtime-single-owner.md) | `worktree-runtime.js` | `#187` |
| [0004-review-runner-staged-facade.md](./0004-review-runner-staged-facade.md) | `review-runner/` staged helpers | `#189` |
| [0005-rubric-mandatory-policy.md](./0005-rubric-mandatory-policy.md) | Grandfathered rubric bypass retirement | `#190` |
| [0006-merge-gate-contention-policy.md](./0006-merge-gate-contention-policy.md) | Manifest lock-timeout policy split | `#166`, `#185` |
| [2026-07-21-risk-adaptive-observation-window.md](./2026-07-21-risk-adaptive-observation-window.md) | Bounded observation window; retired reporter | `#1036` |

## When to add an ADR

Add or extend an ADR when a merged issue encodes a **durable invariant** that
operators or future refactors must not undo.

Do **not** add an ADR when `references/architecture.md` already carries the
rule, or when the source is a completed closeout that belongs in git history.

Keep ADRs under ~80 lines. Use: **Status**, **Context**, **Decision**,
**Consequences**, **Evidence**.
