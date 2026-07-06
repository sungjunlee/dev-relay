const { buildPolicyGateFailureEnvelope, isRelayPolicyGateError } = require("../../../relay-dispatch/scripts/relay-policy-gate");
const { buildAdapterCapabilityFailureEnvelope, isAdapterCapabilityError } = require("../../../relay-dispatch/scripts/agent-adapters/policy");
const {
  hintForCliFailure,
  hintForPolicyDecision,
  withHint,
} = require("../../../relay-dispatch/scripts/route-failure-hints");

function emitJsonFailure(error, { jsonOut }) {
  let hint = null;
  if (jsonOut && isRelayPolicyGateError(error)) {
    const envelope = buildPolicyGateFailureEnvelope(error, {
      ok: false,
      ...(error.adapterCapability ? { adapter_capability: error.adapterCapability } : {}),
    });
    hint = hintForPolicyDecision(envelope.policy_decision);
    console.log(JSON.stringify(withHint(envelope, hint), null, 2));
  } else if (jsonOut && isAdapterCapabilityError(error)) {
    console.log(JSON.stringify(buildAdapterCapabilityFailureEnvelope(error, { ok: false }), null, 2));
  } else {
    hint = hintForCliFailure(error);
    if (jsonOut && hint) {
      console.log(JSON.stringify({
        status: "failed",
        error: error.message,
        hint,
      }, null, 2));
    }
  }
  return hint;
}

function printFailureAndExit(error, { jsonOut }) {
  let hint = emitJsonFailure(error, { jsonOut });
  if (!hint && isRelayPolicyGateError(error)) hint = hintForPolicyDecision(error.decision);
  if (!hint) hint = hintForCliFailure(error);
  console.error(`Error: ${error.message}`);
  if (hint) console.error(`hint: ${hint}`);
  process.exit(1);
}

module.exports = {
  printFailureAndExit,
};
