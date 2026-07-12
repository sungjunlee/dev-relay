"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Documented macOS application-bundle fallback (D3). No other absolute path may
// be embedded; never embed home-directory or user-specific absolute paths.
const MACOS_BUNDLE_FALLBACK = "/Applications/Orca.app/Contents/Resources/bin/orca";

// A candidate is a HIT only when it is a REGULAR FILE that is EXECUTABLE. A
// directory, a missing path, or a non-executable file is a MISS: the resolver
// must not hand the spawn a path it cannot run and then misclassify the failure.
function isRunnableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the Orca CLI binary.
 * Order (first hit wins): --orca-bin override → PATH → macOS bundle fallback.
 *
 * @param {object} [options]
 * @param {string|null} [options.orcaBinOverride]
 * @param {string} [options.pathEnv]
 * @param {string} [options.pathDelimiter]
 * @param {(p: string) => boolean} [options.isRunnableFile]
 * @returns {{ path: string|null, source: "override"|"path"|"bundle"|null }}
 */
function resolveOrcaBin(options = {}) {
  const runnable = options.isRunnableFile || isRunnableFile;
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH || "";
  const pathDelimiter = options.pathDelimiter || path.delimiter;
  const orcaBinOverride = options.orcaBinOverride || null;

  // First hit wins (D3). A candidate that is not a regular executable file is a
  // MISS, not a short-circuit: fall through to PATH and then the bundle so
  // BINARY_NOT_FOUND is raised only when all three ordered branches miss.
  if (orcaBinOverride && runnable(orcaBinOverride)) {
    return { path: orcaBinOverride, source: "override" };
  }

  const dirs = pathEnv.split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "orca");
    if (runnable(candidate)) {
      return { path: candidate, source: "path" };
    }
  }

  if (runnable(MACOS_BUNDLE_FALLBACK)) {
    return { path: MACOS_BUNDLE_FALLBACK, source: "bundle" };
  }

  return { path: null, source: null };
}

module.exports = { resolveOrcaBin, isRunnableFile, MACOS_BUNDLE_FALLBACK };
