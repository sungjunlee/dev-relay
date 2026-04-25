const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getRunDir } = require("../../relay-dispatch/scripts/manifest/paths");

const SCRIPT = path.join(__dirname, "persist-done-criteria.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-dc-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Plan Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-plan@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { repoRoot, relayHome };
}

test("persist-done-criteria writes canonical planner decision anchor and returns JSON", () => {
  const { repoRoot, relayHome } = setupRepo();
  const runId = "issue-294-20260425010101000-deadbeef";
  const env = { ...process.env, RELAY_HOME: relayHome };
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;

  try {
    const stdout = execFileSync(process.execPath, [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--text", "# Done Criteria\n\n- Follow Phase 1 planner decision",
      "--json",
    ], { encoding: "utf-8", stdio: "pipe", env });

    const result = JSON.parse(stdout);
    const expectedPath = path.join(getRunDir(repoRoot, runId), "done-criteria.md");
    assert.deepEqual(result, { path: expectedPath, source: "planner_decision" });
    assert.equal(
      fs.readFileSync(expectedPath, "utf-8"),
      "# Done Criteria\n\n- Follow Phase 1 planner decision\n"
    );
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
});
