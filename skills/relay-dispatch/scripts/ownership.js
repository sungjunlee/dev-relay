"use strict";

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
};
