"use strict";

// Forces the run-directory claim race that the fast `existsSync` pre-check normally hides:
// report the run directory as absent once, so dispatch proceeds to the authoritative
// non-recursive mkdir and receives EEXIST from the run that really won the claim.
const fs = require("fs");

const target = process.env.RELAY_TEST_RACE_RUN_DIR;
const original = fs.existsSync;
let lied = false;

fs.existsSync = function existsSyncWithOneLie(candidate) {
  if (!lied && target && candidate === target) {
    lied = true;
    return false;
  }
  return original.call(this, candidate);
};
