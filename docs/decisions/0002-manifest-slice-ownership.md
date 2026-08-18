# ADR-0002: Manifest Slice Ownership and Facade

Status: Superseded. The manifest runtime was deleted. Current model:
[architecture.md](../../references/architecture.md).

This record describes the last internal split of the removed
`relay-manifest.js` facade. Do not restore those modules.

## Context

`relay-manifest.js` had grown into a monolith mixing path trust roots, YAML codec, lifecycle transitions, rubric loading, cleanup, attempts, and environment snapshots. Cross-skill imports needed narrow surfaces; refactors risked regressions without a enforced boundary.

## Decision

Split manifest logic into seven slices under `skills/relay-dispatch/scripts/manifest/`:

| Slice | Owns |
| --- | --- |
| `paths` | Relay home, run layout, run-id validation, path trust/containment |
| `store` | Read/write manifest markdown, frontmatter codec |
| `lifecycle` | State machine, `validateTransition`, skeleton creation |
| `rubric` | Rubric path resolution, fail-closed load gates |
| `cleanup` | Worktree/manifest cleanup helpers |
| `attempts` | Dispatch attempt accounting |
| `environment` | Environment snapshot fields |

`relay-manifest.js` is a **re-export-only facade** (≤40 lines, zero function declarations). Runtime code imports direct submodules; compatibility tests and out-of-scope callers (today: `relay-ready/scripts/relay-request.js`) may keep using the facade.

Enforcement: `tests/relay-dispatch/scripts/manifest-direct-imports.test.js`.

## Consequences

- Do not collapse slices back into the facade or force-migrate every facade consumer in one PR — both regress the pinned boundary.
- New manifest concerns get a slice owner; avoid adding logic to the facade.
- `references/architecture.md` documents the facade convention for extenders.

## Evidence

- GitHub issue `#188` (post-merge mirror retired after ADR distill)
- Current runtime: [architecture.md](../../references/architecture.md)
