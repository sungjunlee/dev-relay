"use strict";

const fs = require("fs");
const host = require("../../../skills/relay-dispatch/scripts/host");

const [runDir, worktreeDir, attemptId, markerPath] = process.argv.slice(2);
const lock = host.acquireRunLock({
  runDir: fs.realpathSync(runDir),
  worktreeDir: fs.realpathSync(worktreeDir),
  attemptId,
  operation: "dispatch",
});
const worker = `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "completed")`;
const receipt = host.launchLocalSupervisor({
  runDir: fs.realpathSync(runDir),
  worktreeDir: fs.realpathSync(worktreeDir),
  attemptId,
  command: process.execPath,
  args: ["-e", worker],
  trustedWorktreeRoot: fs.realpathSync(worktreeDir),
  cwd: fs.realpathSync(worktreeDir),
  lockContext: lock,
});
fs.writeSync(1, `${JSON.stringify(receipt)}\n`);
