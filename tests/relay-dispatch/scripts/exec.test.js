"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { execFileSync } = require("child_process");

const {
  DEFAULT_EXEC_MAX_BUFFER_BYTES,
  execGit,
  execGh,
  resolveBranchRemote,
} = require("../../../skills/relay-dispatch/scripts/exec");

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function writeStub(dir, sentinel) {
  const stubPath = path.join(dir, `${sentinel}-stub.js`);
  fs.writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(`${sentinel}\n`)});`,
    ].join("\n"),
    "utf-8"
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function writeSizedStub(dir, size) {
  const stubPath = path.join(dir, `sized-${size}-stub.js`);
  fs.writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env node",
      `process.stdout.write("x".repeat(${size}));`,
    ].join("\n"),
    "utf-8"
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

test("execGit honors RELAY_GIT_BIN override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-git-"));
  const stub = writeStub(dir, "git-sentinel");

  const output = withEnv("RELAY_GIT_BIN", stub, () => execGit(dir, ["status"]));

  assert.strictEqual(output, "git-sentinel");
});

test("execGh honors RELAY_GH_BIN override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-gh-"));
  const stub = writeStub(dir, "gh-sentinel");

  const output = withEnv("RELAY_GH_BIN", stub, () => execGh(dir, ["status"]));

  assert.strictEqual(output, "gh-sentinel");
});

test("execGit and execGh use the shared maxBuffer default and preserve caller overrides", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-buffer-"));
  const payloadBytes = 1024 * 1024 + 1024;
  const stub = writeSizedStub(dir, payloadBytes);
  assert.ok(DEFAULT_EXEC_MAX_BUFFER_BYTES > payloadBytes);

  for (const [label, envName, run] of [
    ["git", "RELAY_GIT_BIN", () => execGit(dir, ["status"], { raw: true })],
    ["gh", "RELAY_GH_BIN", () => execGh(dir, ["status"], { raw: true })],
  ]) {
    await t.test(label, () => {
      const output = withEnv(envName, stub, run);
      assert.equal(Buffer.byteLength(output, "utf-8"), payloadBytes);
      assert.throws(
        () => withEnv(envName, stub, () => (
          label === "git"
            ? execGit(dir, ["status"], { maxBuffer: 1024 })
            : execGh(dir, ["status"], { maxBuffer: 1024 })
        )),
        (error) => error?.code === "ENOBUFS"
      );
    });
  }
});

// #1083: recovery and correction scripts used to hardcode "origin", so a repo whose
// branch tracks a differently named remote had dispatch publish correctly while every
// recovery path targeted the wrong remote.
function initRepoOnBranch(dir, branch) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: "pipe" });
  git("init", "-b", branch);
  git("config", "user.name", "Relay Exec Test");
  git("config", "user.email", "relay-exec@example.com");
  return git;
}

test("resolveBranchRemote returns the branch's configured remote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-remote-"));
  const git = initRepoOnBranch(dir, "feature");
  git("config", "branch.feature.remote", "upstream");

  assert.strictEqual(resolveBranchRemote(dir, "feature"), "upstream");
});

test("resolveBranchRemote falls back to origin when unset, unknown, or branchless", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exec-remote-default-"));
  initRepoOnBranch(dir, "feature");

  assert.strictEqual(resolveBranchRemote(dir, "feature"), "origin");
  assert.strictEqual(resolveBranchRemote(dir, "never-configured"), "origin");
  assert.strictEqual(resolveBranchRemote(dir, ""), "origin");
  assert.strictEqual(resolveBranchRemote(dir, null), "origin");
});
