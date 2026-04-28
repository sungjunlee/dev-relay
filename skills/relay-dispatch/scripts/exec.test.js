"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { execGit, execGh } = require("./exec");

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
