"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONTENDER = path.join(__dirname, "..", "fixtures", "host-contender.js");

function startContender(runDir, attemptId, releasePath) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const child = spawn(process.execPath, [CONTENDER, runDir, attemptId, releasePath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n")[0];
    if (line) {
      try { resolveReady(JSON.parse(line)); } catch (error) { rejectReady(error); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", rejectReady);
  child.once("close", (code) => {
    if (!stdout.trim()) rejectReady(new Error(`contender exited before a result (${code}): ${stderr}`));
    resolveDone({ code, stderr });
  });
  return { ready, done };
}

test("50 independent processes elect exactly one owner and release permits a new owner", { timeout: 30_000 }, async () => {
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-vnext-host-concurrency-")));
  const releasePath = path.join(runDir, "release");
  const attempts = Array.from({ length: 50 }, (_, index) => startContender(runDir, `attempt-${index}`, releasePath));
  const results = await Promise.all(attempts.map((attempt) => attempt.ready));
  assert.equal(results.filter((result) => result.status === "owner").length, 1);
  assert.equal(results.filter((result) => result.status === "held").length, 49);
  fs.writeFileSync(releasePath, "release\n", "utf8");
  const done = await Promise.all(attempts.map((attempt) => attempt.done));
  assert.equal(done.every((result) => result.code === 0), true, JSON.stringify(done));
  const afterReleasePath = path.join(runDir, "after-release");
  fs.writeFileSync(afterReleasePath, "release\n", "utf8");
  const after = startContender(runDir, "after-release", afterReleasePath);
  const afterRelease = await after.ready;
  await after.done;
  assert.equal(afterRelease.status, "owner");
});
