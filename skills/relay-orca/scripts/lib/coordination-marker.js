"use strict";

function coordinationMarkerFor(programId, outcomeId, segmentEncoder) {
  if (typeof segmentEncoder !== "function") {
    throw new TypeError("coordination marker requires a program segment encoder");
  }
  return `relay-orca: ${segmentEncoder(programId)}/${outcomeId}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  coordinationMarkerFor,
  shellQuote,
};
