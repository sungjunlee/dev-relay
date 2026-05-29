# ADR-0001: Orchestrator Owns Branch Publication and PR Creation

Status: Accepted (issue #198)

## Context

Executors (Codex, Claude, others) run inside sandboxes that may lack the operator's GitHub host credentials, SSH setup, or enterprise `gh` auth. When push and PR creation were executor responsibilities, runs could finish with local commits but no PR — blocking review and merge.

Non-default GitHub hosts amplified the gap: manual "cd worktree && git push && gh pr create" was documented as an operator fallback.

## Decision

After a successful executor exit with at least one commit on the working branch:

1. **Executor scope** stays narrow: edit files, commit inside the retained worktree, return `resultPreview`.
2. **`dispatch.js` (orchestrator)** owns publication: detect existing PR via `gh pr list --head`, push with operator shell credentials, create PR only when none exists, persist PR number on the manifest.
3. **Publication failure** is explicit: run moves to `escalated`, error prefixed with `push_or_pr_failed:` — no silent skip.
4. **Manifest fields (current runtime):** write `git.pr_number` after publication; set `github.pr_created_by_orchestrator` when dispatch opened or reused the PR. Review and merge scripts consume `git.pr_number` today. A future convergence may move the anchor under `github.*` without changing the publication boundary.

Host-scoped reviewer auth (#199) is a separate boundary.

## Consequences

- Operators no longer hand-push from the worktree for the default dispatch path.
- Dispatch dry-run and tests inject `pushAndOpenPR` via `execFile` seams — no real network push in unit tests.
- `skills/relay/references/non-default-github-host.md` dispatch-side stopgap is retired; publication uses the same outer shell as dispatch.
- Future work may converge consumers onto `github.pr_number` instead of `git.pr_number`; dispatch does not write `github.pr_number` yet.

## Evidence

- GitHub issue `#198` (post-merge mirror retired after ADR distill)
- Implementation: `skills/relay-dispatch/scripts/dispatch.js`, publication helper extracted for test injection
