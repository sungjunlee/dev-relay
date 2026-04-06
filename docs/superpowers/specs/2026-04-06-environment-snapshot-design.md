# Environment Snapshot in Manifest (#96)

Closes #96. Record environment metadata at dispatch time; warn on drift at re-dispatch.

## Manifest schema

New `environment` block in manifest frontmatter:

```yaml
environment:
  node_version: '22.12.0'
  main_sha: 'abc1234'
  lockfile_hash: 'sha256:a1b2c3...'
  dispatch_ts: '2026-04-06T04:00:00.000Z'
```

All values are strings or null. No arrays (frontmatter parser rejects them).

| Field | Source | Notes |
|-------|--------|-------|
| `node_version` | `process.version` | No exec needed |
| `main_sha` | `git rev-parse origin/<baseBranch>` | After fetch; null if no remote |
| `lockfile_hash` | sha256 of `package-lock.json` | null if file absent |
| `dispatch_ts` | `new Date().toISOString()` | Snapshot collection time |

## New functions (relay-manifest.js)

### `collectEnvironmentSnapshot(repoRoot, baseBranch)`

Returns `{ node_version, main_sha, lockfile_hash, dispatch_ts }`.

- `node_version`: `process.version`
- `main_sha`: `execFileSync("git", ["-C", repoRoot, "rev-parse", "origin/" + baseBranch])`, catch → null
- `lockfile_hash`: read `package-lock.json` from repoRoot, sha256 hash, catch → null
- `dispatch_ts`: `new Date().toISOString()`

### `compareEnvironmentSnapshot(baseline, current)`

Pure function. Returns `[{ field, from, to }]`.

- If baseline is null/undefined → return `[]` (no comparison possible)
- Compare each field; skip if both null; include in result if different

## dispatch.js integration

### New dispatch (~line 423, before `createManifestSkeleton`)

```js
const environment = collectEnvironmentSnapshot(repoRoot, baseBranch);
```

Pass `environment` into skeleton. Add to `createManifestSkeleton` params.

### Resume dispatch (~line 263, after manifest read)

```js
const currentEnv = collectEnvironmentSnapshot(repoRoot, baseBranch);
const drift = compareEnvironmentSnapshot(manifest.environment, currentEnv);
if (drift.length) {
  const driftMsg = drift.map(d => `${d.field}: ${d.from} → ${d.to}`).join(", ");
  console.error(`[WARN] Environment drift detected: ${driftMsg}`);
  appendRunEvent(repoRoot, runId, {
    event: "environment_drift",
    state_from: manifest.state,
    state_to: manifest.state,
    reason: driftMsg,
  });
}
```

### Dry-run

Include `environment` in dry-run plan output.

## Event recording

Uses existing `appendRunEvent` — no schema changes. Event type `environment_drift` with `reason` containing the drift summary.

## Backwards compatibility

- Manifests without `environment` → `compareEnvironmentSnapshot(undefined, ...)` → `[]` (no warning)
- Individual null fields → skip comparison for that field

## Testing

### relay-manifest.test.js

- `collectEnvironmentSnapshot` returns expected shape; `node_version` matches `process.version`
- `compareEnvironmentSnapshot` with identical snapshots → `[]`
- `compareEnvironmentSnapshot` with differing fields → correct drift entries
- `compareEnvironmentSnapshot` with null/undefined baseline → `[]`
- Manifest round-trip with `environment` block

### dispatch.test.js

- New dispatch JSON output includes `environment` field in manifest
- Dry-run output includes environment snapshot

## Files to change

1. `skills/relay-dispatch/scripts/relay-manifest.js` — add `collectEnvironmentSnapshot`, `compareEnvironmentSnapshot`, update `createManifestSkeleton`
2. `skills/relay-dispatch/scripts/dispatch.js` — call snapshot on new dispatch, compare+warn on resume, include in dry-run
3. `skills/relay-dispatch/scripts/relay-manifest.test.js` — unit tests for new functions
4. `skills/relay-dispatch/scripts/dispatch.test.js` — integration tests for snapshot in dispatch output
