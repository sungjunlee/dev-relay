"use strict";

// Fault injection for issue #1271: the gate exits mid-flight while Relay
// cancellation settles the attempt. The first post-settle inspection throws,
// so dispatch's main catch must salvage the typed terminal shape from durable
// facts instead of losing it to a stderr-only error. The fault fires once so
// the salvage's own read-only inspection observes real settled state.
const recoverPath = require.resolve("../../../skills/relay-dispatch/scripts/recover");
const recover = require(recoverPath);
if (process.env.RELAY_TEST_POST_SETTLE_FAULT === "1") {
  const inspectProductionRun = recover.inspectProductionRun;
  let faulted = false;
  recover.inspectProductionRun = async (input) => {
    const inspection = await inspectProductionRun(input);
    if (!faulted && inspection.facts.some((fact) => fact.type === "attempt_finished")) {
      faulted = true;
      throw new Error("simulated post-settle gate exit");
    }
    return inspection;
  };
}
