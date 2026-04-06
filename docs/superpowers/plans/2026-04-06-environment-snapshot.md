# Environment Snapshot Implementation Plan

**Status: Implemented** — merged in PR #101, closes #96.

**Goal:** Record environment metadata at dispatch time and warn on drift at re-dispatch.

**Architecture:** Two pure-ish functions in relay-manifest.js (`collectEnvironmentSnapshot`, `compareEnvironmentSnapshot`), called from dispatch.js at new-dispatch and resume points. Drift events use existing `appendRunEvent`.

**Tech Stack:** Node.js built-in test runner, execFileSync for git, crypto for hashing.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `skills/relay-dispatch/scripts/relay-manifest.js` | Modify | Add `collectEnvironmentSnapshot`, `compareEnvironmentSnapshot`, update `createManifestSkeleton` |
| `skills/relay-dispatch/scripts/relay-manifest.test.js` | Modify | Unit tests for new functions |
| `skills/relay-dispatch/scripts/dispatch.js` | Modify | Call snapshot on new dispatch, compare+warn on resume, include in dry-run |
| `skills/relay-dispatch/scripts/dispatch.test.js` | Modify | Integration test for snapshot presence in output |

---

### Task 1: collectEnvironmentSnapshot — test + implement

**Files:**
- Modify: `skills/relay-dispatch/scripts/relay-manifest.test.js`
- Modify: `skills/relay-dispatch/scripts/relay-manifest.js:578-611`

- [ ] **Step 1: Write the failing test**

Add to `skills/relay-dispatch/scripts/relay-manifest.test.js`:

```js
test("collectEnvironmentSnapshot returns expected shape", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  const snapshot = collectEnvironmentSnapshot(repoRoot, "main");

  assert.equal(snapshot.node_version, process.version);
  assert.equal(typeof snapshot.dispatch_ts, "string");
  assert.ok(snapshot.dispatch_ts.endsWith("Z"));
  // No remote, so main_sha should be null
  assert.equal(snapshot.main_sha, null);
  // No package-lock.json, so lockfile_hash should be null
  assert.equal(snapshot.lockfile_hash, null);
});

test("collectEnvironmentSnapshot hashes lockfile when present", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-lock-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');

  const snapshot = collectEnvironmentSnapshot(repoRoot, "main");

  assert.ok(snapshot.lockfile_hash);
  assert.match(snapshot.lockfile_hash, /^sha256:[a-f0-9]{64}$/);
});
```

Note: add `const { execFileSync } = require("child_process");` to the test file imports, and add `collectEnvironmentSnapshot` to the require from `./relay-manifest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: FAIL with "collectEnvironmentSnapshot is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to `skills/relay-dispatch/scripts/relay-manifest.js`, before the `module.exports` block (before line 578):

```js
function collectEnvironmentSnapshot(repoRoot, baseBranch) {
  let mainSha = null;
  try {
    mainSha = execFileSync(
      "git", ["-C", repoRoot, "rev-parse", `origin/${baseBranch}`],
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
  } catch {}

  let lockfileHash = null;
  const lockfilePath = path.join(repoRoot, "package-lock.json");
  try {
    const content = fs.readFileSync(lockfilePath);
    lockfileHash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
  } catch {}

  return {
    node_version: process.version,
    main_sha: mainSha,
    lockfile_hash: lockfileHash,
    dispatch_ts: new Date().toISOString(),
  };
}
```

Add `collectEnvironmentSnapshot` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/relay-dispatch/scripts/relay-manifest.js skills/relay-dispatch/scripts/relay-manifest.test.js
git commit -m "feat(#96): add collectEnvironmentSnapshot to relay-manifest"
```

---

### Task 2: compareEnvironmentSnapshot — test + implement

**Files:**
- Modify: `skills/relay-dispatch/scripts/relay-manifest.test.js`
- Modify: `skills/relay-dispatch/scripts/relay-manifest.js`

- [ ] **Step 1: Write the failing tests**

Add to `skills/relay-dispatch/scripts/relay-manifest.test.js`:

```js
test("compareEnvironmentSnapshot returns empty array for identical snapshots", () => {
  const snapshot = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: "sha256:aaa",
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  const drift = compareEnvironmentSnapshot(snapshot, { ...snapshot });
  assert.deepEqual(drift, []);
});

test("compareEnvironmentSnapshot detects field changes", () => {
  const baseline = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: "sha256:aaa",
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  const current = {
    node_version: "v22.12.0",
    main_sha: "def5678",
    lockfile_hash: "sha256:bbb",
    dispatch_ts: "2026-04-06T05:00:00.000Z",
  };
  const drift = compareEnvironmentSnapshot(baseline, current);
  // dispatch_ts always differs — should be excluded from comparison
  assert.equal(drift.length, 2);
  assert.ok(drift.some(d => d.field === "main_sha" && d.from === "abc1234" && d.to === "def5678"));
  assert.ok(drift.some(d => d.field === "lockfile_hash" && d.from === "sha256:aaa" && d.to === "sha256:bbb"));
});

test("compareEnvironmentSnapshot returns empty array when baseline is null", () => {
  const current = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: null,
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  assert.deepEqual(compareEnvironmentSnapshot(null, current), []);
  assert.deepEqual(compareEnvironmentSnapshot(undefined, current), []);
});

test("compareEnvironmentSnapshot skips fields that are null in both", () => {
  const baseline = { node_version: "v22.12.0", main_sha: null, lockfile_hash: null, dispatch_ts: "t1" };
  const current = { node_version: "v22.12.0", main_sha: null, lockfile_hash: null, dispatch_ts: "t2" };
  assert.deepEqual(compareEnvironmentSnapshot(baseline, current), []);
});
```

Add `compareEnvironmentSnapshot` to the require from `./relay-manifest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: FAIL with "compareEnvironmentSnapshot is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to `skills/relay-dispatch/scripts/relay-manifest.js`, after `collectEnvironmentSnapshot`:

```js
const ENVIRONMENT_COMPARE_FIELDS = ["node_version", "main_sha", "lockfile_hash"];

function compareEnvironmentSnapshot(baseline, current) {
  if (!baseline || !current) return [];
  const drift = [];
  for (const field of ENVIRONMENT_COMPARE_FIELDS) {
    const from = baseline[field] ?? null;
    const to = current[field] ?? null;
    if (from === null && to === null) continue;
    if (from !== to) drift.push({ field, from, to });
  }
  return drift;
}
```

Add `compareEnvironmentSnapshot` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add skills/relay-dispatch/scripts/relay-manifest.js skills/relay-dispatch/scripts/relay-manifest.test.js
git commit -m "feat(#96): add compareEnvironmentSnapshot to relay-manifest"
```

---

### Task 3: Update createManifestSkeleton + manifest round-trip test

**Files:**
- Modify: `skills/relay-dispatch/scripts/relay-manifest.js:314-376`
- Modify: `skills/relay-dispatch/scripts/relay-manifest.test.js`

- [ ] **Step 1: Write the failing test**

Add to `skills/relay-dispatch/scripts/relay-manifest.test.js`:

```js
test("manifest round-trips with environment block", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-rt-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-96-20260406040000000";
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-96",
    baseBranch: "main",
    issueNumber: 96,
    worktreePath: path.join(repoRoot, "wt"),
    orchestrator: "claude",
    executor: "codex",
    reviewer: "claude",
    environment: {
      node_version: "v22.12.0",
      main_sha: "abc1234def5678",
      lockfile_hash: "sha256:aabbccdd",
      dispatch_ts: "2026-04-06T04:00:00.000Z",
    },
  });

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(parsed.data.environment.node_version, "v22.12.0");
  assert.equal(parsed.data.environment.main_sha, "abc1234def5678");
  assert.equal(parsed.data.environment.lockfile_hash, "sha256:aabbccdd");
  assert.equal(parsed.data.environment.dispatch_ts, "2026-04-06T04:00:00.000Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: FAIL — `parsed.data.environment` is undefined (skeleton doesn't include it yet)

- [ ] **Step 3: Update createManifestSkeleton**

In `skills/relay-dispatch/scripts/relay-manifest.js`, update the `createManifestSkeleton` function:

Add `environment = null` to the destructured params:

```js
function createManifestSkeleton({
  repoRoot,
  runId,
  branch,
  baseBranch,
  issueNumber,
  worktreePath,
  orchestrator = "unknown",
  executor = "unknown",
  reviewer = "unknown",
  mergePolicy = "manual_after_lgtm",
  cleanupPolicy = "on_close",
  reviewerWritePolicy = "forbid",
  environment = null,
}) {
```

Add the `environment` field to the returned object, after `cleanup` and before `timestamps`:

```js
    environment: environment || {
      node_version: null,
      main_sha: null,
      lockfile_hash: null,
      dispatch_ts: null,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/relay-dispatch/scripts/relay-manifest.test.js`
Expected: All tests PASS (including existing tests — the default null skeleton is backwards compatible)

- [ ] **Step 5: Commit**

```bash
git add skills/relay-dispatch/scripts/relay-manifest.js skills/relay-dispatch/scripts/relay-manifest.test.js
git commit -m "feat(#96): add environment field to createManifestSkeleton"
```

---

### Task 4: Integrate snapshot into dispatch.js — new dispatch path

**Files:**
- Modify: `skills/relay-dispatch/scripts/dispatch.js:55-67` (imports)
- Modify: `skills/relay-dispatch/scripts/dispatch.js:423-436` (new dispatch skeleton)
- Modify: `skills/relay-dispatch/scripts/dispatch.js:327-339` (dry-run plan)
- Modify: `skills/relay-dispatch/scripts/dispatch.test.js`

- [ ] **Step 1: Write the failing test**

Add to `skills/relay-dispatch/scripts/dispatch.test.js`:

```js
test("new dispatch manifest includes environment snapshot", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-96-env",
    "--prompt", "test env snapshot",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  const manifest = readManifest(result.manifestPath).data;
  assert.ok(manifest.environment);
  assert.equal(manifest.environment.node_version, process.version);
  assert.equal(typeof manifest.environment.dispatch_ts, "string");
  // No remote in test repo, so main_sha is null
  assert.equal(manifest.environment.main_sha, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/relay-dispatch/scripts/dispatch.test.js`
Expected: FAIL — `manifest.environment.node_version` is null (skeleton has null defaults)

- [ ] **Step 3: Update dispatch.js imports**

In `skills/relay-dispatch/scripts/dispatch.js`, update the require from `./relay-manifest` (line 55-67) to add `collectEnvironmentSnapshot`:

```js
const {
  STATES,
  collectEnvironmentSnapshot,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getManifestPath,
  getRunDir,
  inferIssueNumber,
  readPreviousAttempts,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
```

- [ ] **Step 4: Add snapshot collection to new dispatch path**

In `skills/relay-dispatch/scripts/dispatch.js`, before `manifest = createManifestSkeleton({` (line 423), add:

```js
    const environment = collectEnvironmentSnapshot(repoRoot, baseBranch);
```

Then add `environment` to the `createManifestSkeleton` call:

```js
    manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch,
      issueNumber,
      worktreePath: wtPath,
      orchestrator: process.env.RELAY_ORCHESTRATOR || "unknown",
      executor: EXECUTOR,
      reviewer: process.env.RELAY_REVIEWER || "unknown",
      cleanupPolicy,
      environment,
    });
```

- [ ] **Step 5: Add environment to dry-run output**

In `skills/relay-dispatch/scripts/dispatch.js`, update the dry-run plan object (line 329-339). Before the closing `};`, add to both the JSON plan object:

```js
      environment: RESUME_MODE ? (manifest?.environment || null) : "collected-at-dispatch",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test skills/relay-dispatch/scripts/dispatch.test.js`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add skills/relay-dispatch/scripts/dispatch.js skills/relay-dispatch/scripts/dispatch.test.js
git commit -m "feat(#96): collect environment snapshot on new dispatch"
```

---

### Task 5: Integrate drift detection into dispatch.js — resume path

**Files:**
- Modify: `skills/relay-dispatch/scripts/dispatch.js:55-67` (imports — add compareEnvironmentSnapshot)
- Modify: `skills/relay-dispatch/scripts/dispatch.js:262-315` (resume path)
- Modify: `skills/relay-dispatch/scripts/dispatch.test.js`

- [ ] **Step 1: Write the failing test**

Add to `skills/relay-dispatch/scripts/dispatch.test.js`:

```js
test("re-dispatch detects environment drift and records event", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-drift",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  // Tamper with manifest environment to simulate drift
  const record = readManifest(first.manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch");
  updated.environment.lockfile_hash = "sha256:old_hash_that_will_differ";
  writeManifest(first.manifestPath, updated, record.body);

  // Create a package-lock.json so current snapshot has a hash
  fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "--prompt", "resume with drift",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runState, STATES.REVIEW_PENDING);

  // Check that environment_drift event was recorded
  const events = fs.readFileSync(getEventsPath(repoRoot, first.runId), "utf-8");
  assert.match(events, /"event":"environment_drift"/);
  assert.match(events, /lockfile_hash/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/relay-dispatch/scripts/dispatch.test.js`
Expected: FAIL — no `environment_drift` event recorded

- [ ] **Step 3: Add compareEnvironmentSnapshot to imports**

In `skills/relay-dispatch/scripts/dispatch.js`, update the require to also import `compareEnvironmentSnapshot`:

```js
const {
  STATES,
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getManifestPath,
  getRunDir,
  inferIssueNumber,
  readPreviousAttempts,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
```

- [ ] **Step 4: Add drift detection to resume path**

In `skills/relay-dispatch/scripts/dispatch.js`, after the resume validation block (after the worktree HEAD check, around line 305), add drift detection:

```js
    // --- Environment drift check ---
    const currentEnv = collectEnvironmentSnapshot(repoRoot, baseBranch);
    const drift = compareEnvironmentSnapshot(manifest.environment, currentEnv);
    if (drift.length) {
      const driftMsg = drift.map(d => `${d.field}: ${d.from} → ${d.to}`).join(", ");
      if (!JSON_OUT) {
        console.error(`[WARN] Environment drift detected since initial dispatch: ${driftMsg}`);
      }
      appendRunEvent(repoRoot, runId, {
        event: "environment_drift",
        state_from: manifest.state,
        state_to: manifest.state,
        reason: driftMsg,
      });
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test skills/relay-dispatch/scripts/dispatch.test.js`
Expected: All tests PASS

- [ ] **Step 6: Run all tests to verify no regressions**

Run: `node --test skills/relay-dispatch/scripts/*.test.js`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add skills/relay-dispatch/scripts/dispatch.js skills/relay-dispatch/scripts/dispatch.test.js
git commit -m "feat(#96): detect environment drift on re-dispatch and record event"
```

---

### Task 6: Final verification + push

**Files:** None (verification only)

- [ ] **Step 1: Run all relay tests**

Run: `node --test skills/relay-dispatch/scripts/*.test.js skills/relay-review/scripts/*.test.js skills/relay-plan/scripts/*.test.js skills/relay-merge/scripts/*.test.js`
Expected: All tests PASS

- [ ] **Step 2: Verify dry-run includes environment**

Run: `node skills/relay-dispatch/scripts/dispatch.js . -b test-env-dryrun -p "test" --dry-run --json 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log('environment:', d.environment)"`
Expected: `environment: collected-at-dispatch`

- [ ] **Step 3: Create feature branch and PR**

```bash
git checkout -b feat/96-environment-snapshot
git push -u origin feat/96-environment-snapshot
gh pr create --title "feat: environment snapshot in manifest for drift detection (#96)" \
  --body "$(cat <<'PREOF'
## Summary
- Add `collectEnvironmentSnapshot()` and `compareEnvironmentSnapshot()` to relay-manifest.js
- Record environment block (node_version, main_sha, lockfile_hash, dispatch_ts) in manifest at dispatch time
- Detect and warn on drift at re-dispatch, record `environment_drift` event
- Backwards compatible — manifests without environment section still work

Closes #96

## Test plan
- [ ] `node --test skills/relay-dispatch/scripts/relay-manifest.test.js` — all pass
- [ ] `node --test skills/relay-dispatch/scripts/dispatch.test.js` — all pass
- [ ] `node --test skills/relay-dispatch/scripts/*.test.js` — no regressions
- [ ] Dry-run includes environment in output
PREOF
)"
```
