# Issue #188 — Manifest Boundary Split

## Summary

`skills/relay-dispatch/scripts/relay-manifest.js` is now a pure re-export facade over seven narrower modules in [`skills/relay-dispatch/scripts/manifest/`](../skills/relay-dispatch/scripts/manifest/). The runtime entry points that were in scope now import only the slices they use, and the retained facade consumers are limited to tests, `test-support`, intake, and the plan-side helper that the issue explicitly fenced off.

No correctness delta was intended in this split. The only `cleanup-worktrees.js` change is an import-only migration to slice modules; its runtime behavior remains unchanged.

## Facade Guard

- [`skills/relay-dispatch/scripts/manifest-direct-imports.test.js`](../skills/relay-dispatch/scripts/manifest-direct-imports.test.js) now fails if [`skills/relay-dispatch/scripts/relay-manifest.js`](../skills/relay-dispatch/scripts/relay-manifest.js) grows past `40` lines or regains any `function` / `async function` declarations.
- Current facade shape: [`relay-manifest.js`](../skills/relay-dispatch/scripts/relay-manifest.js#L1) is `17` lines and only re-exports the slice modules.

## Function-Level Boundary Audit

Pre-split references below point at commit `1f9f434^`, the last revision where all logic still lived inside `skills/relay-dispatch/scripts/relay-manifest.js`.

### Paths / Trust Root

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:10` | `getRelayHome()` | [paths.js:13](../skills/relay-dispatch/scripts/manifest/paths.js#L13) | Relay-home trust root belongs with manifest path derivation. |
| `1f9f434^:relay-manifest.js:21` | `getRunsBase()` | [paths.js:24](../skills/relay-dispatch/scripts/manifest/paths.js#L24) | Run storage base is path configuration, not manifest lifecycle logic. |
| `1f9f434^:relay-manifest.js:25` | `getRelayWorktreeBase()` | [paths.js:28](../skills/relay-dispatch/scripts/manifest/paths.js#L28) | Relay-owned worktree trust root is a path concern. |
| `1f9f434^:relay-manifest.js:36` | `getCanonicalRepoRoot()` | [paths.js:39](../skills/relay-dispatch/scripts/manifest/paths.js#L39) | Canonical repo resolution is shared by all path trust checks. |
| `1f9f434^:relay-manifest.js:60` | `getRepoSlug()` | [paths.js:63](../skills/relay-dispatch/scripts/manifest/paths.js#L63) | Repo slugging belongs beside canonical-root resolution. |
| `1f9f434^:relay-manifest.js:139` | `inferIssueNumber()` | [paths.js:81](../skills/relay-dispatch/scripts/manifest/paths.js#L81) | Run-id derivation stays with other naming/path helpers. |
| `1f9f434^:relay-manifest.js:148` | `validateRunId()` | [paths.js:89](../skills/relay-dispatch/scripts/manifest/paths.js#L89) | Run-id validation is the first path-containment gate. |
| `1f9f434^:relay-manifest.js:224` | `requireValidRunId()` | [paths.js:165](../skills/relay-dispatch/scripts/manifest/paths.js#L165) | Throwing wrapper stays beside `validateRunId()`. |
| `1f9f434^:relay-manifest.js:232` | `createRunId()` | [paths.js:173](../skills/relay-dispatch/scripts/manifest/paths.js#L173) | Run-id generation and validation now share one owner. |
| `1f9f434^:relay-manifest.js:239` | `getRunsDir()` | [paths.js:180](../skills/relay-dispatch/scripts/manifest/paths.js#L180) | Run directory derivation belongs with the trust-root helpers. |
| `1f9f434^:relay-manifest.js:243` | `getRunDir()` | [paths.js:184](../skills/relay-dispatch/scripts/manifest/paths.js#L184) | Run directory resolution remains path-only. |
| `1f9f434^:relay-manifest.js:247` | `getManifestPath()` | [paths.js:188](../skills/relay-dispatch/scripts/manifest/paths.js#L188) | Manifest path derivation is grouped with the rest of the run layout. |
| `1f9f434^:relay-manifest.js:251` | `getEventsPath()` | [paths.js:192](../skills/relay-dispatch/scripts/manifest/paths.js#L192) | Event-journal path derivation is still part of the run layout slice. |
| `1f9f434^:relay-manifest.js:255` | `listManifestPaths()` | [paths.js:196](../skills/relay-dispatch/scripts/manifest/paths.js#L196) | Manifest discovery is storage-path traversal, not manifest parsing. |
| `1f9f434^:relay-manifest.js:263` | `ensureRunLayout()` | [paths.js:204](../skills/relay-dispatch/scripts/manifest/paths.js#L204) | Directory creation belongs with run path construction. |
| `1f9f434^:relay-manifest.js:457` | `validateManifestPaths()` | [paths.js:272](../skills/relay-dispatch/scripts/manifest/paths.js#L272) | Repo/worktree containment remains the dedicated trust-boundary gate. |

### Store / Codec

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:103` | `getActorName()` | [store.js:18](../skills/relay-dispatch/scripts/manifest/store.js#L18) | Actor stamping is part of manifest creation and write-side metadata. |
| `1f9f434^:relay-manifest.js:292` | `parseFrontmatter()` | [store.js:48](../skills/relay-dispatch/scripts/manifest/store.js#L48) | Frontmatter codec belongs with manifest serialization. |
| `1f9f434^:relay-manifest.js:374` | `writeManifest()` | [store.js:130](../skills/relay-dispatch/scripts/manifest/store.js#L130) | Manifest persistence is isolated from transition and cleanup logic. |
| `1f9f434^:relay-manifest.js:383` | `readManifest()` | [store.js:139](../skills/relay-dispatch/scripts/manifest/store.js#L139) | Manifest reads stay with codec normalization. |
| `1f9f434^:relay-manifest.js:398` | `listManifestRecords()` | [store.js:153](../skills/relay-dispatch/scripts/manifest/store.js#L153) | Record enumeration depends on the store/codec surface only. |
| `1f9f434^:relay-manifest.js:1419` | `createManifestSkeleton()` | [store.js:159](../skills/relay-dispatch/scripts/manifest/store.js#L159) | Skeleton assembly is manifest construction, even though it consumes lifecycle/cleanup constants. |
| `1f9f434^:relay-manifest.js:1512` | `summarizeError()` | [store.js:251](../skills/relay-dispatch/scripts/manifest/store.js#L251) | The exported helper now lives with the shared store-side I/O helpers that consume it. |

### Lifecycle / State Machine

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:561` | `validateTransition()` | [lifecycle.js:29](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L29) | This remains the single supported state-transition gate. |
| `1f9f434^:relay-manifest.js:1345` | `validateTransitionInvariants()` | [lifecycle.js:41](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L41) | Transition-time rubric invariants stay adjacent to the transition matrix. |
| `1f9f434^:relay-manifest.js:1358` | `updateManifestState()` | [lifecycle.js:54](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L54) | State mutation now sits behind the lifecycle boundary only. |
| `1f9f434^:relay-manifest.js:1375` | `forceTransitionState()` | [lifecycle.js:68](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L68) | Operator recovery bypasses the matrix, but still funnels through lifecycle invariants. |
| `1f9f434^:relay-manifest.js:1550` | `isTerminalState()` | [lifecycle.js:87](../skills/relay-dispatch/scripts/manifest/lifecycle.js#L87) | Terminal-state classification belongs with the state enum and transition rules. |

### Rubric / Verifier Boundary

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:573` | `hasRubricPath()` | [rubric.js:12](../skills/relay-dispatch/scripts/manifest/rubric.js#L12) | Rubric-anchor presence checks stay inside the rubric/verifier slice. |
| `1f9f434^:relay-manifest.js:732` | `getRubricGrandfatherMetadata()` | [rubric.js:175](../skills/relay-dispatch/scripts/manifest/rubric.js#L175) | Grandfather provenance evaluation is part of rubric verification. |
| `1f9f434^:relay-manifest.js:790` | `isRubricGrandfathered()` | [rubric.js:232](../skills/relay-dispatch/scripts/manifest/rubric.js#L232) | Boolean grandfather checks stay next to provenance validation. |
| `1f9f434^:relay-manifest.js:876` | `validateRubricPathContainment()` | [rubric.js:318](../skills/relay-dispatch/scripts/manifest/rubric.js#L318) | Rubric file containment remains a rubric-specific trust gate. |
| `1f9f434^:relay-manifest.js:1011` | `readTextFileWithoutFollowingSymlinks()` | [rubric.js:448](../skills/relay-dispatch/scripts/manifest/rubric.js#L448) | Symlink-safe rubric and attempts reads stay in the verifier hardening layer. |
| `1f9f434^:relay-manifest.js:1200` | `appendTextFileWithoutFollowingSymlinks()` | [rubric.js:588](../skills/relay-dispatch/scripts/manifest/rubric.js#L588) | Symlink-safe append logic remains rubric-owned shared I/O hardening. |
| `1f9f434^:relay-manifest.js:1209` | `writeTextFileWithoutFollowingSymlinks()` | [rubric.js:597](../skills/relay-dispatch/scripts/manifest/rubric.js#L597) | Symlink-safe write logic remains rubric-owned shared I/O hardening. |
| `1f9f434^:relay-manifest.js:1218` | `getRubricAnchorStatus()` | [rubric.js:606](../skills/relay-dispatch/scripts/manifest/rubric.js#L606) | External verifier checks still funnel through one authoritative rubric gate. |

### Cleanup

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:119` | `createCleanupSkeleton()` | [cleanup.js:18](../skills/relay-dispatch/scripts/manifest/cleanup.js#L18) | Cleanup-state initialization is isolated from manifest storage and lifecycle logic. |
| `1f9f434^:relay-manifest.js:1400` | `updateManifestCleanup()` | [cleanup.js:36](../skills/relay-dispatch/scripts/manifest/cleanup.js#L36) | Cleanup mutation now lives behind the cleanup-only boundary. |
| `1f9f434^:relay-manifest.js:1554` | `runCleanup()` | [cleanup.js:87](../skills/relay-dispatch/scripts/manifest/cleanup.js#L87) | Git-backed teardown is isolated from manifest parsing and transition rules. |

### Attempt History

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:1663` | `getAttemptsPath()` | [attempts.js:16](../skills/relay-dispatch/scripts/manifest/attempts.js#L16) | Attempt-file pathing belongs with attempt-history persistence. |
| `1f9f434^:relay-manifest.js:1667` | `readPreviousAttempts()` | [attempts.js:20](../skills/relay-dispatch/scripts/manifest/attempts.js#L20) | Attempt-history reads are isolated from manifest I/O. |
| `1f9f434^:relay-manifest.js:1694` | `captureAttempt()` | [attempts.js:42](../skills/relay-dispatch/scripts/manifest/attempts.js#L42) | Attempt recording now has its own persistence boundary. |
| `1f9f434^:relay-manifest.js:1728` | `formatAttemptsForPrompt()` | [attempts.js:76](../skills/relay-dispatch/scripts/manifest/attempts.js#L76) | Prompt rendering stays with the attempt-history model it formats. |

### Environment Snapshot

| Pre-split line | Symbol | Final owner | Why it lives there now |
|---|---|---|---|
| `1f9f434^:relay-manifest.js:1749` | `collectEnvironmentSnapshot()` | [environment.js:10](../skills/relay-dispatch/scripts/manifest/environment.js#L10) | Environment capture is independent from manifest storage and cleanup. |
| `1f9f434^:relay-manifest.js:1775` | `compareEnvironmentSnapshot()` | [environment.js:36](../skills/relay-dispatch/scripts/manifest/environment.js#L36) | Drift comparison stays with the environment snapshot schema. |

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

## Retained Facade Consumers

Every remaining `relay-manifest` import is either a deliberate public-surface compatibility test or a consumer the issue explicitly deferred.

| Consumer | Why it still imports the facade |
|---|---|
| [cleanup-worktrees.test.js](../skills/relay-dispatch/scripts/cleanup-worktrees.test.js) | Compatibility test; it intentionally exercises the legacy public surface instead of a private slice. |
| [close-run.test.js](../skills/relay-dispatch/scripts/close-run.test.js) | Compatibility test for the CLI contract, not a slice-internal unit test. |
| [dispatch.test.js](../skills/relay-dispatch/scripts/dispatch.test.js) | Compatibility test; keeps the public manifest API under regression coverage. |
| [recover-state.test.js](../skills/relay-dispatch/scripts/recover-state.test.js) | Compatibility test for operator recovery flows that still target the public facade. |
| [relay-events.test.js](../skills/relay-dispatch/scripts/relay-events.test.js) | Compatibility test; uses the published manifest API to build fixture state. |
| [relay-manifest.test.js](../skills/relay-dispatch/scripts/relay-manifest.test.js) | Explicit facade contract test; this file exists to pin the compatibility layer itself. |
| [relay-migrate-rubric.test.js](../skills/relay-dispatch/scripts/relay-migrate-rubric.test.js) | Compatibility test for the rubric-migration CLI’s public manifest helpers. |
| [relay-resolver.test.js](../skills/relay-dispatch/scripts/relay-resolver.test.js) | Compatibility test for resolver behavior that historically imported the facade. |
| [reliability-report.test.js](../skills/relay-dispatch/scripts/reliability-report.test.js) | Compatibility test for reporting behavior built around the public manifest surface. |
| [test-support.js](../skills/relay-dispatch/scripts/test-support.js) | Shared test fixture helper; keeping one facade import avoids duplicating slice wiring across legacy tests. |
| [update-manifest-state.test.js](../skills/relay-dispatch/scripts/update-manifest-state.test.js) | Compatibility test for the state-update CLI contract. |
| [relay-request.js](../skills/relay-intake/scripts/relay-request.js) | Intake is out of scope for #188; it stays on the stable facade until a separate boundary pass lands. |
| [request-store.test.js](../skills/relay-intake/scripts/request-store.test.js) | Intake compatibility test; it follows the deferred intake runtime consumer. |
| [finalize-run.test.js](../skills/relay-merge/scripts/finalize-run.test.js) | Compatibility test for merge finalization behavior that still targets the public manifest API. |
| [gate-check.test.js](../skills/relay-merge/scripts/gate-check.test.js) | Compatibility test for merge-gate behavior that historically used the facade. |
| [reliability-report-consumer.test.js](../skills/relay-plan/scripts/reliability-report-consumer.test.js) | Plan-side consumer is explicitly deferred by the issue fence; the test pins that deferred compatibility contract. |
| [review-runner.test.js](../skills/relay-review/scripts/review-runner.test.js) | Compatibility test for review orchestration behavior built around the public manifest surface. |

## Grep Evidence

```text
$ grep -c '^function\|^async function' skills/relay-dispatch/scripts/relay-manifest.js
0
```

```text
$ wc -l skills/relay-dispatch/scripts/relay-manifest.js
17 skills/relay-dispatch/scripts/relay-manifest.js
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

## Trust-Model Audit

- **Q1 (forge)**: yes — an attacker with manifest write access could previously forge a gate bypass. The split keeps single owners for `validateTransition()` and `getRubricAnchorStatus()` rather than leaving duplicated gate logic in multiple files. — factor: `gate-layer-behavior-byte-identical`
- **Q2 (gate)**: `skills/relay-dispatch/scripts/manifest/lifecycle.js:validateTransition`, `skills/relay-dispatch/scripts/manifest/lifecycle.js:validateTransitionInvariants`, `skills/relay-dispatch/scripts/manifest/lifecycle.js:forceTransitionState`, `skills/relay-dispatch/scripts/manifest/paths.js:validateManifestPaths`, `skills/relay-dispatch/scripts/manifest/rubric.js:getRubricAnchorStatus` — factor: `gate-sites-named-and-verified`
- **Q3 (external verifier)**: `~/.relay/migrations/rubric-mandatory.yaml` via `loadMigrationManifest()` in [`manifest/rubric.js`](../skills/relay-dispatch/scripts/manifest/rubric.js#L123) — factor: `external-verifier-reference-preserved`

## Tests

- Final suite: `node --test skills/relay-intake/scripts/*.test.js skills/relay-plan/scripts/*.test.js skills/relay-dispatch/scripts/*.test.js skills/relay-review/scripts/*.test.js skills/relay-merge/scripts/*.test.js`
- Final result: `465/465` passing.
- New direct-import slice coverage lives in [`manifest-direct-imports.test.js`](../skills/relay-dispatch/scripts/manifest-direct-imports.test.js) plus the seven `scripts/manifest/*.test.js` files it requires.

## Deferred Inventory

- `#189` review-runner decomposition remains separate.
- `#190` rubric grandfather retirement remains separate.
- `#191` resolver/CLI hygiene follow-ups remain separate.
- Intake and plan-side facade consumers remain intentionally deferred per the issue fences.

## Line-Number Drift Discipline

This doc was written after the final code changes for the split. If the source changes again before merge, regenerate the audit-table links and grep evidence as the last edit.
