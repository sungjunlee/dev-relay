#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
if (args[0] === "create-chat") {
  if (process.env.RELAY_FAKE_CURSOR_REGISTRATION_FAIL === "1") {
    process.stderr.write("registration rejected\n");
    process.exit(42);
  }
  if (process.env.RELAY_FAKE_CURSOR_DELETE_AFTER_REGISTER) {
    fs.unlinkSync(process.env.RELAY_FAKE_CURSOR_DELETE_AFTER_REGISTER);
  }
  process.stdout.write("cursor-chat-test-1\n");
  process.exit(0);
}
const index = args.indexOf("--workspace");
const worktree = index >= 0 ? args[index + 1] : null;
if (!worktree) process.exit(64);
fs.readFileSync(0);
fs.writeFileSync(path.join(worktree, "cursor-change.txt"), "cursor work\n");
process.stdout.write("cursor executor completed\n");
