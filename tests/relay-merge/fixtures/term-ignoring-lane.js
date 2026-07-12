#!/usr/bin/env node
// TERM-ignoring fixture for advisory-lane reap tests (#963).
// Ignores SIGTERM so finalize-run must escalate to SIGKILL.
process.on("SIGTERM", () => {});
setInterval(() => {}, 60_000);
