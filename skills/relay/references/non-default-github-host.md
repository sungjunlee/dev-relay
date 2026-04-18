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

> Update (2026-04-18): [#198](https://github.com/sungjunlee/dev-relay/issues/198)
> is fixed. `relay-dispatch` now handles branch publication and PR creation
> from the orchestrator shell. The remaining stopgap here is issue
> [#199](https://github.com/sungjunlee/dev-relay/issues/199).

## Background

Relay still makes host-sensitive `gh` calls during `relay-review`, where the
outer orchestrator shell records `reviewer_login` on the manifest.

On `github.com` repos this succeeds silently. On non-default hosts the
remaining failure mode is easy to miss unless operators know which layer
still depends on host-scoped auth.

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
invoking relay:

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
