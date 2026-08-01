"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  translateLegacyRecovery,
} = require("../../../skills/relay-dispatch/scripts/legacy-recovery-shim");

const ROOT = path.resolve(__dirname, "../../..");
const RECOVER_CLI = path.join(ROOT, "skills/relay/scripts/relay-recover.js");
const LEGACY_COMMANDS = [
  "reconcile-run",
  "recover-commit",
  "recover-state",
  "rebrand-evidence",
  "publish-run",
];

test("read-only legacy commands translate to canonical inspect", () => {
  assert.deepEqual(
    translateLegacyRecovery("reconcile-run", [
      "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--dry-run", "--json",
    ]),
    {
      help: false,
      argv: [
        "inspect", "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa", "--json",
      ],
    },
  );
});

test("mutating legacy commands translate to canonical recover", () => {
  assert.deepEqual(
    translateLegacyRecovery("recover-state", [
      "--manifest", "/tmp/run/manifest.md",
      "--reason", "live PR moved", "--json",
    ]),
    {
      help: false,
      argv: [
        "recover", "--run-dir", "/tmp/run", "--reason",
        "live PR moved", "--json",
      ],
    },
  );
});

test("recover-commit forwards verification bytes to canonical recovery", () => {
  assert.deepEqual(
    translateLegacyRecovery("recover-commit", [
      "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--reason", "executor exited after tests", "--test-result-file", "/tmp/result.txt",
    ]).argv,
    [
      "recover", "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--reason", "executor exited after tests", "--verification-file", "/tmp/result.txt",
    ],
  );
});

test("retired mutation policy flags fail closed instead of being silently ignored", () => {
  assert.throws(
    () => translateLegacyRecovery("rebrand-evidence", [
      "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--reason", "stale evidence", "--rebase-onto-base",
    ]),
    /not supported by the vNext compatibility shim/,
  );
  assert.throws(
    () => translateLegacyRecovery("publish-run", ["--repo", "/tmp/repo", "--branch", "issue-1135"]),
    /not supported by the vNext compatibility shim/,
  );
  assert.throws(
    () => translateLegacyRecovery("recover-state", [
      "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--to", "review_pending", "--reason", "override old state", "--force",
    ]),
    /not supported by the vNext compatibility shim/,
  );
});

test("the canonical CLI exposes migration help for every retained argv alias", () => {
  for (const command of LEGACY_COMMANDS) {
    const result = spawnSync(process.execPath, [RECOVER_CLI, command, "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /delegates to relay-recover inspect\/recover/);
  }
});

test("the canonical CLI exposes usage for an argv alias without arguments", () => {
  for (const command of LEGACY_COMMANDS) {
    const result = spawnSync(process.execPath, [RECOVER_CLI, command], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^Usage:/);
  }
});
