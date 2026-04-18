const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getRubricAnchorStatus,
  validateRubricPathContainment,
} = require("./rubric");

test("manifest/rubric reports missing rubric paths directly", () => {
  const result = getRubricAnchorStatus({
    run_id: "issue-188-20260418091011123-a1b2c3d4",
    anchor: {},
    paths: { repo_root: "/tmp/repo" },
  }, {
    runDir: "/tmp/relay-run",
  });

  assert.equal(result.status, "missing_path");
  assert.equal(result.satisfied, false);
});

test("manifest/rubric containment rejects absolute paths", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rubric-run-"));
  const result = validateRubricPathContainment("/etc/passwd", runDir);
  assert.equal(result.valid, false);
  assert.equal(result.status, "outside_run_dir");
});
