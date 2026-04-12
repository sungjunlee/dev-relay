const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createManifestSkeleton,
  createRunId,
  getManifestPath,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "gate-check.js");

function runGateCheckDryRun(payload) {
  const input = JSON.stringify(
    Array.isArray(payload)
      ? payload.map((body) => ({ body }))
      : payload
  );
  const result = spawnSync("node", [
    SCRIPT,
    "40",
    "--dry-run",
    "--json",
  ], {
    input,
    encoding: "utf-8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
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

function writeLiveManifest(repoRoot, relayHome, { anchor = {}, review = {}, git = {} } = {}) {
  process.env.RELAY_HOME = relayHome;
  const runId = createRunId({
    issueNumber: 40,
    branch: "issue-40",
    timestamp: new Date("2026-04-12T01:00:00.000Z"),
  });
  const manifestPath = getManifestPath(repoRoot, runId);
  const manifest = {
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
  writeManifest(manifestPath, manifest);
  return { manifestPath, runId };
}

function runGateCheckLive({ manifest, prViewPayload }) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-check-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-bin-")));
  writeFakeGh(binDir);
  writeLiveManifest(repoRoot, relayHome, manifest);

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
      FAKE_GH_PR_VIEW_JSON: JSON.stringify(prViewPayload),
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
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
      anchor: {
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
