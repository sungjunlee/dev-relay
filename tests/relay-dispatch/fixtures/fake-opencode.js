#!/usr/bin/env node
"use strict";

// Fake OpenCode CLI for host/dispatch tests. Emits a configurable provider signal on
// stderr, then either stays alive (SIGTERM-immune) or exits on its own. Control knobs
// use plain environment names so they survive the host ambient-environment sanitizer
// (RELAY_* keys are host-reserved and rejected by design):
//   FAKE_OPENCODE_SIGNAL        stderr line to emit (default: insufficient_quota)
//   FAKE_OPENCODE_STAY_ALIVE    1 -> ignore SIGTERM and run until SIGKILL
//   FAKE_OPENCODE_EXIT_CODE     exit status when not staying alive (default 0)
//   FAKE_OPENCODE_EXIT_DELAY_MS delay before that self-exit (default 0)
const signal = process.env.FAKE_OPENCODE_SIGNAL || "insufficient_quota";
const stayAlive = process.env.FAKE_OPENCODE_STAY_ALIVE === "1";
const exitCode = Number(process.env.FAKE_OPENCODE_EXIT_CODE || 0);
const exitDelayMs = Number(process.env.FAKE_OPENCODE_EXIT_DELAY_MS || 0);

process.stdin.resume();
// Deterministic self-exit: even if the supervisor SIGTERMs first, the fixture exits on
// its own with its declared code, so its natural outcome is what the gate derives.
process.on("SIGTERM", () => {});
process.stderr.write(`${signal}\n`);
if (stayAlive) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(exitCode), exitDelayMs);
