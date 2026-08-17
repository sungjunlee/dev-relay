#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const cwd = value("-C");
const output = value("-o");
let controls = {};
try { controls = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
if (!cwd || !output) process.exit(64);
if (process.env.FAKE_CODEX_INVOCATION_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_INVOCATION_LOG, `${cwd}\n`, "utf8");
}
if (controls.delay_ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(controls.delay_ms));
}
fs.writeFileSync(path.join(cwd, "executor-change.txt"), "review me\n", "utf8");
if (controls.empty === true) process.exit(0);
if (controls.write_output_after_ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(controls.write_output_after_ms));
}
fs.writeFileSync(output, controls.partial_then_stall === true ? "PARTIAL\n" : "fake executor completed\n", "utf8");
if (controls.print_completion_marker === true && controls.partial_then_stall !== true) process.stderr.write("tokens used\n");
if (controls.partial_then_stall === true) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (controls.partial_then_hang === true) {
  process.on("SIGTERM", () => {});
  setInterval(() => fs.appendFileSync(output, ".", "utf8"), 50);
} else if (controls.hang_after_output === true) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
