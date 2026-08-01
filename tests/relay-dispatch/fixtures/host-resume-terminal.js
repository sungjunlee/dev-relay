"use strict";

const fs = require("fs");
const host = require("../../../skills/relay-dispatch/scripts/host");

const [runDir, auditPath] = process.argv.slice(2);

try {
  const result = host.resumePendingTerminal({
    runDir: fs.realpathSync(runDir),
    audit: auditPath
      ? (entry) => {
        fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
        return { audit_key: entry.audit_key, durable: true, idempotent: true };
      }
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
