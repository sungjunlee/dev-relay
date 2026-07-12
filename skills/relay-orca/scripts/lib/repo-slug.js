"use strict";

// Repo-slug derivation REPLICATED (never imported) from relay's manifest/paths.js
// getRepoSlug (#945 D1): the lowercased, dash-sanitized basename of the
// canonicalized repo root joined to the first 8 hex chars of its sha256. relay-orca
// receipts live under <programs-root>/<repo-slug>/<program-id>/ so a receipt
// resolves to the SAME slug relay uses for its run manifests under <runs-root>/.
//
// Canonicalization of the repo root (git common dir + realpath) is performed by the
// top-level script and the resolved absolute path is passed in here. This module
// stays pure — no subprocess, no fs mutation — so plan.js's frozen lib source-scan
// keeps passing.
const crypto = require("node:crypto");
const path = require("node:path");

function computeRepoSlug(canonicalRepoRoot) {
  if (typeof canonicalRepoRoot !== "string" || canonicalRepoRoot.trim() === "") {
    throw new Error(
      `computeRepoSlug requires a non-empty canonical repo root, got: ${JSON.stringify(canonicalRepoRoot)}`,
    );
  }
  const base =
    path.basename(canonicalRepoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const hash = crypto.createHash("sha256").update(canonicalRepoRoot).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

module.exports = { computeRepoSlug };
