const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STATES,
  createManifestSkeleton,
  createRunId,
  getManifestPath,
  getRunDir,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");

const SCRIPT = path.join(__dirname, "gate-check.js");
const HISTORICAL_FIXTURE_DIR = path.join(__dirname, "__fixtures__", "historical-issue-401");

function looksLikeContainedRubricPath(rubricPath) {
  return typeof rubricPath === "string"
    && rubricPath.trim() !== ""
    && !path.isAbsolute(rubricPath)
    && !rubricPath.split(/[\\/]+/).includes("..");
}

function ensureDryRunRubricFixture(payload) {
  if (!payload?.manifest?.anchor?.rubric_path || payload.runDir) {
    return payload;
  }

  const rubricPath = payload.manifest.anchor.rubric_path;
  if (!looksLikeContainedRubricPath(rubricPath)) {
    return payload;
  }

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-run-"));
  const fullPath = path.join(runDir, rubricPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, "rubric:\n  factors:\n    - name: gate check\n", "utf-8");
  return { ...payload, runDir };
}

function runGateCheckDryRun(payload, { json = true } = {}) {
  const preparedPayload = Array.isArray(payload)
    ? payload
    : ensureDryRunRubricFixture(payload);
  const input = JSON.stringify(
    Array.isArray(preparedPayload)
      ? preparedPayload.map((body) => ({ body }))
      : preparedPayload
  );
  const result = spawnSync("node", [
    SCRIPT,
    "40",
    "--dry-run",
    ...(json ? ["--json"] : []),
  ], {
    input,
    encoding: "utf-8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: json && result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function writeFakeGh(binDir) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(process.env.FAKE_GH_PR_VIEW_JSON || "{}");
  process.exit(0);
}
process.stderr.write("unsupported fake gh invocation");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
}

function writeResolverOverridePreload(binDir, manifestPath, overrideState) {
  const preloadPath = path.join(binDir, "override-resolver.cjs");
  const relayManifestPath = path.resolve(__dirname, "../../relay-dispatch/scripts/relay-manifest.js");
  const relayResolverPath = path.resolve(__dirname, "../../relay-dispatch/scripts/relay-resolver.js");
  fs.writeFileSync(preloadPath, `const Module = require("module");
const { readManifest } = require(${JSON.stringify(relayManifestPath)});
const resolverPath = ${JSON.stringify(relayResolverPath)};
const manifestPath = ${JSON.stringify(manifestPath)};
const overrideState = ${JSON.stringify(overrideState)};
const originalLoad = Module._load;

Module._load = function patchedModuleLoad(request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    return originalLoad.apply(this, arguments);
  }

  const loaded = originalLoad.apply(this, arguments);
  if (resolved !== resolverPath) {
    return loaded;
  }

  return {
    ...loaded,
    resolveManifestRecord() {
      const manifest = readManifest(manifestPath);
      return {
        manifestPath,
        data: {
          ...manifest.data,
          state: overrideState,
        },
        body: manifest.body,
      };
    },
  };
};
`, "utf-8");
  return preloadPath;
}

function applyManifestState(manifest, state) {
  if (!state || state === STATES.DRAFT) {
    return manifest;
  }

  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  if ([STATES.REVIEW_PENDING, STATES.ESCALATED, STATES.MERGED, STATES.CLOSED].includes(state)) {
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  }
  if (state === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_review_failure");
  }
  if (state === STATES.MERGED) {
    manifest = updateManifestState(
      updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge"),
      STATES.MERGED,
      "manual_cleanup_required"
    );
  }
  if (state === STATES.CLOSED) {
    manifest = updateManifestState(manifest, STATES.CLOSED, "done");
  }
  return manifest;
}

function writeLiveManifest(repoRoot, relayHome, {
  anchor = {},
  review = {},
  git = {},
  rubricContent,
  storedRunId,
  state = null,
} = {}) {
  process.env.RELAY_HOME = relayHome;
  const runId = createRunId({
    issueNumber: 40,
    branch: "issue-40",
    timestamp: new Date("2026-04-12T01:00:00.000Z"),
  });
  const manifestPath = getManifestPath(repoRoot, runId);
  const runDir = getRunDir(repoRoot, runId);
  if (looksLikeContainedRubricPath(anchor.rubric_path) && rubricContent !== false) {
    const fullPath = path.join(runDir, anchor.rubric_path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, rubricContent || "rubric:\n  factors:\n    - name: live gate check\n", "utf-8");
  }
  let manifest = {
    ...createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-40",
      baseBranch: "main",
      issueNumber: 40,
      worktreePath: path.join(repoRoot, "worktree"),
      orchestrator: "test",
      executor: "codex",
      reviewer: "codex",
    }),
    git: {
      pr_number: 40,
      working_branch: "issue-40",
      ...git,
    },
    anchor: {
      rubric_source: "manifest",
      ...anchor,
    },
    review: {
      rounds: 1,
      latest_verdict: "pass",
      ...review,
    },
  };
  if (typeof storedRunId === "string") {
    manifest.run_id = storedRunId;
  }
  manifest = applyManifestState(manifest, state);
  writeManifest(manifestPath, manifest);
  return { manifestPath, runId, runDir };
}

function createLiveGateFixture({ manifest, rubricContent, afterManifestSetup = null }) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-check-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-bin-")));
  writeFakeGh(binDir);
  const liveManifest = writeLiveManifest(repoRoot, relayHome, { ...manifest, rubricContent });
  if (typeof afterManifestSetup === "function") {
    afterManifestSetup({ ...liveManifest, repoRoot, relayHome, binDir });
  }
  return { ...liveManifest, repoRoot, relayHome, binDir };
}

function createUnrelatedRelayOwnedWorktree(repoRoot, relayHome, branch = "issue-40") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Gate Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-gate-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "foreign\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  const relayWorktrees = path.join(relayHome, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const attackerWorktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "foreign-"));
  const attackerWorktree = path.join(attackerWorktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", attackerWorktree, "-b", branch], {
    cwd: attackerRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(attackerWorktree, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, attackerWorktree };
}

function buildStampLockEnv({ timeoutMs = 75, pollMs = 5 } = {}) {
  return {
    RELAY_PR_NUMBER_STAMP_LOCK_TIMEOUT_MS: String(timeoutMs),
    RELAY_PR_NUMBER_STAMP_LOCK_POLL_MS: String(pollMs),
  };
}

function runGateCheckWithFixture(fixture, { prViewPayload, json = true, env = {} } = {}) {
  const result = spawnSync("node", [
    SCRIPT,
    "40",
    ...(json ? ["--json"] : []),
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: fixture.relayHome,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(prViewPayload),
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: json && result.stdout ? JSON.parse(result.stdout) : null,
    ...fixture,
  };
}

function runGateCheckLive({ manifest, prViewPayload, rubricContent, json = true, afterManifestSetup = null }) {
  const fixture = createLiveGateFixture({ manifest, rubricContent, afterManifestSetup });
  return runGateCheckWithFixture(fixture, { prViewPayload, json });
}

function createHistoricalLegacyFixture() {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-historical-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-bin-")));
  process.env.RELAY_HOME = relayHome;
  writeFakeGh(binDir);

  const sourceManifestPath = path.join(HISTORICAL_FIXTURE_DIR, "manifest.md");
  const sourceRubricPath = path.join(HISTORICAL_FIXTURE_DIR, "rubric.yaml");
  const { data, body } = readManifest(sourceManifestPath);
  const manifestPath = getManifestPath(repoRoot, data.run_id);
  const runDir = getRunDir(repoRoot, data.run_id);

  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(sourceRubricPath, path.join(runDir, "rubric.yaml"));

  writeManifest(manifestPath, {
    ...data,
    issue: {
      ...(data.issue || {}),
      number: 401,
    },
    git: {
      ...(data.git || {}),
      base_branch: "main",
      working_branch: "issue-401",
      pr_number: null,
      head_sha: "abc123",
    },
    review: {
      ...(data.review || {}),
      rounds: 1,
      latest_verdict: "pass",
      reviewer_login: "trusted-reviewer",
      last_reviewed_sha: "abc123",
    },
    paths: {
      ...(data.paths || {}),
      repo_root: repoRoot,
      worktree: path.join(repoRoot, "worktree"),
    },
  }, body);

  return { repoRoot, relayHome, binDir, manifestPath, runDir, runId: data.run_id };
}

function buildPassingReviewPayload({ headRefName = "issue-40" } = {}) {
  return {
    headRefName,
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "trusted-reviewer" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
    ],
  };
}

test("gate-check passes when the latest relay review comment is LGTM", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 2",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check blocks merge when a later review round requests changes", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
    "<!-- relay-review-round -->\n## Relay Review Round 2\nVerdict: CHANGES_REQUESTED\nIssues:\n- foo.js:1 — broken: still fails",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "changes_requested");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.issues, /foo\.js:1/);
});

test("gate-check preserves rubric fail-closed recovery details from a changes_requested review round", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
    [
      "<!-- relay-review-round -->",
      "## Relay Review Round 2",
      "Verdict: CHANGES_REQUESTED",
      "Summary: review-runner fail-closed on the rubric anchor.",
      "Reviewer verdict: PASS (next_action=ready_to_merge)",
      "Gate status: rubric_state_failed_closed",
      "Layer: review-runner",
      "Rubric state: missing (anchor status: missing)",
      "Recovery command: node skills/relay-dispatch/scripts/dispatch.js . --run-id issue-163-20260412010000000 --prompt-file <task.md> --rubric-file <fixed-rubric.yaml>",
      "Issues:",
      "- Rubric gate failed closed: Rubric file is missing. Restore or replace the missing rubric, then run `node skills/relay-dispatch/scripts/dispatch.js . --run-id issue-163-20260412010000000 --prompt-file <task.md> --rubric-file <fixed-rubric.yaml>`.",
    ].join("\n"),
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "changes_requested");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.issues, /Rubric gate failed closed/);
  assert.match(result.json.issues, /dispatch\.js \. --run-id issue-163-20260412010000000/);
});

test("gate-check blocks stale LGTM comments when a newer commit exists", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: "abc123",
        committedDate: "2026-04-03T09:00:00Z",
      },
    ],
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "stale");
  assert.equal(result.json.readyToMerge, false);
  assert.equal(result.json.latestCommit, "abc123");
});

test("gate-check uses manifest review SHA when provided", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: "new456",
        committedDate: "2026-04-03T08:00:30Z",
      },
    ],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        last_reviewed_sha: "old123",
      },
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "stale");
  assert.equal(result.json.reviewedSha, "old123");
  assert.equal(result.json.latestCommit, "new456");
});

test("gate-check ignores prose comments that only mention review markers", () => {
  const result = runGateCheckDryRun([
    [
      "Validation note:",
      "- `<!-- relay-review -->` appears in this example",
      "- `Verdict: LGTM` is just sample output",
    ].join("\n"),
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "missing");
});

test("gate-check accepts manual 'Review Verdict: PASS' as LGTM", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Review Verdict: PASS\n\n### Phase 1: Spec Compliance\nAll AC items verified.",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check accepts 'Verdict: PASS' as LGTM", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: PASS\nRounds: 1",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check blocks review from unauthorized author when reviewer_login is set", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "attacker" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: null,
      },
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "unauthorized_reviewer");
  assert.equal(result.json.readyToMerge, false);
  assert.equal(result.json.expectedReviewerLogin, "trusted-reviewer");
});

test("gate-check passes review from authorized author when reviewer_login is set", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "trusted-reviewer" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
    ],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check live PR mode blocks merge when anchor.rubric_path points to a missing file", () => {
  // #153 enforcement-path coverage — originating findings: #148 file-existence/containment, #149 manifest resolution, #151 grandfather provenance
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.REVIEW_PENDING,
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: 40,
      },
    },
  });
  createEnforcementFixture({
    repoRoot: fixture.repoRoot,
    runId: fixture.runId,
    manifestPath: fixture.manifestPath,
    state: "missing",
  });

  const result = runGateCheckWithFixture(fixture, {
    prViewPayload: buildPassingReviewPayload(),
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "missing_rubric_file");
  assert.equal(result.json.readyToMerge, false);
  assert.equal(result.json.rubricStatus, "missing");
});

test("gate-check rejects manifests whose stored run_id is invalid", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      storedRunId: "../victim-gate-run",
    },
    prViewPayload: {
      comments: [],
      commits: [],
      headRefName: "issue-40",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "manifest_resolution_failed");
  assert.match(result.json.reason, /run_id must be a single path segment/);
  assert.equal(fs.existsSync(path.join(result.relayHome, "runs", "victim-gate-run")), false);
});

test("gate-check rejects crafted manifest repo roots before stamping or merge gating", () => {
  const attackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-attacker-"));
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      state: STATES.REVIEW_PENDING,
    },
    afterManifestSetup: ({ manifestPath }) => {
      const record = readManifest(manifestPath);
      writeManifest(manifestPath, {
        ...record.data,
        paths: {
          ...(record.data.paths || {}),
          repo_root: attackerRoot,
          worktree: path.join(attackerRoot, "wt", "dev-relay"),
        },
      }, record.body);
    },
    prViewPayload: {
      comments: [],
      commits: [],
      headRefName: "issue-40",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "manifest_resolution_failed");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.reason, /manifest paths\.repo_root/);
});

test("gate-check rejects relay-base same-name worktrees before stamping or merge gating", () => {
  const fixture = createLiveGateFixture({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      state: STATES.REVIEW_PENDING,
    },
  });
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(fixture.repoRoot, fixture.relayHome);
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

  const result = runGateCheckWithFixture(fixture, {
    prViewPayload: {
      comments: [],
      commits: [],
      headRefName: "issue-40",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "manifest_resolution_failed");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.reason, /manifest paths\.worktree/);
  assert.equal(fs.existsSync(path.join(attackerWorktree, "sentinel.txt")), true);
});

test("gate-check skips unauthorized and uses authorized review when both exist", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "attacker" },
        createdAt: "2026-04-03T07:00:00Z",
      },
      {
        body: "<!-- relay-review-round -->\n## Relay Review Round 2\nVerdict: CHANGES_REQUESTED\nIssues:\n- fix this",
        author: { login: "trusted-reviewer" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: null,
      },
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "changes_requested");
  assert.equal(result.json.readyToMerge, false);
});

test("gate-check blocks review with null author when reviewer_login is set (fail-closed)", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: null,
      },
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "unauthorized_reviewer");
  assert.equal(result.json.readyToMerge, false);
});

test("gate-check author comparison is case-insensitive", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "Trusted-Reviewer" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
    ],
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check rejects merge when manifest is missing anchor.rubric_path", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
    ],
    manifest: {
      run_id: "issue-40-20260412010000000",
      anchor: {},
      review: {
        last_reviewed_sha: "abc123",
      },
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "missing_rubric_path");
  assert.equal(result.json.readyToMerge, false);
});

test("gate-check resolves the manifest in PR mode and rejects missing anchor.rubric_path", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {},
      review: {
        last_reviewed_sha: "abc123",
      },
    },
    prViewPayload: {
      headRefName: "issue-40",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "trusted-reviewer" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "missing_rubric_path");
  assert.equal(result.json.readyToMerge, false);
});

test("gate-check stamps git.pr_number on first successful PR-mode resolution and does not re-stamp", () => {
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.DISPATCHED,
      anchor: {
        rubric_path: "rubric.yaml",
        rubric_grandfathered: false,
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
  });

  const first = runGateCheckWithFixture(fixture, {
    prViewPayload: buildPassingReviewPayload(),
  });
  assert.equal(first.status, 0);
  assert.equal(first.json.status, "lgtm");

  let stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.git.pr_number, 40);

  let events = fs.readFileSync(path.join(fixture.runDir, "events.jsonl"), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "pr_number_stamped");
  assert.equal(events.length, 1);
  assert.match(events[0].reason, /git\.pr_number=40/);

  const second = runGateCheckWithFixture(fixture, {
    prViewPayload: buildPassingReviewPayload(),
  });
  assert.equal(second.status, 0);
  assert.equal(second.json.status, "lgtm");

  stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.git.pr_number, 40);
  events = fs.readFileSync(path.join(fixture.runDir, "events.jsonl"), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "pr_number_stamped");
  assert.equal(events.length, 1);
});

test("gate-check refuses merge when pr_number stamp lock times out (#185)", () => {
  // Anti-theater scope (#185): pre-fix gate-check.js:137 on c450588 returned
  // readFreshManifestRecord(manifestRecord) on timeout, which fed an unstamped
  // manifest into evaluateReviewGate() and let merge advance with
  // { status: \"lgtm\", readyToMerge: true }.
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.DISPATCHED,
      anchor: {
        rubric_path: "rubric.yaml",
        rubric_grandfathered: false,
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
  });
  const stampLockPath = path.join(fixture.runDir, ".pr_number_stamp.lock");
  fs.writeFileSync(stampLockPath, "stale peer pid 99999", { flag: "wx" });

  const blocked = runGateCheckWithFixture(fixture, {
    prViewPayload: buildPassingReviewPayload(),
    env: buildStampLockEnv(),
  });
  assert.equal(blocked.status, 1, "merge must be blocked while the stale lock remains");
  assert.equal(blocked.json.status, "manifest_resolution_failed");
  assert.equal(blocked.json.readyToMerge, false);
  assert.match(blocked.json.reason, /\.pr_number_stamp\.lock/);
  assert.match(blocked.json.reason, /stale lock|peer crash|still-running holder/i);
  assert.match(blocked.json.reason, /#185 \/ #166/);
  assert.match(blocked.json.reason, /clear it only after confirming no active holder/i);
  assert.ok(
    blocked.json.reason.includes(stampLockPath),
    `expected concrete lock path in error, got: ${blocked.json.reason}`
  );

  const blockedManifest = readManifest(fixture.manifestPath).data;
  assert.equal(blockedManifest.git.pr_number, null);

  const blockedEventsPath = path.join(fixture.runDir, "events.jsonl");
  const blockedEvents = fs.existsSync(blockedEventsPath)
    ? fs.readFileSync(blockedEventsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "pr_number_stamped")
    : [];
  assert.equal(blockedEvents.length, 0);

  fs.unlinkSync(stampLockPath);

  const recovered = runGateCheckWithFixture(fixture, {
    prViewPayload: buildPassingReviewPayload(),
    env: buildStampLockEnv(),
  });
  assert.equal(recovered.status, 0);
  assert.equal(recovered.json.status, "lgtm");
  assert.equal(recovered.json.readyToMerge, true);

  const recoveredManifest = readManifest(fixture.manifestPath).data;
  assert.equal(recoveredManifest.git.pr_number, 40);

  const recoveredEvents = fs.readFileSync(blockedEventsPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "pr_number_stamped");
  assert.equal(recoveredEvents.length, 1);
});

test("gate-check timeout path treats a fresh terminal manifest as healthy contention (#185)", () => {
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.MERGED,
      anchor: {
        rubric_path: "rubric.yaml",
        rubric_grandfathered: false,
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
  });
  const preloadPath = writeResolverOverridePreload(fixture.binDir, fixture.manifestPath, STATES.DISPATCHED);
  const stampLockPath = path.join(fixture.runDir, ".pr_number_stamp.lock");
  fs.writeFileSync(stampLockPath, "slow peer pid 99999", { flag: "wx" });

  const result = spawnSync("node", [
    SCRIPT,
    "40",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...buildStampLockEnv(),
      RELAY_HOME: fixture.relayHome,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${preloadPath}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(buildPassingReviewPayload()),
    },
  });

  assert.equal(result.status, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, "lgtm");

  const stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.state, STATES.MERGED);
  assert.equal(stored.git.pr_number, null);

  const eventsPath = path.join(fixture.runDir, "events.jsonl");
  const events = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "pr_number_stamped")
    : [];
  assert.equal(events.length, 0);
  assert.ok(fs.existsSync(stampLockPath), "timeout fast-path should not unlink a lock it never acquired");
});

test("gate-check skips first-resolution stamping when the fresh locked read is already terminal (#166)", () => {
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.MERGED,
      anchor: {
        rubric_path: "rubric.yaml",
        rubric_grandfathered: false,
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
  });
  const preloadPath = writeResolverOverridePreload(fixture.binDir, fixture.manifestPath, STATES.DISPATCHED);

  // Anti-theater scope (#166 round 4): the on-disk manifest is already terminal, but the
  // test-only resolver override feeds gate-check a stale non-terminal record so the fresh-read
  // guard is exercised directly. Before the fix, stampPrNumberUnderLock() would have stamped and
  // appended because it only re-checked git.pr_number === null after acquiring the lock.
  const result = spawnSync("node", [
    SCRIPT,
    "40",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: fixture.relayHome,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${preloadPath}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(buildPassingReviewPayload()),
    },
  });

  assert.equal(result.status, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, "lgtm");

  const stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.state, STATES.MERGED);
  assert.equal(stored.git.pr_number, null);

  const eventsPath = path.join(fixture.runDir, "events.jsonl");
  const events = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "pr_number_stamped")
    : [];
  assert.equal(events.length, 0);
});

test("gate-check produces at most one pr_number_stamped event under concurrent invocations (#166)", async () => {
  // Anti-theater scope (#166): this test asserts the post-fix invariant -
  // exactly one pr_number_stamped row in the committed journal after
  // concurrent child invocations. The pre-fix failure (3 duplicate rows
  // against gate-check.js:84-121 on `26c58fa`) was verified out-of-band
  // on a scratch branch during dispatch round 1; the committed harness
  // only exercises the fixed SCRIPT. Reviewers: to reproduce the pre-fix
  // failure, `git checkout 26c58fa -- skills/relay-merge/scripts/gate-check.js`
  // and rerun this test.
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.DISPATCHED,
      anchor: {
        rubric_path: "rubric.yaml",
        rubric_grandfathered: false,
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
  });

  const env = {
    ...process.env,
    RELAY_HOME: fixture.relayHome,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    FAKE_GH_PR_VIEW_JSON: JSON.stringify(buildPassingReviewPayload()),
  };

  function spawnGateCheckChild() {
    return new Promise((resolve) => {
      const child = spawn("node", [SCRIPT, "40", "--json"], {
        cwd: fixture.repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }

  const results = await Promise.all([
    spawnGateCheckChild(),
    spawnGateCheckChild(),
    spawnGateCheckChild(),
  ]);

  assert.ok(
    results.some((result) => result.code === 0),
    `expected at least one successful gate-check child, got ${JSON.stringify(results, null, 2)}`
  );

  const stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.git.pr_number, 40);

  const events = fs.readFileSync(path.join(fixture.runDir, "events.jsonl"), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "pr_number_stamped");

  assert.equal(
    events.length,
    1,
    `expected exactly one pr_number_stamped event, got ${events.length}: ${JSON.stringify(events, null, 2)}`
  );
  assert.match(events[0].reason, /git\.pr_number=40/);
});

test("gate-check fails closed on a historical review_pending legacy manifest sample with pr_number=null", () => {
  const fixture = createHistoricalLegacyFixture();
  const result = spawnSync("node", [
    SCRIPT,
    "401",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: fixture.relayHome,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(buildPassingReviewPayload({ headRefName: "issue-401" })),
    },
  });

  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, "manifest_resolution_failed");
  assert.equal(json.readyToMerge, false);
  assert.match(json.reason, /state=review_pending, pr=unset/);
  // Round 2 (#168 reviewer feedback): stale non-dispatched null-pr candidates must surface close-run
  // recovery text rather than the generic "pass --run-id explicitly" hint, so gate-check's historical
  // fail-closed path now inherits the state-specific stale-run recovery command.
  assert.match(json.reason, /Close the stale review_pending run/);
  assert.match(json.reason, /--reason "stale_review_pending_run"/);

  const stored = readManifest(fixture.manifestPath).data;
  assert.equal(stored.git.pr_number, null);

  const eventsPath = path.join(fixture.runDir, "events.jsonl");
  assert.equal(fs.existsSync(eventsPath), false);
});

test("gate-check PR mode fails closed when only a stale merged manifest exists on the reused branch", () => {
  const result = runGateCheckLive({
    manifest: {
      state: STATES.MERGED,
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: null,
      },
    },
    prViewPayload: buildPassingReviewPayload(),
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "manifest_resolution_failed");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.reason, /Only terminal branch matches exist/);
  assert.match(result.json.reason, /Create a fresh dispatch/);
});

test("gate-check PR mode with headRefName:null fails closed via standalone --pr when only a stale merged PR match exists", () => {
  const fixture = createLiveGateFixture({
    manifest: {
      state: STATES.MERGED,
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
      git: {
        pr_number: 42,
        working_branch: "feature-stale",
      },
    },
  });

  // Anti-theater: before #174, headRefName:null fell through to standalone --pr resolution and the
  // terminal-inclusive exact-PR selector returned the merged manifest instead of fail-closing.
  const result = spawnSync("node", [
    SCRIPT,
    "42",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: fixture.relayHome,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(buildPassingReviewPayload({ headRefName: null })),
    },
  });

  const json = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(json.status, "manifest_resolution_failed");
  assert.equal(json.readyToMerge, false);
  assert.match(json.reason, /No relay manifest found for pr '42'/);
  assert.match(json.reason, /state=merged, pr=42/);
  assert.match(json.reason, /Only terminal PR matches exist/);
  assert.match(json.reason, /create a fresh dispatch that records this PR before retrying/i);
  assert.doesNotMatch(json.reason, /close-run/i);
});

test("gate-check blocks merge when the anchored rubric file is missing at merge time", () => {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-check-missing-file-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-bin-")));
  writeFakeGh(binDir);
  const { runDir } = writeLiveManifest(repoRoot, relayHome, {
    anchor: {
      rubric_path: "rubric.yaml",
    },
    review: {
      reviewer_login: "trusted-reviewer",
      last_reviewed_sha: "abc123",
    },
  });
  fs.unlinkSync(path.join(runDir, "rubric.yaml"));

  const result = spawnSync("node", [
    SCRIPT,
    "40",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GH_PR_VIEW_JSON: JSON.stringify({
        headRefName: "issue-40",
        comments: [
          {
            body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
            author: { login: "trusted-reviewer" },
            createdAt: "2026-04-03T08:00:00Z",
          },
        ],
        commits: [
          { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
        ],
      }),
    },
  });

  const json = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(json.status, "missing_rubric_file");
  assert.equal(json.rubricStatus, "missing");
  assert.match(json.reason, /missing from the run directory/);
});

test("gate-check blocks merge when the anchored rubric file is empty", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
    rubricContent: "   \n",
    prViewPayload: {
      headRefName: "issue-40",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "trusted-reviewer" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "empty_rubric_file");
  assert.equal(result.json.rubricStatus, "empty");
  assert.match(result.json.reason, /empty/);
});

test("gate-check blocks merge when anchor.rubric_path escapes the run directory", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "../escape.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
    prViewPayload: {
      headRefName: "issue-40",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "trusted-reviewer" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "invalid_rubric_path");
  assert.equal(result.json.rubricStatus, "outside_run_dir");
  assert.match(result.json.reason, /\.\./);
});

test("gate-check blocks merge when anchor.rubric_path does not resolve to a readable rubric file", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric-dir",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
    rubricContent: false,
    prViewPayload: {
      headRefName: "issue-40",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "trusted-reviewer" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
    afterManifestSetup: ({ runDir }) => {
      fs.mkdirSync(path.join(runDir, "rubric-dir"), { recursive: true });
    },
  });

  const json = result.json;
  assert.equal(result.status, 1);
  assert.equal(json.status, "invalid_rubric_file");
  assert.equal(json.rubricStatus, "not_file");
  assert.match(json.reason, /must point to a file inside the run directory/i);
});

[
  {
    status: "missing_rubric_path",
    run: () => runGateCheckDryRun({
      comments: buildPassingReviewPayload().comments,
      commits: buildPassingReviewPayload().commits,
      manifest: {
        run_id: "issue-40-20260412010000000",
        anchor: {},
        review: {
          last_reviewed_sha: "abc123",
        },
      },
    }, { json: false }),
    output: [/run is missing anchor\.rubric_path/i, /Re-dispatch from relay-plan with --rubric-file/i],
  },
  {
    status: "missing_rubric_file",
    run: () => runGateCheckLive({
      json: false,
      manifest: {
        anchor: {
          rubric_path: "rubric.yaml",
        },
        review: {
          reviewer_login: "trusted-reviewer",
          last_reviewed_sha: "abc123",
        },
      },
      rubricContent: false,
      prViewPayload: buildPassingReviewPayload(),
    }),
    output: [/anchored rubric file is missing from the run directory/i, /Restore the anchored rubric file, or re-dispatch/i],
  },
  {
    status: "empty_rubric_file",
    run: () => runGateCheckLive({
      json: false,
      manifest: {
        anchor: {
          rubric_path: "rubric.yaml",
        },
        review: {
          reviewer_login: "trusted-reviewer",
          last_reviewed_sha: "abc123",
        },
      },
      rubricContent: "   \n",
      prViewPayload: buildPassingReviewPayload(),
    }),
    output: [/anchored rubric file is empty/i, /Regenerate the rubric with relay-plan and re-dispatch/i],
  },
  {
    status: "invalid_rubric_path",
    run: () => runGateCheckLive({
      json: false,
      manifest: {
        anchor: {
          rubric_path: "../escape.yaml",
        },
        review: {
          reviewer_login: "trusted-reviewer",
          last_reviewed_sha: "abc123",
        },
      },
      prViewPayload: buildPassingReviewPayload(),
    }),
    output: [/anchor\.rubric_path escapes the run directory/i, /Fix anchor\.rubric_path to stay inside the run directory/i],
  },
  {
    status: "invalid_rubric_file",
    run: () => runGateCheckLive({
      json: false,
      manifest: {
        anchor: {
          rubric_path: "rubric-dir",
        },
        review: {
          reviewer_login: "trusted-reviewer",
          last_reviewed_sha: "abc123",
        },
      },
      rubricContent: false,
      afterManifestSetup: ({ runDir }) => {
        fs.mkdirSync(path.join(runDir, "rubric-dir"), { recursive: true });
      },
      prViewPayload: buildPassingReviewPayload(),
    }),
    output: [/does not point to a readable rubric file/i, /Fix or restore the anchored rubric file, then re-dispatch/i],
  },
].forEach(({ status, run, output }) => {
  test(`gate-check CLI output is actionable for ${status}`, () => {
    const result = run();
    assert.equal(result.status, 1);
    output.forEach((pattern) => assert.match(result.stdout, pattern));
  });
});

test("gate-check fails closed when PR manifest resolution fails", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
    prViewPayload: {
      headRefName: "issue-missing",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "trusted-reviewer" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "manifest_resolution_failed");
  assert.equal(result.json.readyToMerge, false);
  assert.match(result.json.reason, /No relay manifest found/);
});

test("gate-check allows grandfathered runs and surfaces the note", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
    ],
    manifest: {
      run_id: "issue-40-20260412010000000",
      anchor: {
        // GRANDFATHER FIXTURE — remove after migration complete per #151
        rubric_grandfathered: true,
      },
      review: {
        last_reviewed_sha: "abc123",
      },
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
  assert.equal(result.json.rubricGrandfathered, true);
  assert.match(result.json.note, /Grandfathered pre-rubric run/);
  assert.match(result.stderr, /Grandfathered pre-rubric run/);
});

test("gate-check resolves reviewer_login in PR mode and blocks unauthorized authors", () => {
  const result = runGateCheckLive({
    manifest: {
      anchor: {
        rubric_path: "rubric.yaml",
      },
      review: {
        reviewer_login: "trusted-reviewer",
        last_reviewed_sha: "abc123",
      },
    },
    prViewPayload: {
      headRefName: "issue-40",
      comments: [
        {
          body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
          author: { login: "attacker" },
          createdAt: "2026-04-03T08:00:00Z",
        },
      ],
      commits: [
        { oid: "abc123", committedDate: "2026-04-03T07:00:00Z" },
      ],
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "unauthorized_reviewer");
  assert.equal(result.json.readyToMerge, false);
  assert.equal(result.json.expectedReviewerLogin, "trusted-reviewer");
});

test("gate-check allows any author when reviewer_login is not set", () => {
  const result = runGateCheckDryRun({
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        author: { login: "anyone" },
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [],
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.status, "lgtm");
  assert.equal(result.json.readyToMerge, true);
});

test("gate-check still blocks escalated review comments", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: ESCALATED\nIssues:\n- foo.js:1 — blocked",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "escalated");
  assert.equal(result.json.readyToMerge, false);
});
