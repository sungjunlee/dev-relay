#!/usr/bin/env node
"use strict";

const signal = process.env.FAKE_OPENCODE_SIGNAL || "insufficient_quota";
const stayAlive = process.env.FAKE_OPENCODE_STAY_ALIVE === "1";
const exitCode = Number(process.env.FAKE_OPENCODE_EXIT_CODE || 0);
const exitDelayMs = Number(process.env.FAKE_OPENCODE_EXIT_DELAY_MS || 0);

process.stdin.resume();
process.on("SIGTERM", () => { if (process.env.FAKE_OPENCODE_EXIT_ON_TERM === "1") process.exit(0); });
process.stderr.write(`${signal}\n`);
if (stayAlive) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(exitCode), exitDelayMs);
