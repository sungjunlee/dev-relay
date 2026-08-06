"use strict";

// #1173 item 1: the prompt file must be read exactly once per dispatch process. The first
// successful read of RELAY_TEST_READ_ONCE_PATH unlinks it, so a second read fails ENOENT and the
// CLI's own exit status reports the double read.
if (!process.env.NODE_TEST_CONTEXT) throw new Error("fixture read-once preload requires node:test");

const fs = require("fs");
const path = require("path");

const storePath = require.resolve("../../../skills/relay-dispatch/scripts/run-store");
const store = require(storePath);
const target = path.resolve(process.env.RELAY_TEST_READ_ONCE_PATH);

function readArtifact(filePath, label, options) {
  const artifact = store.readArtifact(filePath, label, options);
  if (path.resolve(filePath) === target) fs.unlinkSync(target);
  return artifact;
}

require.cache[storePath].exports = Object.freeze({ ...store, readArtifact });
