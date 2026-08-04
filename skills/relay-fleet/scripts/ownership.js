"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  discoverSprintStateBin,
  invokeSprintState,
  normalizeRepoSprintPath,
} = require("../../relay-merge/scripts/sprint-state");

const OWNERSHIP_FIELDS = Object.freeze(["sprint", "track", "component"]);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

class OwnershipValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "OwnershipValidationError";
  }
}

function requireOwnershipString(value, field, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OwnershipValidationError(`${label}.${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (/[\0\r\n]/.test(normalized)) {
    throw new OwnershipValidationError(`${label}.${field} must be a single-line string without NUL`);
  }
  return normalized;
}

function normalizeSprintPath(value, label) {
  let sprint = requireOwnershipString(value, "sprint", label).replace(/\\/g, "/");
  while (sprint.startsWith("./")) sprint = sprint.slice(2);

  if (sprint.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new OwnershipValidationError(`${label}.sprint must not contain dot path segments`);
  }

  const canonicalPrefix = "backlog/sprints/";
  const absoluteMarker = `/${canonicalPrefix}`;
  const isAbsolute = sprint.startsWith("/") || /^[A-Za-z]:\//.test(sprint);
  let relative = null;

  if (sprint.startsWith(canonicalPrefix)) {
    relative = sprint.slice(canonicalPrefix.length);
  } else if (isAbsolute) {
    const markerParts = sprint.split(absoluteMarker);
    if (markerParts.length === 2) relative = markerParts[1];
  }

  if (
    !relative
    || relative.includes("/")
    || !relative.endsWith(".md")
    || relative === ".md"
    || !SLUG_PATTERN.test(relative.slice(0, -3))
  ) {
    throw new OwnershipValidationError(
      `${label}.sprint must identify one markdown file under backlog/sprints/`
    );
  }
  return `${canonicalPrefix}${relative}`;
}

function normalizeSlug(value, field, label) {
  const slug = requireOwnershipString(value, field, label);
  if (!SLUG_PATTERN.test(slug)) {
    throw new OwnershipValidationError(
      `${label}.${field} must be a lowercase kebab-case slug, got ${JSON.stringify(slug)}`
    );
  }
  return slug;
}

function normalizeOwnership(raw, { label = "ownership" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OwnershipValidationError(
      `${label} must be an object with sprint, track, and component`
    );
  }

  const unexpected = Object.keys(raw).filter((key) => !OWNERSHIP_FIELDS.includes(key));
  if (unexpected.length > 0) {
    throw new OwnershipValidationError(
      `${label} may only contain ${OWNERSHIP_FIELDS.join(", ")}; unexpected: ${unexpected.join(", ")}`
    );
  }

  const sprint = normalizeSprintPath(raw.sprint, label);
  const track = normalizeSlug(raw.track, "track", label);
  const component = normalizeSlug(raw.component, "component", label);
  const sprintTrack = sprint.slice("backlog/sprints/".length, -".md".length);

  if (track !== sprintTrack) {
    throw new OwnershipValidationError(
      `${label} is contradictory: track ${JSON.stringify(track)} must equal ` +
      `the sprint filename basename ${JSON.stringify(sprintTrack)}`
    );
  }

  return Object.freeze({ sprint, track, component });
}

function validateOwnershipSprintFile(repoRoot, raw, { label = "ownership" } = {}) {
  const owner = normalizeOwnership(raw, { label });
  const sprintsRoot = path.resolve(repoRoot, "backlog", "sprints");
  const sprintPath = path.resolve(repoRoot, owner.sprint);
  const normalized = normalizeRepoSprintPath(repoRoot, owner.sprint);
  if (!normalized.ok) {
    throw new OwnershipValidationError(
      `${label}.sprint ${JSON.stringify(owner.sprint)} for track ${JSON.stringify(owner.track)} ` +
      `must resolve to an existing regular file within ${sprintsRoot} as a direct child; ` +
      `checked ${sprintPath} (${normalized.reason}: ${normalized.detail || "path validation failed"})`
    );
  }

  return owner;
}

function validateOwnershipAgainstSprintState(repoRoot, raw, {
  label = "ownership",
  env = process.env,
  homedir,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  execFileSyncFn,
  nodeBin,
} = {}) {
  const owner = validateOwnershipSprintFile(repoRoot, raw, { label });
  const discoveryOptions = { env, existsSync };
  if (homedir) discoveryOptions.homedir = homedir;
  if (execFileSyncFn) discoveryOptions.execFileSyncFn = execFileSyncFn;
  if (nodeBin) discoveryOptions.nodeBin = nodeBin;
  const discovered = discoverSprintStateBin(discoveryOptions);
  if (!discovered.ok) {
    throw new OwnershipValidationError(
      `${label} ${formatOwnership(owner)} could not be verified against trusted dev-backlog ` +
      `sprint-state schema-v2 output (${discovered.reason}): ${discovered.detail || "selector unavailable"}`
    );
  }

  const invocationOptions = {
    binPath: discovered.path,
    backlogDir: path.join(repoRoot, "backlog"),
    repo: repoRoot,
    track: owner.track,
    existsSync,
    realpathSync,
  };
  if (execFileSyncFn) invocationOptions.execFileSyncFn = execFileSyncFn;
  if (nodeBin) invocationOptions.nodeBin = nodeBin;
  const selected = invokeSprintState(invocationOptions);
  if (!selected.ok) {
    throw new OwnershipValidationError(
      `${label} ${formatOwnership(owner)} could not be verified against trusted dev-backlog ` +
      `sprint-state schema-v2 output for track ${JSON.stringify(owner.track)} ` +
      `(${selected.reason}): ${selected.detail || "selector did not resolve one owner"}`
    );
  }

  const selectedRaw = {
    sprint: path.relative(repoRoot, selected.sprintPath).split(path.sep).join("/"),
    track: selected.track,
    component: selected.component,
  };
  let selectedOwner;
  try {
    selectedOwner = normalizeOwnership(selectedRaw, {
      label: "trusted sprint-state owner",
    });
  } catch (error) {
    throw new OwnershipValidationError(
      `${label} ${formatOwnership(owner)} does not match a canonical trusted dev-backlog ` +
      `sprint-state owner returned for track ${JSON.stringify(owner.track)}: ` +
      `${JSON.stringify(selectedRaw)} (${error.message})`
    );
  }

  if (!ownershipsEqual(owner, selectedOwner)) {
    throw new OwnershipValidationError(
      `${label} ${formatOwnership(owner)} does not match trusted dev-backlog sprint-state owner ` +
      `${formatOwnership(selectedOwner)} selected for track ${JSON.stringify(owner.track)}`
    );
  }

  return owner;
}

function parseOwnershipJson(raw, { label = "--ownership-json", required = false } = {}) {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new OwnershipValidationError(
        `${label} is required and must contain sprint, track, and component`
      );
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new OwnershipValidationError(`${label} must be valid JSON: ${error.message}`);
  }
  return normalizeOwnership(parsed, { label });
}

function ownershipsEqual(left, right) {
  if (!left || !right) return left === right;
  return OWNERSHIP_FIELDS.every((field) => left[field] === right[field]);
}

function formatOwnership(owner) {
  if (!owner) return "missing";
  return JSON.stringify({
    sprint: owner.sprint,
    track: owner.track,
    component: owner.component,
  });
}

module.exports = {
  OWNERSHIP_FIELDS,
  OwnershipValidationError,
  formatOwnership,
  normalizeOwnership,
  ownershipsEqual,
  parseOwnershipJson,
  validateOwnershipAgainstSprintState,
  validateOwnershipSprintFile,
};
