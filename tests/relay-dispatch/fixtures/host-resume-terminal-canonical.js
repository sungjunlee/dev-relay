"use strict";

const fs = require("fs");
const path = require("path");
const host = require("../../../skills/relay-dispatch/scripts/host");
const facts = require("../../../skills/relay-dispatch/scripts/facts");

const [runDir, barrierDir] = process.argv.slice(2);
const canonicalRunDir = fs.realpathSync(runDir);

try {
  const result = host.resumePendingTerminal({
    runDir: canonicalRunDir,
    audit: (entry, capability) => {
      fs.writeFileSync(path.join(barrierDir, `${process.pid}.ready`), "ready\n", "utf8");
      while (!fs.existsSync(path.join(barrierDir, "go"))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      facts.appendFact({
        eventsPath: path.join(canonicalRunDir, "events.jsonl"),
        lockContext: capability,
        fact: facts.factFromHostAudit({
          runId: path.basename(canonicalRunDir),
          eventId: `host-${entry.audit_key}`,
          at: "2026-07-31T00:00:02.000Z",
          actor: "concurrent-resume-test",
          audit: entry,
        }),
      });
      return { audit_key: entry.audit_key, durable: true, idempotent: true };
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
