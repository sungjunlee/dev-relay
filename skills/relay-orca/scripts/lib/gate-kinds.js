"use strict";

// Exit-gate KIND parsing (#947 D1). Gate kinds are keyed by a PINNED `kind:` prefix
// convention on the exit-gate string; the prefix is matched verbatim and never
// invented, renamed, or dropped. A gate string without a recognized prefix parses as
// the `unevaluable` kind (fail closed) — NEVER as a passed gate. Pure: no I/O.

// The six pinned, verbatim gate-kind prefixes (D1). Order is stable for reporting.
const GATE_KINDS = Object.freeze(["integration", "advisory", "tracker", "decision", "budget", "authorization"]);
const GATE_KIND_SET = new Set(GATE_KINDS);

// Parse one exit-gate string into { gate, kind, ref }. `gate` is the ORIGINAL string
// (byte-preserved for the report); `kind` is one of GATE_KINDS or "unevaluable"; `ref`
// is the substring after the first `:` (the check name / record id / budget expression),
// or null when there is no recognized prefix. A non-string or empty gate has no
// recognized prefix → unevaluable (fail closed).
function parseGate(gate) {
  if (typeof gate !== "string") return { gate: String(gate), kind: "unevaluable", ref: null };
  const colon = gate.indexOf(":");
  if (colon <= 0) return { gate, kind: "unevaluable", ref: null };
  const prefix = gate.slice(0, colon);
  if (!GATE_KIND_SET.has(prefix)) return { gate, kind: "unevaluable", ref: null };
  return { gate, kind: prefix, ref: gate.slice(colon + 1) };
}

module.exports = { GATE_KINDS, GATE_KIND_SET, parseGate };
