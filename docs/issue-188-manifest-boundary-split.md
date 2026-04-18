# Issue #188 — Manifest Boundary Split

## Summary

`skills/relay-dispatch/scripts/relay-manifest.js` is now a pure re-export facade over seven narrower modules in [`skills/relay-dispatch/scripts/manifest/`](../skills/relay-dispatch/scripts/manifest/). The runtime entry points that were in scope now import only the slices they use, and the retained facade consumers are limited to tests, `test-support`, intake, and the plan-side helper that the issue explicitly fenced off.

No correctness delta was intended in this split. The only `cleanup-worktrees.js` change is an import-only migration to slice modules; its runtime behavior remains unchanged.

## Boundary Audit

| # | Boundary | New owner | Notes |
|---|----------|-----------|-------|
| 1 | Run-id, trust-root, and manifest-path validation | [paths.js](../skills/relay-dispatch/scripts/manifest/paths.js#L13) / [paths.js](../skills/relay-dispatch/scripts/manifest/paths.js#L39) / [paths.js](../skills/relay-dispatch/scripts/manifest/paths.js#L89) / [paths.js](../skills/relay-dispatch/scripts/manifest/paths.js#L272) | `getRelayHome`, canonical repo resolution, `validateRunId`, and `validateManifestPaths` now live together under the trust-root slice. |
| 2 | Frontmatter codec and manifest storage | [store.js](../skills/relay-dispatch/scripts/manifest/store.js#L48) / [store.js](../skills/relay-dispatch/scripts/manifest/store.js#L130) / [store.js](../skills/relay-dispatch/scripts/manifest/store.js#L139) / [store.js](../skills/relay-dispatch/scripts/manifest/store.js#L159) | `parseFrontmatter`, `writeManifest`, `readManifest`, `listManifestRecords`, and `createManifestSkeleton` moved together. |
| 3 | Lifecycle rules and operator recovery state transitions | [lifecycle.js](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L3) / [lifecycle.js](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L29) / [lifecycle.js](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L41) / [lifecycle.js](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L68) | `STATES`, `ALLOWED_TRANSITIONS`, `validateTransition`, `validateTransitionInvariants`, `updateManifestState`, and `forceTransitionState` now share one owner. |
| 4 | Rubric gate, grandfather auth, and symlink-safe I/O | [rubric.js](../skills/relay-dispatch/scripts/manifest/rubric.js#L123) / [rubric.js](../skills/relay-dispatch/scripts/manifest/rubric.js#L128) / [rubric.js](../skills/relay-dispatch/scripts/manifest/rubric.js#L318) / [rubric.js](../skills/relay-dispatch/scripts/manifest/rubric.js#L448) / [rubric.js](../skills/relay-dispatch/scripts/manifest/rubric.js#L606) | The migration-manifest cross-check, rubric containment checks, symlink-safe read/write helpers, and `getRubricAnchorStatus` moved as one unit. |
| 5 | Cleanup skeleton and git-backed cleanup execution | [cleanup.js](../skills/relay-dispatch/scripts/manifest/cleanup.js#L7) / [cleanup.js](../skills/relay-dispatch/scripts/manifest/cleanup.js#L18) / [cleanup.js](../skills/relay-dispatch/scripts/manifest/cleanup.js#L36) / [cleanup.js](../skills/relay-dispatch/scripts/manifest/cleanup.js#L87) | `CLEANUP_STATUSES`, `createCleanupSkeleton`, `updateManifestCleanup`, and `runCleanup` are now isolated from storage and rubric logic. |
| 6 | Previous-attempt history | [attempts.js](../skills/relay-dispatch/scripts/manifest/attempts.js#L16) / [attempts.js](../skills/relay-dispatch/scripts/manifest/attempts.js#L20) / [attempts.js](../skills/relay-dispatch/scripts/manifest/attempts.js#L42) / [attempts.js](../skills/relay-dispatch/scripts/manifest/attempts.js#L76) | Attempt capture/formatting moved behind a dedicated run-dir history slice. |
| 7 | Environment snapshot/drift comparison | [environment.js](../skills/relay-dispatch/scripts/manifest/environment.js#L10) / [environment.js](../skills/relay-dispatch/scripts/manifest/environment.js#L36) | Snapshot collection and drift comparison no longer share the large manifest file. |
| 8 | Facade only | [relay-manifest.js](../skills/relay-dispatch/scripts/relay-manifest.js#L1) / [relay-manifest.js](../skills/relay-dispatch/scripts/relay-manifest.js#L9) | The facade now has zero function declarations and only re-exports the slices. |

## Runtime Import Audit

| Runtime file | Narrow imports |
|--------------|----------------|
| [dispatch.js](../skills/relay-dispatch/scripts/dispatch.js#L66) | `environment`, `store`, `paths`, `rubric`, `attempts`, `lifecycle` |
| [recover-state.js](../skills/relay-dispatch/scripts/recover-state.js#L20) | `lifecycle`, `paths`, `store` |
| [close-run.js](../skills/relay-dispatch/scripts/close-run.js#L6) | `cleanup`, `lifecycle`, `paths`, `store` |
| [update-manifest-state.js](../skills/relay-dispatch/scripts/update-manifest-state.js#L30) | `lifecycle`, `store` |
| [relay-resolver.js](../skills/relay-dispatch/scripts/relay-resolver.js#L30) | `lifecycle`, `store`, `paths` |
| [review-runner.js](../skills/relay-review/scripts/review-runner.js#L35) | `lifecycle`, `paths`, `rubric`, `store` |
| [review-gate.js](../skills/relay-merge/scripts/review-gate.js#L1) | `rubric` |
| [gate-check.js](../skills/relay-merge/scripts/gate-check.js#L34) | `lifecycle`, `paths`, `store` |
| [finalize-run.js](../skills/relay-merge/scripts/finalize-run.js#L27) | `paths`, `lifecycle`, `store`, `cleanup` |

## Grep Evidence

```text
$ grep -c '^function\|^async function' skills/relay-dispatch/scripts/relay-manifest.js
0
```

```text
$ grep -rn 'require.*relay-manifest' skills/ | awk -F: '{print $1}' | sort -u
skills/relay-dispatch/scripts/cleanup-worktrees.test.js
skills/relay-dispatch/scripts/close-run.test.js
skills/relay-dispatch/scripts/dispatch.test.js
skills/relay-dispatch/scripts/recover-state.test.js
skills/relay-dispatch/scripts/relay-events.test.js
skills/relay-dispatch/scripts/relay-manifest.test.js
skills/relay-dispatch/scripts/relay-migrate-rubric.test.js
skills/relay-dispatch/scripts/relay-resolver.test.js
skills/relay-dispatch/scripts/reliability-report.test.js
skills/relay-dispatch/scripts/test-support.js
skills/relay-dispatch/scripts/update-manifest-state.test.js
skills/relay-intake/scripts/relay-request.js
skills/relay-intake/scripts/request-store.test.js
skills/relay-merge/scripts/finalize-run.test.js
skills/relay-merge/scripts/gate-check.test.js
skills/relay-plan/scripts/reliability-report-consumer.test.js
skills/relay-review/scripts/review-runner.test.js
```

```text
$ for f in skills/relay-dispatch/scripts/dispatch.js skills/relay-dispatch/scripts/recover-state.js skills/relay-dispatch/scripts/close-run.js skills/relay-dispatch/scripts/update-manifest-state.js skills/relay-dispatch/scripts/relay-resolver.js skills/relay-review/scripts/review-runner.js skills/relay-merge/scripts/review-gate.js skills/relay-merge/scripts/gate-check.js skills/relay-merge/scripts/finalize-run.js; do grep -Hn 'require.*relay-manifest' "$f" || true; done
<no output>
```

```text
$ grep -rn 'forceTransitionState' skills/ | awk -F: '{print $1}' | sort -u
skills/relay-dispatch/scripts/manifest/lifecycle.js
skills/relay-dispatch/scripts/manifest/lifecycle.test.js
skills/relay-dispatch/scripts/recover-state.js
skills/relay-dispatch/scripts/relay-manifest.test.js
```

## Trust-model audit

- **Q1 (forge)**: yes — an attacker with manifest write access could previously forge a gate bypass. The split keeps single owners for `validateTransition` and `getRubricAnchorStatus` rather than leaving duplicated gate logic in multiple files. — factor: `gate-layer-behavior-byte-identical`
- **Q2 (gate)**: `skills/relay-dispatch/scripts/manifest/lifecycle.js:validateTransition`, `skills/relay-dispatch/scripts/manifest/lifecycle.js:forceTransitionState`, `skills/relay-dispatch/scripts/manifest/paths.js:validateManifestPaths`, `skills/relay-dispatch/scripts/manifest/rubric.js:getRubricAnchorStatus`, `skills/relay-merge/scripts/review-gate.js:evaluateReviewGate` — factor: `gate-sites-named-and-verified`
- **Q3 (external verifier)**: `~/.relay/migrations/rubric-mandatory.yaml` via `loadMigrationManifest()` in [`manifest/rubric.js`](../skills/relay-dispatch/scripts/manifest/rubric.js#L123) — factor: `external-verifier-reference-preserved`

## Tests

- Baseline before edits: `444/444` passing.
- Final suite: `node --test skills/relay-intake/scripts/*.test.js skills/relay-plan/scripts/*.test.js skills/relay-dispatch/scripts/*.test.js skills/relay-review/scripts/*.test.js skills/relay-merge/scripts/*.test.js`
- Final result: `458/458` passing (`+14` tests).
- New direct-import slice coverage lives in [`manifest-direct-imports.test.js`](../skills/relay-dispatch/scripts/manifest-direct-imports.test.js) plus the seven `scripts/manifest/*.test.js` files it requires.

## Deferred Inventory

- `#189` review-runner decomposition remains separate.
- `#190` rubric grandfather retirement remains separate.
- `#191` resolver/CLI hygiene follow-ups remain separate.
- Intake and plan-side facade consumers remain intentionally deferred per the issue fences.

## Line-Number Drift Discipline

This doc was written after the final code changes for the split. If the source changes again before merge, regenerate the audit-table links and grep evidence as the last edit.
