# append-learnings.js — post-merge learning writer

`finalize-run.js` invokes `append-learnings.js` after the merge state advances to `MERGED` and before cleanup runs. It writes a one-line entry into the matching capability's `## Learnings` block in the target repo's `spec/capabilities.md`.

## Structural contract

The script is the only writer for that section (anti-adversarial-Goodhart structural defense — see the dev-backlog spec-system v0.1 design doc). `component:` in the owning sprint frontmatter is one primary routing handle, not prose.

## Ownership resolution

`sprint-owner.js` is the shared seam (`finalize-run` today; `relay-fleet` #957 later). Precedence:

1. Explicit owner object / manifest `ownership` (`sprint` | `track` | `component`) — fleet injection point
2. CLI `--sprint <path>`
3. CLI `--track <slug>` **or** `--component <slug>` (mutually exclusive on the CLI). When both appear on an injected owner object they must resolve to the same sprint; component is the sprint-state selector and track is verified afterward.
4. Structured issue-body metadata line `component: <slug>` (leading `key: value` lines only; incidental prose is ignored)
5. Exactly-one-active sprint fallback

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
- required `sprint-state.js` dependency missing, schema too old, or ambiguous JSON

## Durability

Learnings are committed through an **isolated git transaction**:

1. Fresh `fetch` of the remote default/base branch after the PR merges
2. Detached temporary worktree at that tip
3. Bounded `spec/capabilities.md` append + commit inside the worktree
4. `git push <remote> HEAD:refs/heads/<base>` with bounded non-fast-forward rebase retry
5. Always remove the temporary worktree

The operator's canonical checkout is never switched, committed, or dirtied. A dirty or unrelated local branch is observationally irrelevant. Genuine conflicts or exhausted retries surface as `result.learnings.durability.reason` (`push_conflict` / `push_failed`) without blocking cleanup.

Any learning failure is recorded under `result.learnings` and does not block cleanup.
