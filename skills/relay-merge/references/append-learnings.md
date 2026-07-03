# append-learnings.js — post-merge learning writer

`finalize-run.js` invokes `append-learnings.js` after the merge state advances to `MERGED` and before cleanup runs. It writes a one-line entry into the matching capability's `## Learnings` block in the target repo's `spec/capabilities.md`.

## Structural contract

The script is the only writer for that section (anti-adversarial-Goodhart structural defense — see the dev-backlog spec-system v0.1 design doc). `component:` in the active sprint frontmatter is one primary routing handle, not prose.

## No-op conditions (graceful)

- `spec/capabilities.md` is absent in the target repo
- the active sprint has no `component:` key
- the component does not resolve to a capability section

## Fail-loud conditions

- multiple active sprints make the target ambiguous
- `component:` contains multiple comma-separated values

## Durability

When an entry is appended, `finalize-run.js` commits and pushes the change from the target repo's base branch when the repo is clean. Unsafe cases (dirty repo, detached state) are recorded under `result.learnings.durability` as manual actions.

Any learning failure is recorded under `result.learnings` and does not block cleanup.
