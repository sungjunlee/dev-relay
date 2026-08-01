const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const CLI_ARGS_IMPORT = /(?:require\([^\n]+cli-args|cli-args\")/;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name.endsWith(".js") ? [absolute] : [];
  });
}

test("every cli-args production entrypoint serves --help with its local taxonomy", () => {
  const skillsRoot = path.join(ROOT, "skills");
  const targets = walk(skillsRoot).filter((absolute) => {
    const source = fs.readFileSync(absolute, "utf8");
    return CLI_ARGS_IMPORT.test(source)
      && !absolute.endsWith(path.join("review-runner", "cli.js"));
  });

  assert.equal(targets.length, 31, "update the explicit CLI entrypoint count when adding or removing a caller");
  const failures = targets.flatMap((absolute) => {
    const result = spawnSync(process.execPath, [absolute, "--help"], { encoding: "utf8" });
    return result.status === 0 ? [] : [{
      path: path.relative(ROOT, absolute),
      status: result.status,
      stderr: result.stderr,
    }];
  });
  assert.deepEqual(failures, []);
});
