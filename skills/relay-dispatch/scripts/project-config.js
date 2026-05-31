const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  getCanonicalRepoRoot,
  getProjectConfigPath,
  getRepoSlug,
  nowIso,
} = require("./manifest/paths");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function listRemotes(repoRoot) {
  try {
    return execFileSync("git", ["-C", repoRoot, "remote", "-v"], {
      encoding: "utf-8",
      stdio: "pipe",
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
  } catch {
    return [];
  }
}

function displayNameFromRepo(repoRoot, remotes = []) {
  const firstRemote = remotes[0] || "";
  const githubMatch = firstRemote.match(/github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?$/i);
  if (githubMatch) return githubMatch[1];
  return path.basename(repoRoot);
}

function createProjectConfig({ repoRoot, now = nowIso() } = {}) {
  const canonicalRepoRoot = getCanonicalRepoRoot(repoRoot);
  const remotes = listRemotes(canonicalRepoRoot);
  return validateProjectConfig({
    version: 1,
    repo_slug: getRepoSlug(canonicalRepoRoot),
    display_name: displayNameFromRepo(canonicalRepoRoot, remotes),
    canonical_repo_root: canonicalRepoRoot,
    remotes,
    created_at: now,
    updated_at: now,
  }, "generated project config");
}

function validateStringArray(value, fieldName, sourceLabel) {
  if (!Array.isArray(value)) {
    throw new Error(`invalid project config at ${sourceLabel}: ${fieldName} must be an array`);
  }
  return value.map((item, index) => {
    const normalized = nonEmptyString(item);
    if (!normalized) {
      throw new Error(`invalid project config at ${sourceLabel}: ${fieldName}[${index}] must be a non-empty string`);
    }
    return normalized;
  });
}

function validateProjectConfig(config, sourceLabel = "project config") {
  if (!isPlainObject(config)) {
    throw new Error(`invalid project config at ${sourceLabel}: expected object`);
  }
  if (config.version !== 1) {
    throw new Error(`invalid project config at ${sourceLabel}: version must be 1`);
  }
  const requiredStrings = [
    "repo_slug",
    "display_name",
    "canonical_repo_root",
    "created_at",
    "updated_at",
  ];
  const normalized = cloneJson(config);
  for (const field of requiredStrings) {
    const value = nonEmptyString(config[field]);
    if (!value) {
      throw new Error(`invalid project config at ${sourceLabel}: ${field} must be a non-empty string`);
    }
    normalized[field] = value;
  }
  normalized.remotes = validateStringArray(config.remotes || [], "remotes", sourceLabel);
  return normalized;
}

function readProjectConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`failed to read project config at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse project config at ${filePath}: ${error.message}`);
  }
}

function loadProjectConfig({ repoRoot, relayHome } = {}) {
  let filePath;
  try {
    filePath = getProjectConfigPath(repoRoot, { relayHome });
  } catch (error) {
    return {
      ok: false,
      status: "error",
      path: null,
      config: null,
      error: error.message,
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      status: "absent",
      path: filePath,
      config: null,
      error: null,
    };
  }

  try {
    return {
      ok: true,
      status: "ok",
      path: filePath,
      config: validateProjectConfig(readProjectConfigFile(filePath), filePath),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      path: filePath,
      config: null,
      error: error.message,
    };
  }
}

function writeProjectConfig({ repoRoot, relayHome, config } = {}) {
  const filePath = getProjectConfigPath(repoRoot, { relayHome });
  const normalized = validateProjectConfig(config, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

module.exports = {
  createProjectConfig,
  loadProjectConfig,
  validateProjectConfig,
  writeProjectConfig,
};
