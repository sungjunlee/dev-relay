"use strict";

const CLINE_PROVIDER = "cline-pass";
const CLINE_MODEL_FORMAT = "modelType/model";
const CLINE_RELAY_MODEL_FORMAT = `${CLINE_PROVIDER}/${CLINE_MODEL_FORMAT}`;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatError(label, value) {
  return (
    `${label} cannot execute: Cline's --model expects ${CLINE_MODEL_FORMAT} after the ` +
    `${CLINE_PROVIDER}/ relay provider prefix. Expected relay format ` +
    `${CLINE_RELAY_MODEL_FORMAT} (for example ${CLINE_PROVIDER}/z-ai/glm-5.2); ` +
    `got ${JSON.stringify(value)}`
  );
}

function parseClineRelayModelRoute(value, { label = "Cline advisory model route" } = {}) {
  const route = nonEmptyString(value);
  if (!route) return null;

  const segments = route.split("/");
  if (
    segments.length !== 3
    || segments[0] !== CLINE_PROVIDER
    || segments.slice(1).some((segment) => !segment.trim())
  ) {
    throw new Error(formatError(label, value));
  }

  return {
    cliModel: segments.slice(1).join("/"),
    provider: CLINE_PROVIDER,
    route,
  };
}

function isPatternRoute(value) {
  return /[*?[\]]/.test(String(value || ""));
}

module.exports = {
  CLINE_MODEL_FORMAT,
  CLINE_PROVIDER,
  CLINE_RELAY_MODEL_FORMAT,
  isPatternRoute,
  parseClineRelayModelRoute,
};
