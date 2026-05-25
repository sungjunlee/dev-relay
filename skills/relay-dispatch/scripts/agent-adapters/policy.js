const ENFORCEMENT_LEVELS = Object.freeze([
  "native",
  "tool-allowlist",
  "permission-mode",
  "prompt-only",
  "informational",
  "unsupported",
]);

const ENFORCEMENT_LEVEL_SET = new Set(ENFORCEMENT_LEVELS);

class AdapterCapabilityError extends Error {
  constructor(audit, message = null) {
    super(message || formatAdapterCapabilityMessage(audit));
    this.name = "AdapterCapabilityError";
    this.audit = audit;
    this.envelope = buildAdapterCapabilityFailureEnvelope(audit, {
      error: this.message,
    });
  }
}

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function normalizeRequested(requested = {}) {
  const sandbox = normalizeString(requested.sandbox, "workspace-write");
  const network = normalizeString(requested.networkAccess ?? requested.network, "disabled");
  const readOnly = normalizeBoolean(
    requested.readOnly ?? requested.read_only,
    sandbox === "read-only"
  );
  return {
    sandbox,
    network,
    read_only: readOnly,
  };
}

function phasePolicyFor(descriptor, phase) {
  return descriptor?.capabilities?.policy?.[phase] || null;
}

function lookupPolicy(policy, field, requestedValue) {
  const values = policy?.[field];
  if (!values || typeof values !== "object") return null;
  return values[String(requestedValue)] || values.default || null;
}

function unsupportedPolicy({ adapter, field, phase, requestedValue, failClosed }) {
  const reason = `${adapter} cannot represent ${phase} ${field}=${String(requestedValue)} safely`;
  return {
    enforcement_level: "unsupported",
    mechanism: null,
    flags: [],
    warnings: [],
    fail_closed_reason: failClosed ? reason : null,
  };
}

function normalizePolicyEntry(entry, {
  adapter,
  field,
  phase,
  requestedValue,
  failClosedWhenMissing,
}) {
  const raw = entry || unsupportedPolicy({
    adapter,
    field,
    phase,
    requestedValue,
    failClosed: failClosedWhenMissing,
  });
  const level = normalizeString(raw.enforcement_level || raw.level, "unsupported");
  if (!ENFORCEMENT_LEVEL_SET.has(level)) {
    throw new Error(
      `adapter policy ${adapter}.${phase}.${field}.${String(requestedValue)} has unknown enforcement_level '${level}'`
    );
  }
  const failClosedReason = normalizeString(raw.fail_closed_reason || raw.failClosedReason);
  return {
    requested: requestedValue,
    enforcement_level: level,
    mechanism: normalizeString(raw.mechanism),
    flags: normalizeStringArray(raw.flags),
    warnings: normalizeStringArray(raw.warnings),
    fail_closed_reason: failClosedReason,
  };
}

function buildAgentPolicyAudit({ descriptor, phase, requested }) {
  const adapter = normalizeString(descriptor?.name, "unknown");
  const normalizedRequested = normalizeRequested(requested);
  const policy = phasePolicyFor(descriptor, phase);

  const sandbox = normalizePolicyEntry(lookupPolicy(policy, "sandbox", normalizedRequested.sandbox), {
    adapter,
    field: "sandbox",
    phase,
    requestedValue: normalizedRequested.sandbox,
    failClosedWhenMissing: true,
  });
  const network = normalizePolicyEntry(lookupPolicy(policy, "network", normalizedRequested.network), {
    adapter,
    field: "network",
    phase,
    requestedValue: normalizedRequested.network,
    failClosedWhenMissing: true,
  });
  const readOnly = normalizePolicyEntry(lookupPolicy(policy, "read_only", normalizedRequested.read_only), {
    adapter,
    field: "read_only",
    phase,
    requestedValue: normalizedRequested.read_only,
    failClosedWhenMissing: normalizedRequested.read_only === true,
  });

  const components = [sandbox, network, readOnly];
  const failClosedReasons = components
    .map((component) => component.fail_closed_reason)
    .filter(Boolean);
  const warnings = components.flatMap((component) => component.warnings);

  return {
    adapter,
    phase,
    requested: normalizedRequested,
    sandbox,
    network,
    read_only: readOnly,
    warnings,
    fail_closed_reasons: failClosedReasons,
    safe: failClosedReasons.length === 0,
  };
}

function assertPolicyRepresentable(audit) {
  if (!audit?.safe) {
    throw new AdapterCapabilityError(audit);
  }
  return audit;
}

function formatAdapterCapabilityMessage(audit) {
  const reasons = (audit?.fail_closed_reasons || []).filter(Boolean);
  return [
    "adapter capability denied",
    `adapter=${audit?.adapter || "unknown"}`,
    `phase=${audit?.phase || "unknown"}`,
    `reason=${reasons.join("; ") || "unsupported_capability"}`,
  ].join(" ");
}

function isAdapterCapabilityError(error) {
  return error instanceof AdapterCapabilityError
    || (error?.name === "AdapterCapabilityError" && error?.audit);
}

function buildAdapterCapabilityFailureEnvelope(errorOrAudit, extra = {}) {
  const audit = errorOrAudit?.audit || errorOrAudit;
  const message = errorOrAudit instanceof Error
    ? errorOrAudit.message
    : (extra.error || formatAdapterCapabilityMessage(audit));
  return {
    ...extra,
    status: extra.status || "failed",
    error: message,
    adapter_capability: audit,
  };
}

module.exports = {
  AdapterCapabilityError,
  ENFORCEMENT_LEVELS,
  assertPolicyRepresentable,
  buildAdapterCapabilityFailureEnvelope,
  buildAgentPolicyAudit,
  formatAdapterCapabilityMessage,
  isAdapterCapabilityError,
};
