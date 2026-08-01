"use strict";

if (process.argv.includes("--supervise")) {
  const childProcess = require("child_process");
  const fs = require("fs");
  const originalSpawn = childProcess.spawn;
  const originalRenameSync = fs.renameSync;
  childProcess.spawn = function captureExecutorGatePid(command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (Array.isArray(args) && args.includes("--executor-gate") && process.env.RELAY_TEST_GATE_PID_PATH) {
      fs.writeFileSync(process.env.RELAY_TEST_GATE_PID_PATH, String(child.pid), "utf8");
    }
    return child;
  };
  fs.renameSync = function delayedExecutorIdentityRename(source, target) {
    if (String(target).endsWith(".executor.json")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return originalRenameSync.call(this, source, target);
  };
}
