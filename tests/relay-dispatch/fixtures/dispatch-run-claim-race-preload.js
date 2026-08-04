"use strict";

// Forces the claim races that dispatch's fast `existsSync` pre-checks normally hide: report each
// named path as absent exactly once, so dispatch proceeds to the authoritative operation and
// receives the collision from the run that really won. `RELAY_TEST_RACE_ABSENT_ONCE` is a
// path-delimiter-separated list; each entry is hidden a single time.
const fs = require("fs");
const path = require("path");

const targets = new Set(String(process.env.RELAY_TEST_RACE_ABSENT_ONCE || "")
  .split(path.delimiter)
  .filter(Boolean));
const original = fs.existsSync;

fs.existsSync = function existsSyncWithOneLie(candidate) {
  if (targets.has(candidate)) {
    targets.delete(candidate);
    return false;
  }
  return original.call(this, candidate);
};
