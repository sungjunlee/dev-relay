"use strict";

if (process.argv.includes("--supervise")) {
  const originalKill = process.kill;
  process.kill = function failGroupSignals(pid, signal) {
    if (Number(pid) < 0 && signal && signal !== 0) {
      const error = new Error("injected group signal failure");
      error.code = "EPERM";
      throw error;
    }
    return originalKill.call(this, pid, signal);
  };
}
