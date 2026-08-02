"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  translateLegacyRecovery,
} = require("../../../skills/relay-dispatch/scripts/legacy-recovery-shim");
const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");
const runStore = require("../../../skills/relay-dispatch/scripts/run-store");

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
    ], { observe: false }),
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
    ], { observe: false }),
    {
      help: false,
      argv: [
        "recover", "--run-dir", "/tmp/run/manifest", "--reason",
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
    ], { observe: false }).argv,
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
    ], { observe: false }),
    /not supported by the vNext compatibility shim/,
  );
  assert.throws(
    () => translateLegacyRecovery("publish-run", ["--repo", "/tmp/repo", "--branch", "issue-1135"], { observe: false }),
    /not supported by the vNext compatibility shim/,
  );
  assert.throws(
    () => translateLegacyRecovery("recover-state", [
      "--repo", "/tmp/repo", "--run-id", "issue-1135-20260801000000000-aaaaaaaa",
      "--to", "review_pending", "--reason", "override old state", "--force",
    ], { observe: false }),
    /not supported by the vNext compatibility shim/,
  );
});

test("every supported compatibility invocation is durably typed in the repository rollout ledger", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-shim-observation-")));
  execFileSync("git", ["init", "-q", repo]);
  translateLegacyRecovery("reconcile-run", ["--repo", repo, "--run-id", "issue-1142-20260802000000000-aaaaaaaa", "--dry-run"]);
  const store = generation.initializeStore({ checkoutRoot: repo, remote: `local/${path.basename(repo)}` });
  const observations = generation.readRolloutObservations(store).observations;
  assert.equal(observations.length, 1);
  assert.equal(observations[0].type, "legacy_surface_invoked");
  assert.deepEqual(
    { command: observations[0].payload.command, mode: observations[0].payload.mode },
    { command: "reconcile-run", mode: "inspect" },
  );
});

test("manifest-located compatibility records the exact secure legacy artifact read", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-shim-manifest-")));
  execFileSync("git", ["init", "-q", repo]);
  const manifest = path.join(repo, "legacy-run.md"), bytes = Buffer.from(`paths:\n  repo_root: '${repo}'\n`);
  fs.writeFileSync(manifest, bytes);
  translateLegacyRecovery("recover-state", ["--manifest", manifest, "--dry-run"]);
  const store = generation.initializeStore({ checkoutRoot: repo, remote: `local/${path.basename(repo)}` });
  const observations = generation.readRolloutObservations(store).observations;
  assert.deepEqual(observations.map((item) => item.type), ["legacy_artifact_read", "legacy_surface_invoked"]);
  assert.equal(observations[0].payload.artifact_name, "legacy-run.md");
  assert.equal(observations[0].payload.artifact_sha256, require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
});

test("historical manifest CLI inspects the sibling vNext run directory end to end", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-shim-e2e-"))), repo = path.join(root, "repo"), runs = path.join(root, "runs");
  fs.mkdirSync(repo); fs.mkdirSync(runs); execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "relay@example.test"]); execFileSync("git", ["-C", repo, "config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "shim e2e\n"); execFileSync("git", ["-C", repo, "add", "README.md"]); execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const runId = "issue-1142-20260802000000000-aaaaaaaa", runDir = path.join(runs, runId), manifest = path.join(runs, `${runId}.md`);
  fs.mkdirSync(runDir); fs.writeFileSync(manifest, `paths:\n  repo_root: '${repo}'\n`);
  const donePath = path.join(runDir, "done-criteria.md"); fs.writeFileSync(donePath, "done\n");
  runStore.createRunRecord({ runDir, record: { version: runStore.RUN_VERSION, run_id: runId, repo: { root: repo, remote: `local/${path.basename(repo)}` }, git: { branch: "main", base_branch: "main", worktree: repo, start_sha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, contract: { done_criteria_path: donePath, done_criteria_sha256: crypto.createHash("sha256").update("done\n").digest("hex") }, roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" }, parent: null, ownership_digest: null, created_at: "2026-08-02T00:00:00.000Z" } });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const result = spawnSync(process.execPath, [RECOVER_CLI, "recover-state", "--manifest", manifest, "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).run_id, runId);
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
