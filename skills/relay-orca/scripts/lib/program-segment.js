"use strict";

// Pure collision-resistant accepted-program segment shared by receipt paths and
// runtime task markers. The readable prefix is bounded; the hash is over the full
// program id so sanitization never aliases two programs.
const crypto = require("node:crypto");

const MAX_SEGMENT_PREFIX = 64;

function programSegment(programId) {
  const raw = String(programId == null ? "" : programId);
  const sanitized = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const readable = sanitized === "" || sanitized === "." || sanitized === ".." ? "program" : sanitized;
  const base = readable.slice(0, MAX_SEGMENT_PREFIX).replace(/-+$/, "");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

module.exports = { MAX_SEGMENT_PREFIX, programSegment };
