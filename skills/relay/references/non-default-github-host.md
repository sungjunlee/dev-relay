---
name: Non-default GitHub hosts (stopgap)
status: stopgap
related-issues: "#198, #199"
delete-when: "#198 and #199 are both closed"
---

# Running relay against non-default GitHub hosts

> **This page is a stopgap.** It documents manual workarounds for two bugs
> that land unreliably on any repo whose `origin` is not `github.com`
> (GitHub Enterprise, self-hosted GitHub). Delete this page in the same PR
> that closes **both** [#198](https://github.com/sungjunlee/dev-relay/issues/198)
> and [#199](https://github.com/sungjunlee/dev-relay/issues/199).

## Background

Relay makes `gh` and `git push` calls in two places:

1. Inside the **executor subprocess** (e.g., Codex CLI, Claude CLI) during
   `relay-dispatch`, which currently runs `git push -u origin <branch>` and
   `gh pr create` from the executor's sandbox.
2. Inside the **outer orchestrator shell** during `relay-review`, which
   runs `gh api user` to record `reviewer_login` on the manifest.

On `github.com` repos both calls succeed silently. On non-default hosts
both can fail in ways that are easy to miss.

## Symptom 1 — executor push fails silently, no PR opens

`relay-dispatch` completes, the commit exists in the worktree, but no PR
is created. The orchestrator sees `status: "completed"` but `gh pr list
--head <branch>` is empty.

Root cause: the executor sandbox cannot reach the repo's GitHub host.
Typical observations:

- `Could not resolve host: <host>` from inside the executor run log.
- `gh auth status -h <host>` inside the sandbox reports the host token
  invalid, even though the outer shell is authenticated.

**Workaround (manual push from outer shell):**

```bash
# Find the worktree path from the run manifest or dispatch output.
cd <worktree-path>
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<title>" --body "<body>"
```

Update the manifest with the resulting PR number if downstream steps
require it. Tracked in [#198](https://github.com/sungjunlee/dev-relay/issues/198);
the structural fix moves push + PR creation into `dispatch.js` in the
outer shell.

The `skills/relay-dispatch/SKILL.md` troubleshooting table already has a
row for this — `"No PR created → Check git log in worktree; push
manually or re-dispatch."`. That row is load-bearing for non-default
hosts until #198 lands.

## Symptom 2 — gate-check rejects PR as `unauthorized_reviewer`

After `relay-review` posts its verdict comment, `relay-merge`'s
`gate-check.js` refuses the PR with:

```
✗ PR #<NN>: relay-review comment found but from unauthorized author
  (expected: <default-host-login>)
```

Root cause: `skills/relay-review/scripts/review-runner.js::getGhLogin()`
currently calls `gh api user` with no `--hostname`, so it records the
operator's **default-host** login (typically the personal `github.com`
account) into `review.reviewer_login`. `gate-check.js` then compares
this against the PR comment author, who is the actual **repo-host**
account — so they don't match.

**Workaround (edit manifest before gate-check):**

```bash
# Find the right login for the repo's host.
gh api user --hostname <repo-host> --jq .login

# Edit the manifest and set reviewer_login to that value.
$EDITOR ~/.relay/runs/<slug>/<run-id>.md
# ... update review.reviewer_login, save ...

# Then re-run gate-check and merge as usual.
```

Tracked in [#199](https://github.com/sungjunlee/dev-relay/issues/199).
The fix resolves the host from `git remote get-url origin` and passes
`--hostname` into `gh api user`, so `reviewer_login` lines up with the
PR comment author by construction.

### Secondary concern: cross-account leak

When the default-host identity is a **personal** account and the repo
is a **work / enterprise** repo (or vice versa), the current behavior
also writes a personal identity into artifacts scoped to a work repo.
Operators enforcing account separation should use the Symptom 2
workaround even when gate-check happens to pass.

## Preferred pre-run workarounds

Set up the outer shell so the default host matches the repo before
invoking relay. Both remove Symptom 2 (Symptom 1 still needs #198):

- `export GH_HOST=<host>` in the shell that invokes relay.
- `gh auth switch --hostname <host>` before invoking relay (if multiple
  hosts are configured).

Either of these makes `gh api user` (no `--hostname`) return the right
login, so `reviewer_login` lands correctly on the manifest without
manual edits.

## When to delete this page

Delete this file in the PR that closes both:

- [#198 — move branch push + PR creation from executor to orchestrator](https://github.com/sungjunlee/dev-relay/issues/198)
- [#199 — getGhLogin() should pass --hostname derived from repo's remote](https://github.com/sungjunlee/dev-relay/issues/199)

Also remove the links that point at this file from
`skills/relay-dispatch/SKILL.md` and `skills/relay-review/SKILL.md` in
the same PR.
