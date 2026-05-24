const { evaluateRelayRoute, loadRelayPolicy } = require("./relay-policy");

class RelayPolicyGateError extends Error {
  constructor(decision) {
    super(formatRelayPolicyGateMessage(decision));
    this.name = "RelayPolicyGateError";
    this.decision = decision;
    this.envelope = {
      status: "failed",
      error: this.message,
      policy_decision: decision,
    };
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveActorField({ actorField, phase, executor, reviewer }) {
  if (actorField === "executor" || actorField === "reviewer") return actorField;
  if (phase === "review" || phase === "advisory_review") return "reviewer";
  if (reviewer && !executor) return "reviewer";
  return "executor";
}

function normalizeMatchedRoute(decision) {
  return decision?.matched_route || decision?.matchedRoute || null;
}

function normalizePolicyDecision(decision, context, loadResult) {
  const phase = nonEmptyString(decision?.phase) || nonEmptyString(context.phase);
  const executor = nonEmptyString(context.executor);
  const reviewer = nonEmptyString(context.reviewer);
  const actorField = resolveActorField({
    actorField: context.actorField,
    phase,
    executor,
    reviewer,
  });
  return {
    allowed: decision?.allowed === true,
    reason: nonEmptyString(decision?.reason) || "invalid_policy",
    phase,
    actor_field: actorField,
    actor: nonEmptyString(decision?.actor) || (actorField === "reviewer" ? reviewer : executor),
    executor: executor || null,
    reviewer: reviewer || null,
    model: nonEmptyString(decision?.model) || null,
    matched_route: normalizeMatchedRoute(decision),
    policy: {
      status: loadResult?.status || null,
      sources: loadResult?.sources || null,
    },
  };
}

function evaluateRelayPolicyGate({
  repoRoot = null,
  relayHome = process.env.RELAY_HOME,
  phase,
  executor = null,
  reviewer = null,
  actorField = null,
  model = null,
  policyOptions = {},
} = {}) {
  const loadResult = loadRelayPolicy({
    repoRoot,
    relayHome,
    ...policyOptions,
  });
  const routeDecision = evaluateRelayRoute(loadResult, {
    phase,
    executor,
    reviewer,
    model,
  });
  return normalizePolicyDecision(routeDecision, {
    phase,
    executor,
    reviewer,
    actorField,
  }, loadResult);
}

function formatRelayPolicyGateMessage(decision) {
  const actorField = decision?.actor_field || "actor";
  const actorValue = decision?.[actorField] || decision?.actor || "(unset)";
  const parts = [
    "relay policy denied model route",
    `phase=${decision?.phase || "(unset)"}`,
    `${actorField}=${actorValue}`,
    `model=${decision?.model || "(none)"}`,
    `reason=${decision?.reason || "unknown"}`,
  ];
  if (decision?.matched_route) {
    parts.push(`matched_route=${decision.matched_route}`);
  }
  return parts.join(" ");
}

function assertRelayPolicyGate(options = {}) {
  const decision = evaluateRelayPolicyGate(options);
  if (!decision.allowed) {
    throw new RelayPolicyGateError(decision);
  }
  return decision;
}

function isRelayPolicyGateError(error) {
  return error instanceof RelayPolicyGateError
    || (error?.name === "RelayPolicyGateError" && error?.decision);
}

function buildPolicyGateFailureEnvelope(errorOrDecision, extra = {}) {
  const decision = errorOrDecision?.decision || errorOrDecision;
  const message = errorOrDecision instanceof Error
    ? errorOrDecision.message
    : formatRelayPolicyGateMessage(decision);
  return {
    ...extra,
    status: extra.status || "failed",
    error: message,
    policy_decision: decision,
  };
}

module.exports = {
  RelayPolicyGateError,
  assertRelayPolicyGate,
  buildPolicyGateFailureEnvelope,
  evaluateRelayPolicyGate,
  formatRelayPolicyGateMessage,
  isRelayPolicyGateError,
};
