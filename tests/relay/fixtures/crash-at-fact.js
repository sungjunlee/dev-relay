"use strict";

// Loaded only by spawned crash-matrix children. It cuts immediately before or
// after the selected production fact append without adding a runtime hook.
const path = require("node:path");

const factsPath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/facts.js");
const facts = require(factsPath);
const appendFact = facts.appendFact;

facts.appendFact = function appendWithCrash(options) {
  if (options?.fact?.type === process.env.RELAY_CRASH_BEFORE_FACT) {
    process.exit(Number(process.env.RELAY_CRASH_EXIT || 86));
  }
  const result = appendFact.apply(this, arguments);
  if (options?.fact?.type === process.env.RELAY_CRASH_AFTER_FACT) {
    process.exit(Number(process.env.RELAY_CRASH_EXIT || 86));
  }
  return result;
};
