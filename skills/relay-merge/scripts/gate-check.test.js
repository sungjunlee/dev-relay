const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");

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

test("gate-check still blocks escalated review comments", () => {
  const result = runGateCheckDryRun([
    "<!-- relay-review -->\n## Relay Review\nVerdict: ESCALATED\nIssues:\n- foo.js:1 — blocked",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.json.status, "escalated");
  assert.equal(result.json.readyToMerge, false);
});
