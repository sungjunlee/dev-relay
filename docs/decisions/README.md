# Architecture Decision Records

Distilled, durable decisions extracted from closed relay work. ADRs here are the **current rule** an operator or contributor should read first. Detailed audit tables and grep proof from the original post-merge mirrors are not retained once distilled.

For live schema and state-machine reference, prefer [`references/architecture.md`](../../references/architecture.md). Specialized ledgers that predate this folder remain valid companions:

| Ledger | Scope |
| --- | --- |
| [relay-resolver-audit-history.md](../relay-resolver-audit-history.md) | Resolver selector × call-site audit (#149–#177) |
| [rubric-fail-closed-history.md](../rubric-fail-closed-history.md) | Rubric meta-rules and compliance-theater incidents |

## Index

| ADR | Decision | Source issue(s) |
| --- | --- | --- |
| [0001-orchestrator-owns-publication.md](./0001-orchestrator-owns-publication.md) | Push + PR creation live in dispatch orchestrator, not executor | `#198` |
| [0002-manifest-slice-ownership.md](./0002-manifest-slice-ownership.md) | `manifest/*` slices + thin `relay-manifest.js` facade | `#188` |
| [0003-worktree-runtime-single-owner.md](./0003-worktree-runtime-single-owner.md) | One `worktree-runtime.js` owns plan/create/register/remove | `#187` |
| [0004-review-runner-staged-facade.md](./0004-review-runner-staged-facade.md) | `review-runner/` staged helpers + orchestration facade | `#189` |
| [0005-rubric-mandatory-policy.md](./0005-rubric-mandatory-policy.md) | `anchor.rubric_grandfathered` retired; rubric required | `#190` |
| [0006-merge-gate-contention-policy.md](./0006-merge-gate-contention-policy.md) | Lock timeout policy split by downstream consumer | `#166`, `#185` |

## When to add an ADR

Add or extend an ADR when a merged issue encodes a **durable invariant** (role boundary, fail-closed rule, module ownership) that operators or future refactors must not accidentally undo.

Do **not** duplicate an ADR when:

- The rule already lives in `references/architecture.md` with enough operational detail (e.g. state machine, `model_hints` schema).
- A specialized ledger already carries the distilled rule (resolver, rubric fail-closed).

After an ADR lands, **delete** the post-merge issue mirror if it only duplicated audit evidence. Keep mirrors when grep proof or consumer tables are not yet captured in an ADR or ledger.

## ADR format

Each file uses: **Status**, **Context**, **Decision**, **Consequences**, **Evidence**. Keep ADRs under ~80 lines.
