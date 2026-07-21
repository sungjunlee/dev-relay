# Issue #954 Multi-Track Integration Closeout

Date: 2026-07-21

## Scope and baseline

This is the repository-only closeout for epic #954. It changes documentation and
backlog state only; no runtime code or GitHub state is changed. The source
checkout started clean with `HEAD == origin/main ==
f7db95bf060672a8c7bfdf05fe9c6d12820b94c8` (`Record relay learning for PR
#1055`). A read-only connected GitHub query independently confirmed that commit
as the current remote `main` head.

GitHub issue #954 and milestone #13 remain an explicit post-merge orchestrator
handoff. The orchestrator owns those external mutations after this closeout
commit merges.

## Merged delivery evidence

Each delivery has all three required evidence layers: a GitHub-authored squash
merge commit reachable from `main`, a terminal relay manifest, and a
`merge_finalize` event followed by successful cleanup.

| Issue / PR | Relay run and manifest evidence | Merge evidence on `main` |
| --- | --- | --- |
| #955 / [PR #1051](https://github.com/sungjunlee/dev-relay/pull/1051) | Run `issue-955-20260720171527060-5631994b`; manifest `state: merged`, `next_action: done`, head `7d443a7525c787075458c1e3f24abc390edb5152`; `merge_finalize` at `2026-07-20T20:48:18.076Z`; cleanup succeeded | GitHub `merged: true` at `2026-07-20T20:48:01Z`; `df0d007d43b0dfa6f2f02ac75992be3f6b946882` — `fix(relay-merge): resolve sprint ownership without canonical-branch dependence (#1051)` |
| #956 / [PR #1052](https://github.com/sungjunlee/dev-relay/pull/1052) | Run `issue-956-20260720204955497-a9eab5cc`; manifest `state: merged`, `next_action: done`, head `f58a0136cbc710825b149fe6da5a661e33716cf9`; `merge_finalize` at `2026-07-20T21:37:52.739Z`; cleanup succeeded | GitHub `merged: true` at `2026-07-20T21:37:46Z`; `fe2d62c8c96b1f973b65153075c0908f8e48e1a8` — `docs(relay): resolve owning sprint for operator updates (#1052)` |
| #957 / [PR #1055](https://github.com/sungjunlee/dev-relay/pull/1055) | Run `issue-957-20260720214029585-15fe71ce`; manifest `state: merged`, `next_action: done`, head `3fc36559768b46913a459e0e2c95930d595facb1`; `merge_finalize` at `2026-07-21T03:49:34.155Z`; cleanup succeeded | GitHub `merged: true` at `2026-07-21T03:49:34Z`; `1d6f3bae66819735efaf002d4121c3a77fae2aba` — `fix: close ownership validation gaps (#1055)` |

The manifests and journals are stored under
`~/.relay/runs/dev-relay-778886da/`. The later learning commits for PRs #1051,
#1052, and #1055 are also reachable from `main`.

## Integration checks

The checks were re-run from the clean baseline before backlog reconciliation.

```text
node --test --test-concurrency=1 tests/relay-merge/scripts/sprint-owner.test.js tests/relay-merge/scripts/append-learnings.test.js
```

Result: PASS — 83 tests, 83 passed, 0 failed, 0 skipped.

```text
node --test --test-concurrency=1 --test-name-pattern='relay-fleet default invocation drives two leaves through review, serial merge, and closes the fleet|relay-fleet rejects missing and mixed ownership before manifest or dispatch side effects|relay-fleet --dry-run fans out to dispatch dry-run without writing a fleet manifest' tests/relay-fleet/scripts/relay-fleet.test.js
```

Result: PASS — 3 tests, 3 passed, 0 failed, 0 skipped.

```text
node --test tests/skills-lint/scripts/*.test.js
```

Result: PASS — 33 tests, 33 passed, 0 failed, 0 skipped.

```text
git diff --check
```

Result: PASS — no output.

`node tests/skills-lint/scripts/skills-lint.test.js` is intentionally not used:
it is not a valid standalone invocation for this suite.

## Verified invariants

- The no-selector `N == 1` fallback remains compatible: exactly one active
  sprint resolves without invoking selector-based discovery.
- Explicit component or track selection resolves through validated dev-backlog
  schema-v2 JSON. Dev-backlog is the ownership source of truth.
- A valid single-track fleet preserves the normalized owner through persisted
  leaves, child manifests, dispatch and redispatch, and the finalize/Learnings
  seam.
- Missing, ambiguous, contradictory, or mixed ownership is rejected before any
  fleet manifest, issue lock, worktree, or executor dispatch side effect.
- Relay has one shared sprint-state seam in
  `skills/relay-dispatch/scripts/sprint-state.js`; it does not contain a second
  track/component markdown parser.

The 83-test standalone/append suite proves selector precedence, schema-v2
validation, issue-component derivation, fleet-owner injection, and the `N == 1`
fallback. The three-test fleet slice proves the successful two-leaf lifecycle,
pre-side-effect rejection, and dry-run non-persistence contract.

## Backlog close path

All four task mirrors were set to `Done` with every acceptance criterion checked,
and all sprint Plan items were checked before running the normal dev-backlog
close path. The source-checkout close command was run first with `--dry-run` and
then without it, using `--track 2026-07-multi-track-sprint-interop` and without
`--close-milestone`. In the reproducible commands below, `DEV_BACKLOG_ROOT`
names a dev-backlog source checkout or installation that contains
`skills/dev-backlog/scripts/`.

```text
bash "$DEV_BACKLOG_ROOT/skills/dev-backlog/scripts/sprint-close.sh" backlog --track 2026-07-multi-track-sprint-interop --dry-run
bash "$DEV_BACKLOG_ROOT/skills/dev-backlog/scripts/sprint-close.sh" backlog --track 2026-07-multi-track-sprint-interop
```

The real close set the sprint to `completed` and moved `RELAY-954`, `RELAY-955`,
`RELAY-956`, and `RELAY-957` from `backlog/tasks/` to
`backlog/completed/`.

## Backlog doctor

The required post-close command was:

```text
node "$DEV_BACKLOG_ROOT/skills/dev-backlog/scripts/backlog-doctor.js" --json backlog
```

The command exited `0` and returned `schema_version: 1` with
`exit_hint: "warn"`:

| Doctor check | Result |
| --- | --- |
| `active_sprint` | Informational WARN — no active sprint among 16 sprint files; normal between sprints |
| `objectives_check` | PASS — no charter, so objective IDs are not enforced |
| `component_lint` | PASS — 16 sprint files checked; every non-empty component resolves |
| `capabilities_doctor` | WARN — existing `dispatch-execution` capability has 18 inline Learnings and recommends retaining the most recent 7 |
| `sprint_shape` | PASS — skipped because no sprint is active |
| `in_flight_trace` | PASS — no active in-flight items |
| `in_flight_staleness` | PASS — no active in-flight items |
| `context_bloat` | PASS — 56 lines, below the 200-line threshold |

The reassess signal fired with one non-informational doctor warning, zero
failures, and 16 completed sprints since the latest report (`latest_report:
null`, threshold 3). The pre-existing capability Learnings warning is unrelated
to #954 and is intentionally not changed by this closeout.
