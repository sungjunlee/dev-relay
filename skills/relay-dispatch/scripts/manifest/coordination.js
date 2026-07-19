"use strict";

// Generic relay coordination metadata. The value is opaque to relay: integrations may
// use it for correlation, while relay guarantees a validated single-line marker survives
// ordinary manifest rewrites.
const MAX_COORDINATION_MARKER_LENGTH = 256;

function validateCoordinationMarker(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() === "") {
    throw new Error("coordination marker must be a non-empty single-line string");
  }
  if (value !== value.trim()) {
    throw new Error("coordination marker must not have leading or trailing whitespace");
  }
  if (value.length > MAX_COORDINATION_MARKER_LENGTH) {
    throw new Error(`coordination marker must be at most ${MAX_COORDINATION_MARKER_LENGTH} characters`);
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      throw new Error("coordination marker must be a safe single-line string without control characters");
    }
  }
  return value;
}

function coordinationMarkerFromManifest(manifest) {
  return manifest && manifest.coordination && typeof manifest.coordination === "object"
    ? manifest.coordination.marker
    : undefined;
}

function withCoordinationMarker(manifest, marker) {
  return {
    ...manifest,
    coordination: {
      ...(manifest.coordination || {}),
      marker: validateCoordinationMarker(marker),
    },
  };
}

module.exports = {
  MAX_COORDINATION_MARKER_LENGTH,
  coordinationMarkerFromManifest,
  validateCoordinationMarker,
  withCoordinationMarker,
};
