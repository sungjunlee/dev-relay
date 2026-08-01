"use strict";

const fs = require("fs");
const path = require("path");
const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");

const [rawRunDir, rawWorktreeDir] = process.argv.slice(2);
if (!rawRunDir) process.exit(2);
const runDir = fs.realpathSync(rawRunDir);
const worktreeDir = fs.realpathSync(rawWorktreeDir || process.cwd());
const eventsPath = path.join(runDir, "events.jsonl");
const lock = host.acquireRunLock({
  runDir,
  attemptId: "attempt-1",
  operation: "recover",
  hostKind: "local_supervisor",
  hostHandle: `dead-owner-${process.pid}`,
  worktreeDir,
  audit(audit, capability) {
    facts.appendFact({
      eventsPath,
      lockContext: capability,
      fact: facts.factFromHostAudit({
        runId: path.basename(runDir),
        eventId: `lock-${process.pid}`,
        at: new Date().toISOString(),
        actor: "dead-owner-fixture",
        audit,
      }),
    });
  },
});
process.stdout.write(`${JSON.stringify(lock)}\n`);
process.exit(0);
