# append-learnings.js — post-merge learning writer

`append-learnings.js` is an explicit post-merge project update. Relay `finalize-run.js` does not invoke it inside the merge transaction. Run it after finalize returns `status: merged`; it writes a one-line entry into the matching capability's `## Learnings` block in the target repo's `spec/capabilities.md`.

## Structural contract

The script is the only writer for that section (anti-adversarial-Goodhart structural defense — see the dev-backlog spec-system v0.1 design doc). `component:` in the owning sprint frontmatter is one primary routing handle, not prose.

## Ownership resolution

`sprint-owner.js` is the shared seam (`finalize-run` today; `relay-fleet` #957 later). Precedence:

1. Caller/CLI `--sprint <path>`, `--track <slug>`, or `--component <slug>` (operator override; mutually exclusive track/component on the CLI)
2. Injected flat owner `{ sprint, track, component }` — no-flag default when #957 supplies it; never stronger than an explicit caller override
3. Structured issue-body metadata line `component: <slug>` (leading `key: value` lines only; incidental prose is ignored)
4. Exactly-one-active sprint fallback

Within the winning source, contradictory fields are rejected. Losing-source fields must not override or contradict the explicit choice (CLI `component` ignores a fleet `track`, and vice versa).

Every sprint path — explicit, injected, or returned by sprint-state — is normalized against the target repo and must resolve under that repo's `backlog/sprints/` (realpath/symlink containment). Relative paths such as `backlog/sprints/x.md` resolve against the repo root, not `process.cwd()`. Escaping `..` / absolute paths are rejected. A `--track` selector is validated against the returned track identity (slug / optional payload track / component alias), not assumed from basename alone.

Track/component lookups call validated `dev-backlog` `sprint-state.js --track|--component --json` (`schema_version >= 2`). Set `RELAY_SPRINT_STATE_BIN` when the globally installed skill copy is older. Relay does not add a second multi-sprint markdown parser for those lookups.

`multiple_active_sprints` is returned only when more than one sprint is active **and** no explicit or derived owner resolves.

## No-op conditions (graceful)

- `spec/capabilities.md` is absent in the target repo
- the owning sprint has no `component:` key
- the component does not resolve to a capability section
- an entry for this `run-id` already exists (idempotent)

## Fail-loud conditions

- multiple active sprints with no resolvable owner
- contradictory explicit handles
- `component:` contains multiple comma-separated values
- required `sprint-state.js` dependency missing, schema too old, or ambiguous/malformed JSON
- sprint path escapes the target repo's `backlog/sprints/`

## Durability

Learnings are committed through an **isolated git transaction**:

1. Fresh `fetch` of the remote default/base branch after the PR merges
2. Detached temporary worktree at that tip
3. Ownership resolution + dry-run + write **inside that worktree** (never against the operator's canonical checkout)
4. Bounded `spec/capabilities.md` append + commit inside the worktree
5. `git push <remote> HEAD:refs/heads/<base>` with bounded non-fast-forward rebase retry (protected-branch / permission / hook declines are not retried as NFF)
6. Always remove the temporary worktree (best-effort `worktree remove` → rm → `worktree prune`)

`result.learnings.sprintFile` / `owner.sprintPath` report the durable owning sprint under the target repo (for example `<repo>/backlog/sprints/….md`), never the transient `/tmp/relay-learn-*` worktree path.

The operator's canonical checkout is never inspected, switched, committed, or dirtied. Tests assert branch/status/HEAD byte-identity externally before/after finalize. A dirty or unrelated local branch is observationally irrelevant. Genuine conflicts or exhausted retries surface as `result.learnings.durability.reason` (`push_conflict` / `push_failed`) without blocking cleanup.

### Crash recovery / prune

Cleanup is `finally`-scoped and best-effort. Finalize does **not** install process-global `SIGINT`/`SIGTERM` handlers (those can disrupt other finalize cleanup). A crash mid push-retry can leave a `relay-learn-*` directory and a worktree registration under the canonical `.git/worktrees`. Recover with:

```bash
git worktree prune
rm -rf /tmp/relay-learn-*
```

Any learning failure is recorded under `result.learnings` and does not block cleanup.
