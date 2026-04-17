> **Stopgap notice**: This page documents workarounds for two known bugs.
> Remove this file and the links to it when both [#198](https://github.com/sungjunlee/dev-relay/issues/198) and [#199](https://github.com/sungjunlee/dev-relay/issues/199) are closed.

# Non-default GitHub Hosts

Users running relay against a repository whose origin is **not** `github.com` (GitHub Enterprise, self-hosted GitHub) encounter two silent failure modes.

## Symptom 1 — Executor push fails, no PR created

**What happens**: The executor subprocess finishes with a local commit but exits without opening a PR. The outer shell has network access and a valid token for the host, but the dispatch sandbox does not inherit them.

**Root cause**: Tracked in [#198](https://github.com/sungjunlee/dev-relay/issues/198).

**Workaround**: After dispatch exits without a PR, push and open the PR from the outer shell:

```bash
cd <worktree-path>
git push -u origin <branch>
gh pr create --repo <owner>/<repo>
```

You can find `<worktree-path>` and `<branch>` in the run manifest at `~/.relay/runs/<slug>/<run-id>.md`.

## Symptom 2 — gate-check rejects PR with `unauthorized_reviewer`

**What happens**: `gate-check.js` rejects the PR because `reviewer_login` in the run manifest does not match the authenticated user for the repo's host.

**Root cause**: `review-runner.js` reads `gh`'s *default* host login, not the host-specific login. Tracked in [#199](https://github.com/sungjunlee/dev-relay/issues/199).

**Workaround**: Before running `gate-check.js`, edit the run manifest and set `reviewer_login` to the correct value:

```bash
# Find the correct login for your host
gh api user --hostname <host> --jq .login

# Edit the manifest
MANIFEST=~/.relay/runs/<slug>/<run-id>.md
# Replace reviewer_login: <wrong-value> with the output above
```

## Preferred Pre-run Workarounds

To avoid both symptoms upfront, configure `gh` for the non-default host before invoking relay:

```bash
# Option A: set GH_HOST for the current shell session
export GH_HOST=<host>

# Option B: switch the active gh account to the correct host
gh auth switch --hostname <host>
```

Either option ensures both dispatch and review use the correct host credentials.
