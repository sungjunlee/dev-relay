const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createFleetManifest,
  normalizeFleetChild,
  readFleetManifest,
  STATES,
  updateFleetManifest,
} = require("../../../../skills/relay-dispatch/scripts/manifest/fleet");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Fleet Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-fleet@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

test("manifest/fleet updateFleetManifest rejects direct fleet_state assignment that skips the state machine", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-repo-"));
  initGitRepo(repoRoot);
  const fleetId = "issue-477";

  createFleetManifest(repoRoot, { fleetId });

  assert.throws(
    () => updateFleetManifest(repoRoot, fleetId, (fleet) => ({
      ...fleet,
      fleet_state: STATES.CLOSED,
    })),
    /Invalid relay fleet state transition: draft -> closed/
  );
  assert.equal(readFleetManifest(repoRoot, fleetId).data.fleet_state, STATES.DRAFT);
});

test("manifest/fleet normalizes optional child last_error as a bounded single-line field", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-repo-"));
  initGitRepo(repoRoot);
  const fleetId = "issue-869";
  const longMultilineError = `first line\n${"x".repeat(450)}`;

  const normalized = normalizeFleetChild({
    leaf_ref: "leaf-a",
    run_id: null,
    dispatch_status: "dispatch_failed_pre_manifest",
    last_error: longMultilineError,
  });

  assert.equal(normalized.last_error.length, 400);
  assert.doesNotMatch(normalized.last_error, /[\r\n]/);

  const emptyError = normalizeFleetChild({
    leaf_ref: "leaf-b",
    run_id: null,
    dispatch_status: "dispatch_failed_pre_manifest",
    last_error: " \n\t ",
  });
  assert.equal(Object.hasOwn(emptyError, "last_error"), false);

  createFleetManifest(repoRoot, {
    fleetId,
    children: [normalized],
  });
  assert.deepEqual(readFleetManifest(repoRoot, fleetId).data.children, [normalized]);
});
