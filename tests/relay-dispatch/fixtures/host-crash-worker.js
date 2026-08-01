"use strict";

const fs = require("fs");
const host = require("../../../skills/relay-dispatch/scripts/host");

const [runDir, worktreeDir, attemptId] = process.argv.slice(2);
const lock = host.acquireRunLock({
  runDir: fs.realpathSync(runDir),
  worktreeDir: fs.realpathSync(worktreeDir),
  attemptId,
  operation: "crash-drill",
});

fs.writeSync(1, `${JSON.stringify({ lock_id: lock.lock_id })}\n`);
process.exit(86);
