# Issue Evidence Mirrors

Post-merge PR audit mirrors for closed relay work. These files record trust-model audits, consumer call-site tables, grep proof, and deferred-scope inventories from review rubrics. They are historical evidence — not operator docs and not installed with skills.

For active guidance, use [docs/README.md](../../README.md), [docs/decisions/](../../decisions/README.md) (distilled ADRs), and [references/architecture.md](../../../references/architecture.md).

Pre-merge dispatch plans live under [../plans/](../plans/).

**Retention:** When a mirror's durable rules are captured in an ADR (or a specialized ledger such as [relay-resolver-audit-history.md](../../relay-resolver-audit-history.md)), delete the mirror and link the ADR instead. Keep mirrors only while audit tables or grep proof are not yet distilled.

## Mirrors

| File | Issue | Theme |
| --- | --- | --- |
| [issue-87-claude-register.md](./issue-87-claude-register.md) | `#87` | Claude dispatch registration receipt |
| [issue-109-per-agent-model-hints.md](./issue-109-per-agent-model-hints.md) | `#109` | Manifest `model_hints` |
| [issue-139-reliability-report-consumer.md](./issue-139-reliability-report-consumer.md) | `#139` | Phase 0.2 reliability-report consumer |
| [issue-140-probe-signal-consumer.md](./issue-140-probe-signal-consumer.md) | `#140` | Phase 0.3 probe consumer |
| [issue-149-manifest-resolution-audit-2026-04-12.md](./issue-149-manifest-resolution-audit-2026-04-12.md) | `#149` | Manifest resolution consumer audit |
| [issue-160-manifest-path-trust-roots.md](./issue-160-manifest-path-trust-roots.md) | `#160` | Manifest path trust roots |
| [issue-174-resolver-hardening.md](./issue-174-resolver-hardening.md) | `#174` | Resolver hardening (E/R axes) |
| [issue-176-cleanup-worktrees-raw-runid.md](./issue-176-cleanup-worktrees-raw-runid.md) | `#176` | cleanup-worktrees run_id formatting |
| [issue-177-fail-closed-state-validation.md](./issue-177-fail-closed-state-validation.md) | `#177` | Fail-closed state validation (rule 7) |
| [issue-191-resolver-history-and-cli-cleanup.md](./issue-191-resolver-history-and-cli-cleanup.md) | `#191` | Resolver history + CLI helper cleanup |
| [issue-389-codex-sandbox-worktree-admin-dir.md](./issue-389-codex-sandbox-worktree-admin-dir.md) | `#389` | Codex sandbox worktree admin dir |

## Distilled elsewhere (mirrors removed)

| Issue | Current entry point |
| --- | --- |
| `#166`, `#185` | [ADR-0006 merge-gate contention](../../decisions/0006-merge-gate-contention-policy.md) + [rubric-fail-closed-history.md](../../rubric-fail-closed-history.md) |
| `#187` | [ADR-0003 worktree runtime](../../decisions/0003-worktree-runtime-single-owner.md) |
| `#188` | [ADR-0002 manifest slices](../../decisions/0002-manifest-slice-ownership.md) |
| `#189` | [ADR-0004 review-runner facade](../../decisions/0004-review-runner-staged-facade.md) |
| `#190` | [ADR-0005 rubric mandatory](../../decisions/0005-rubric-mandatory-policy.md) |
| `#198` | [ADR-0001 orchestrator publication](../../decisions/0001-orchestrator-owns-publication.md) |
