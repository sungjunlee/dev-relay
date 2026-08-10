# ADR-0001: Historical Orchestrator Publication and PR Creation

Status: Superseded by [ADR-0007](./0007-review-subject-contract-freeze.md)

This is a historical record of the removed manifest-era dispatch path, not
current runtime authority. For the current boundaries—Publication as exact
remote-ref placement, a separate forge-owned Change Request, and explicit
Landing—see [ADR-0007](./0007-review-subject-contract-freeze.md) and the
[runtime architecture](../../references/architecture.md).

## Context

Executors (Codex, Claude, others) run inside sandboxes that may lack the operator's GitHub host credentials, SSH setup, or enterprise `gh` auth. When push and PR creation were executor responsibilities, runs could finish with local commits but no PR — blocking review and merge.

Non-default GitHub hosts amplified the gap: manual "cd worktree && git push && gh pr create" was documented as an operator fallback.

## Decision

In that removed manifest-era design, after a successful executor exit with at
least one commit on the working branch:

1. **Executor scope** stays narrow: edit files, commit inside the retained worktree, return `resultPreview`.
2. **`dispatch.js` (orchestrator)** owned the then-combined publication/PR path: detect an existing PR via `gh pr list --head`, push with operator shell credentials, create a PR only when none existed, and persist its number on the manifest.
3. **The then-publication failure** was explicit: the run moved to `escalated`, with an error prefixed `push_or_pr_failed:`—no silent skip.
4. **Manifest fields** recorded the PR number and whether the orchestrator created or reused it. Those fields and this dispatch ownership are historical; they are not the current immutable-run contract.

Host-scoped reviewer auth (#199) is a separate boundary.

## Consequences

- The historical design kept executor credentials separate from the outer
  orchestrator.
- Its manifest and dispatch-specific publication machinery were later removed;
  current behavior is documented by ADR-0007 and architecture.

## Evidence

- GitHub issue `#198` (post-merge mirror retired after ADR distill)
- Historical implementation: the removed manifest-era dispatch publication
  helper and its tests.
