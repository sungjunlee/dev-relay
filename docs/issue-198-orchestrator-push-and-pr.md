# Issue #198 — Orchestrator Push + PR Creation

## Summary

`relay-dispatch` now treats branch publication and PR creation as orchestrator-owned host operations instead of executor work. The executor still edits and commits inside the retained worktree, but the outer `dispatch.js` process now checks for fresh commits, publishes the branch from the operator shell, opens or reuses the PR, and persists the PR number on the manifest before handing off to `relay-review`.

This closes the non-default-host failure mode where Codex or Claude could finish the code changes locally but could not resolve the GitHub host or use the operator's authenticated `gh` state from inside the executor sandbox.

## Executor To Orchestrator Move

- Executor responsibility stays narrow: change files, commit in the retained worktree, emit `resultPreview`.
- `dispatch.js` now performs the publication step after a successful executor exit and after confirming `origin/<base>..HEAD` contains at least one commit.
- The orchestrator publication helper checks `gh pr list --head <branch>` first, then runs `git push -u origin <branch>` from the retained worktree, then calls `gh pr create` only when no existing PR already owns that branch.
- Publication failures are no longer silent. `dispatch.js` returns `status: "failed"`, moves the run to `escalated`, and prefixes the surfaced error with `push_or_pr_failed:`.

## Manifest And Result Schema Delta

- `manifest.git.pr_number` stays populated for compatibility with existing review and merge consumers.
- `manifest.github.pr_number` is the new dispatch-owned PR anchor written by the orchestrator.
- `manifest.github.pr_created_by_orchestrator` records whether the PR was created in this dispatch (`true`) or whether an existing PR for the branch was reused (`false`).
- Dispatch JSON output now includes `prNumber` and `prCreatedByUs` so the operator-facing result matches the manifest write.

## Non-Default-Host Migration Note

- The old operator fallback for GitHub Enterprise and self-hosted GitHub was: keep the retained worktree, `cd` into it, then run `git push -u origin <branch>` and `gh pr create` manually from the outer shell.
- After #198, that manual publication step is retired. Publication now happens in the same outer shell that already has the operator's network path, SSH setup, credential helpers, and `gh` auth for the repo host.
- The stopgap doc at [`skills/relay/references/non-default-github-host.md`](../skills/relay/references/non-default-github-host.md) existed because #198 and the companion review-host issue were separate. #198 removes the dispatch-side half of that stopgap.

## Deferred Follow-Ups For Review And Merge Consumers

- `relay-review` and `relay-merge` still read `git.pr_number`; this change intentionally mirrors the PR number into `git.*` while introducing `github.*` as the dispatcher-owned namespace. Consumer convergence onto `github.pr_number` is deferred.
- The companion review-side host-auth defect was intentionally not bundled into #198: `review-runner` still needed its own host-scoped `gh api user --hostname <host>` fix so `review.reviewer_login` would match the repo host. That follow-up was tracked separately as #199 and landed later in PR #208.
- `gate-check.js` and `finalize-run.js` remain unchanged in this issue except for consuming the now-populated `git.pr_number` field; no review-gate or merge-policy behavior moved into `dispatch.js`.

## Verification

- Direct unit coverage now exercises the extracted `pushAndOpenPR()` helper through its injected `execFile` seam for happy path, existing-PR reuse, push failure, and `gh pr create` failure.
- Dispatch integration coverage still verifies manifest/result persistence and `--dry-run` / no-commit skip behavior, but no test relies on a real local push anymore.
