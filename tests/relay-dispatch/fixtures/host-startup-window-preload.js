"use strict";

if (process.argv.includes("--supervise")) {
  const fs = require("fs");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function delayedExecutorIdentityRename(source, target) {
    if (String(target).endsWith(".executor.json")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 22_000);
    }
    return originalRenameSync.call(this, source, target);
  };
}
