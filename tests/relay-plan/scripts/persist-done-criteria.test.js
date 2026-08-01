"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "scripts", "persist-done-criteria.js");

test("publishes an immutable planner artifact without creating a run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-artifact-"));
  const output = path.join(root, "artifacts", "done-criteria.md");
  fs.mkdirSync(path.dirname(output));
  const text = "# Done Criteria\n\n- Exact planner outcome";
  const first = spawnSync(process.execPath, [SCRIPT, "--output", output, "--text", text, "--json"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  const canonicalOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const bytes = Buffer.from(`${text}\n`);
  assert.deepEqual(result, { path: canonicalOutput, source: "planner_artifact", sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  assert.deepEqual(fs.readFileSync(canonicalOutput), bytes);
  assert.equal(fs.existsSync(path.join(root, ".relay", "runs")), false);

  const same = spawnSync(process.execPath, [SCRIPT, "--output", output, "--text", text, "--json"], { encoding: "utf8" });
  assert.equal(same.status, 0, same.stderr);
  const conflict = spawnSync(process.execPath, [SCRIPT, "--output", output, "--text", "different"], { encoding: "utf8" });
  assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /different bytes/);
  assert.deepEqual(fs.readFileSync(output), bytes);
});

test("requires a trusted existing parent and forbids relay run preallocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-path-"));
  const missing = spawnSync(process.execPath, [SCRIPT, "--output", path.join(root, "missing", "done.md"), "--text", "x"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT|pre-existing/);

  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  fs.mkdirSync(real); fs.symlinkSync(real, linked);
  const symlink = spawnSync(process.execPath, [SCRIPT, "--output", path.join(linked, "done.md"), "--text", "x"], { encoding: "utf8" });
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /pre-existing real directory/);

  const relayHome = path.join(root, ".relay");
  const runs = path.join(relayHome, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const forbidden = spawnSync(process.execPath, [SCRIPT, "--output", path.join(runs, "done.md"), "--text", "x"], {
    encoding: "utf8", env: { ...process.env, RELAY_HOME: relayHome },
  });
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /must not preallocate/);
});

test("preserves a flag-like text value under the closed CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-flag-")); const output = path.join(root, "done.md");
  const result = spawnSync(process.execPath, [SCRIPT, "--output", output, "--text", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(output, "utf8"), "--json\n"); assert.match(result.stdout, /^Done Criteria:/);
  const retired = spawnSync(process.execPath, [SCRIPT, "--repo", root, "--run-id", "old", "--text", "x"], { encoding: "utf8" });
  assert.notEqual(retired.status, 0); assert.match(retired.stderr, /unknown flags/);
});

test("fails fast for FIFO and symlink planner inputs or existing outputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-special-"));
  const fifo = path.join(root, "input.fifo");
  execFileSync("mkfifo", [fifo]);
  const output = path.join(root, "done.md");
  const inputResult = spawnSync(process.execPath, [SCRIPT, "--output", output, "--file", fifo], { encoding: "utf8", timeout: 500 });
  assert.notEqual(inputResult.status, 0); assert.notEqual(inputResult.error?.code, "ETIMEDOUT");
  assert.match(inputResult.stderr, /not a regular file/);

  const source = path.join(root, "source.md"); fs.writeFileSync(source, "criteria\n");
  const linkedInput = path.join(root, "input-link.md"); fs.symlinkSync(source, linkedInput);
  const inputLinkResult = spawnSync(process.execPath, [SCRIPT, "--output", output, "--file", linkedInput], { encoding: "utf8", timeout: 500 });
  assert.notEqual(inputLinkResult.status, 0); assert.notEqual(inputLinkResult.error?.code, "ETIMEDOUT");
  assert.match(inputLinkResult.stderr, /not a regular file/);

  const linkedOutput = path.join(root, "output-link.md"); fs.symlinkSync(source, linkedOutput);
  const outputLinkResult = spawnSync(process.execPath, [SCRIPT, "--output", linkedOutput, "--text", "criteria"], { encoding: "utf8", timeout: 500 });
  assert.notEqual(outputLinkResult.status, 0); assert.notEqual(outputLinkResult.error?.code, "ETIMEDOUT");
  assert.match(outputLinkResult.stderr, /not a regular file/);

  const fifoOutput = path.join(root, "output.fifo"); execFileSync("mkfifo", [fifoOutput]);
  const outputFifoResult = spawnSync(process.execPath, [SCRIPT, "--output", fifoOutput, "--text", "criteria"], { encoding: "utf8", timeout: 500 });
  assert.notEqual(outputFifoResult.status, 0); assert.notEqual(outputFifoResult.error?.code, "ETIMEDOUT");
  assert.match(outputFifoResult.stderr, /not a regular file/);
});
