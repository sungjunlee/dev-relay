#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("-C");
const outputIndex = args.indexOf("-o");
const worktree = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
let controls = {};
try { controls = JSON.parse(fs.readFileSync(0, "utf8")); }
catch { try { controls = JSON.parse(args.at(-1)); } catch {} }
const attempts = [
  ["worktree", path.join(worktree, "worktree-write.txt")],
  ["active", controls.active],
  ["sibling", controls.sibling],
  ["outside", controls.outside],
];
const proof = { tempdir: process.env.TMPDIR || null };
function commandProbe(label, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: worktree, encoding: "utf8" });
  proof[label] = result.status === 0 ? "allowed" : `denied:${result.error?.code || result.status || "unknown"}`;
}
for (const [label, target] of attempts) {
  try {
    fs.writeFileSync(target, `${label} escaped\n`);
    proof[label] = "written";
  } catch (error) {
    proof[label] = `denied:${error.code || "unknown"}`;
  }
}
try {
  fs.writeFileSync(path.join(proof.tempdir, "temp-write.txt"), "private temp\n");
  proof.temp = "written";
} catch (error) {
  proof.temp = `denied:${error.code || "unknown"}`;
}
const appleEvent = spawnSync("/usr/bin/osascript", ["-e", 'tell application "Finder" to get name'], { encoding: "utf8" });
proof.apple_event = appleEvent.status === 0 ? "allowed" : `denied:${appleEvent.error?.code || appleEvent.status || "unknown"}`;
commandProbe("git_add", "git", ["add", "worktree-write.txt"]);
commandProbe("git_commit", "git", ["commit", "--allow-empty", "-m", "executor must not commit"]);
commandProbe("git_ref", "git", ["update-ref", "refs/heads/relay-executor-escape", "HEAD"]);
commandProbe("git_config", "git", ["config", "--local", "relay.executor-escape", "true"]);
const commonDirProbe = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8" });
if (commonDirProbe.status === 0) {
  try {
    fs.writeFileSync(path.join(commonDirProbe.stdout.trim(), "hooks", "relay-executor-escape"), "#!/bin/sh\n");
    proof.git_hook = "allowed";
  } catch (error) {
    proof.git_hook = `denied:${error.code || "unknown"}`;
  }
} else {
  proof.git_hook = `denied:${commonDirProbe.error?.code || commonDirProbe.status || "unknown"}`;
}

function finish() {
  const badWrite = ["active", "sibling", "outside"].some((label) => proof[label] === "written");
  const bytes = `${JSON.stringify(proof)}\n`;
  if (controls.proof_in_result === true) {
    if (output) fs.writeFileSync(output, bytes);
  } else {
    fs.writeFileSync(path.join(worktree, "containment-proof.json"), bytes);
    if (output) fs.writeFileSync(output, "executor stayed contained\n");
  }
  const gitMetadataWrite = ["git_add", "git_commit", "git_ref", "git_config", "git_hook"]
    .some((label) => proof[label] === "allowed");
  if (badWrite || gitMetadataWrite || proof.network === "connected" || proof.apple_event === "allowed") process.exitCode = 90;
}

if (controls.port) {
  const socket = net.connect({ host: "127.0.0.1", port: Number(controls.port) });
  let settled = false;
  const settle = (value) => {
    if (settled) return;
    settled = true;
    proof.network = value;
    socket.destroy();
    finish();
  };
  socket.once("connect", () => settle("connected"));
  socket.once("error", (error) => settle(`denied:${error.code || "unknown"}`));
  socket.setTimeout(2000, () => settle("denied:timeout"));
} else {
  proof.network = "not_requested";
  finish();
}
