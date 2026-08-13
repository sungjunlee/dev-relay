"use strict";

// The verification CLI tests exercise durable recovery semantics, not the host
// process identity capability. The sandbox denies /bin/ps, so replace only
// that system boundary before facts.js snapshots host's lock assertion.
const host = require("../../../skills/relay-dispatch/scripts/host");
host.assertRunLockHeld = () => true;
host.withRunLock = async (options, callback) => callback({
  run_dir: options.runDir,
  operation: options.operation,
  test_capability: true,
});
