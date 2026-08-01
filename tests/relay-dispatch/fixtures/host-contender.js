"use strict";

const fs = require("fs");
const host = require("../../../skills/relay-dispatch/scripts/host");
const [runDir, attemptId, releasePath] = process.argv.slice(2);

try {
  const lock = host.acquireRunLock({ runDir: fs.realpathSync(runDir), attemptId, operation: "concurrency", processStartedAt: "2026-07-31T00:00:00.000Z" });
  process.stdout.write(JSON.stringify({ status: "owner", lock_id: lock.lock_id }) + "\n");
  const release = () => {
    if (!releasePath || fs.existsSync(releasePath)) {
      host.releaseRunLock(lock);
      process.exit(0);
      return;
    }
    setTimeout(release, 5);
  };
  release();
} catch (error) {
  const held = error.code === "LOCK_HELD";
  process.stdout.write(JSON.stringify({ status: held ? "held" : "error", code: error.code || null }) + "\n");
  process.exit(held ? 0 : 1);
}
