"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Documented macOS application-bundle fallback (D3). No other absolute path may
// be embedded; never embed home-directory or user-specific absolute paths.
const MACOS_BUNDLE_FALLBACK = "/Applications/Orca.app/Contents/Resources/bin/orca";

/**
 * Resolve the Orca CLI binary.
 * Order (first hit wins): --orca-bin override → PATH → macOS bundle fallback.
 *
 * @param {object} [options]
 * @param {string|null} [options.orcaBinOverride]
 * @param {string} [options.pathEnv]
 * @param {string} [options.pathDelimiter]
 * @param {(p: string) => boolean} [options.existsSync]
 * @returns {{ path: string|null, source: "override"|"path"|"bundle"|null }}
 */
function resolveOrcaBin(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || "";
  const pathDelimiter = options.pathDelimiter || path.delimiter;
  const orcaBinOverride = options.orcaBinOverride || null;

  // First hit wins (D3). A missing/non-executable override is a MISS, not a
  // short-circuit: fall through to PATH and then the bundle so BINARY_NOT_FOUND
  // is raised only when all three ordered branches miss.
  if (orcaBinOverride && existsSync(orcaBinOverride)) {
    return { path: orcaBinOverride, source: "override" };
  }

  const dirs = pathEnv.split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "orca");
    if (existsSync(candidate)) {
      return { path: candidate, source: "path" };
    }
  }

  if (existsSync(MACOS_BUNDLE_FALLBACK)) {
    return { path: MACOS_BUNDLE_FALLBACK, source: "bundle" };
  }

  return { path: null, source: null };
}

module.exports = { resolveOrcaBin, MACOS_BUNDLE_FALLBACK };
