#!/usr/bin/env node
/**
 * Shared sprint ownership seam for relay-merge (and future relay-fleet #957).
 *
 * Resolves which active sprint/track owns a merge so capability Learnings and
 * other per-track writers do not assume a global singleton.
 *
 * Precedence (first decisive win):
 *   1. Caller/CLI `--sprint` / `--track` / `--component` (operator override)
 *   2. Manifest/fleet owner object (no-flag default when #957 injects it)
 *   3. Structured issue `component:` metadata (standalone derivation)
 *   4. Exactly-one-active sprint fallback
 *
 * Within the winning source, contradictory fields are rejected. Losing-source
 * fields must not override or contradict the explicit choice.
 *
 * Track/component lookups consume validated dev-backlog sprint-state.js JSON
 * (schema_version >= 2). Relay does not grow a second multi-sprint markdown
 * parser for those lookups. Every sprint path is normalized to the target
 * repo's `backlog/sprints/` directory (cwd-independent; escape rejected).
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  MIN_SCHEMA_VERSION,
  discoverSprintStateBin,
  invokeSprintState,
  listSprintStateCandidates,
  normalizeRepoSprintPath,
  parseComponents,
  probeSprintStateBinary,
  validateSprintStatePayload,
} = require("./sprint-state");

const OWNER_SOURCES = Object.freeze({
  EXPLICIT_SPRINT: "explicit_sprint",
  EXPLICIT_TRACK: "explicit_track",
  EXPLICIT_COMPONENT: "explicit_component",
  FLEET: "fleet",
  ISSUE_COMPONENT: "issue_component",
  SINGLE_ACTIVE: "single_active",
});

const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function buildFailure(reason, extras = {}) {
  return { ok: false, reason, ...extras };
}

function buildOwner({
  sprintPath,
  track = null,
  component,
  source,
  schemaVersion = null,
}) {
  return {
    ok: true,
    sprintPath,
    track,
    component,
    source,
    schemaVersion,
  };
}

function isValidCapabilityName(name) {
  return typeof name === "string" && CAPABILITY_NAME_PATTERN.test(name);
}

function parseFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return null;
  const end = normalized.search(/\n---\r?\n/);
  if (end === -1) return null;
  return normalized.slice(normalized.indexOf("\n") + 1, end);
}

function readFrontmatterField(fm, field) {
  if (!fm) return null;
  const match = fm.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  if (!match) return null;
  let raw = match[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  return raw;
}

/**
 * Strict issue-body metadata parser.
 * Reads leading `key: value` lines only; stops at prose or headings.
 * Does not match incidental "component:" mentions in paragraphs.
 */
function parseIssueComponent(issueBody) {
  if (typeof issueBody !== "string" || !issueBody.trim()) return null;
  const lines = issueBody.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#/.test(trimmed)) break;
    const meta = trimmed.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/i);
    if (!meta) break;
    const key = meta[1].toLowerCase();
    let value = meta[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (key === "component") {
      return isValidCapabilityName(value) ? value : null;
    }
  }
  return null;
}

/**
 * Manifest/call seam for fleet (#957): prefer `ownership`, accept the durable
 * fleet alias retained by existing manifests.
 * Returns a partial handle object or null.
 */
function readManifestOwnership(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const raw = manifest.ownership
    || manifest.fleet_ownership
    || null;
  if (!raw || typeof raw !== "object") return null;
  const sprint = raw.sprint || raw.sprint_path || raw.sprintPath || null;
  const track = raw.track || raw.track_slug || null;
  const component = raw.component || null;
  if (!sprint && !track && !component) return null;
  return {
    sprint: sprint || null,
    track: track || null,
    component: component || null,
    source: OWNER_SOURCES.FLEET,
  };
}

function resolveFromSprintFile(sprintPath, {
  source,
  repo = null,
  readFile = fs.readFileSync,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  expectedComponent = null,
  expectedTrack = null,
} = {}) {
  if (!sprintPath) {
    return buildFailure("sprint_path_missing", { detail: "sprint path is empty" });
  }

  let resolvedPath = sprintPath;
  let trackSlug = path.basename(String(sprintPath).replace(/\\/g, "/"), ".md");
  if (repo) {
    const normalized = normalizeRepoSprintPath(repo, sprintPath, { existsSync, realpathSync });
    if (!normalized.ok) return normalized;
    resolvedPath = normalized.sprintPath;
    trackSlug = normalized.trackSlug;
  } else if (!existsSync(resolvedPath)) {
    return buildFailure("sprint_path_missing", { sprintPath: resolvedPath });
  }

  const content = readFile(resolvedPath, "utf-8");
  const fm = parseFrontmatter(content);
  if (!fm) {
    return buildFailure("sprint_frontmatter_missing", { sprintPath: resolvedPath });
  }
  const components = parseComponents(readFrontmatterField(fm, "component"));
  const declaredTrack = readFrontmatterField(fm, "track");
  const canonicalTrack = declaredTrack || trackSlug;
  if (components.length === 0) {
    return buildFailure("component_empty", {
      sprintPath: resolvedPath,
      detail: "sprint frontmatter has empty/missing component",
    });
  }
  if (components.length > 1) {
    return buildFailure("multiple_components", {
      sprintPath: resolvedPath,
      components,
      detail: `sprint lists multiple components: ${components.join(", ")}`,
    });
  }
  if (expectedComponent && components[0] !== expectedComponent) {
    return buildFailure("contradictory_owner", {
      detail: `sprint component '${components[0]}' contradicts expected '${expectedComponent}'`,
      sprintPath: resolvedPath,
      component: components[0],
    });
  }
  if (
    expectedTrack
    && expectedTrack !== canonicalTrack
    && expectedTrack !== trackSlug
    && expectedTrack !== components[0]
  ) {
    return buildFailure("contradictory_owner", {
      detail: `sprint track '${canonicalTrack}' (path slug '${trackSlug}') contradicts track '${expectedTrack}'`,
      sprintPath: resolvedPath,
      track: expectedTrack,
    });
  }
  return buildOwner({
    sprintPath: resolvedPath,
    track: canonicalTrack,
    component: components[0],
    source,
  });
}

function listActiveSprintFiles(sprintsDir, {
  readdir = fs.readdirSync,
  readFile = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  if (!existsSync(sprintsDir)) return [];
  return readdir(sprintsDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => path.join(sprintsDir, f))
    .filter((filePath) => {
      const content = readFile(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      return Boolean(fm && /^status:\s*active\s*$/m.test(fm));
    })
    .sort();
}

function resolveSingleActiveFallback(repo, fsDeps = {}) {
  const sprintsDir = path.join(repo, "backlog", "sprints");
  const active = listActiveSprintFiles(sprintsDir, fsDeps);
  if (active.length === 0) {
    return buildFailure("active_sprint_absent", { sprintsDir });
  }
  if (active.length > 1) {
    return buildFailure("multiple_active_sprints", {
      sprintsDir,
      sprintFiles: active,
    });
  }
  return resolveFromSprintFile(active[0], {
    source: OWNER_SOURCES.SINGLE_ACTIVE,
    repo,
    readFile: fsDeps.readFile || fs.readFileSync,
    existsSync: fsDeps.existsSync || fs.existsSync,
    realpathSync: fsDeps.realpathSync || fs.realpathSync,
  });
}

/**
 * Resolve a stable owner object.
 *
 * @param {object} options
 * @param {string} options.repo
 * @param {string|null} [options.sprint]
 * @param {string|null} [options.track]
 * @param {string|null} [options.component]
 * @param {object|null} [options.owner] pre-resolved / fleet partial handle
 * @param {string|null} [options.issueBody]
 * @param {Function|null} [options.sprintState] injectable sprint-state invoker
 */
function resolveSprintOwner({
  repo,
  sprint = null,
  track = null,
  component = null,
  owner = null,
  issueBody = null,
  sprintState = null,
  discoverBin = discoverSprintStateBin,
  readFile = fs.readFileSync,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  readdir = fs.readdirSync,
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
  env = process.env,
  homedir = os.homedir,
} = {}) {
  if (!repo) return buildFailure("repo_missing");
  for (const [field, value] of [["sprint", sprint], ["track", track], ["component", component]]) {
    if (typeof value === "string" && !value.trim()) {
      return buildFailure("owner_selector_empty", {
        detail: `${field} selector must not be empty`,
        field,
      });
    }
  }

  const fsDeps = { readFile, existsSync, readdir, realpathSync };
  const backlogDir = path.join(repo, "backlog");

  const runSprintState = sprintState || ((selector) => {
    const discovered = discoverBin({ env, homedir, existsSync, execFileSyncFn, nodeBin });
    if (!discovered.ok) return discovered;
    return invokeSprintState({
      binPath: discovered.path,
      backlogDir,
      repo,
      track: selector.track || null,
      component: selector.component || null,
      execFileSyncFn,
      nodeBin,
      existsSync,
      realpathSync,
    });
  });

  const injected = owner && typeof owner === "object" ? owner : null;
  const hasCallerOverride = Boolean(sprint || track || component);

  // Caller/CLI flags win wholesale over fleet/manifest. Do not merge fields
  // across sources — a losing-source track must not contradict a CLI component.
  let explicitSprint = null;
  let explicitTrack = null;
  let explicitComponent = null;
  let winningSource = null;

  if (hasCallerOverride) {
    explicitSprint = sprint || null;
    explicitTrack = track || null;
    explicitComponent = component || null;
    winningSource = "caller";
  } else if (injected) {
    explicitSprint = injected.sprint || injected.sprintPath || null;
    explicitTrack = injected.track || null;
    explicitComponent = injected.component || null;
    winningSource = injected.source === OWNER_SOURCES.FLEET ? OWNER_SOURCES.FLEET : "injected";
  }

  if (explicitTrack && explicitComponent && !explicitSprint) {
    // Within the winning source, track+component without a concrete sprint must
    // agree after resolution. CLI also rejects both selectors (matches CLI UX).
    if (winningSource === "caller") {
      return buildFailure("contradictory_owner", {
        detail: "Use only one of --track / --component on the CLI.",
        track: explicitTrack,
        component: explicitComponent,
      });
    }
  }

  if (explicitSprint) {
    const fromFile = resolveFromSprintFile(explicitSprint, {
      source: winningSource === OWNER_SOURCES.FLEET
        ? OWNER_SOURCES.FLEET
        : OWNER_SOURCES.EXPLICIT_SPRINT,
      repo,
      readFile,
      existsSync,
      realpathSync,
      expectedComponent: explicitComponent || null,
      expectedTrack: explicitTrack || null,
    });
    if (!fromFile.ok) return fromFile;
    return fromFile;
  }

  if (explicitTrack || explicitComponent) {
    const selector = explicitComponent
      ? { component: explicitComponent }
      : { track: explicitTrack };
    const resolved = runSprintState(selector);
    if (!resolved.ok) return resolved;
    if (explicitTrack && explicitComponent) {
      const trackOk = explicitTrack === resolved.track || explicitTrack === resolved.component;
      if (!trackOk) {
        return buildFailure("contradictory_owner", {
          detail: `track '${explicitTrack}' does not match resolved sprint '${resolved.track}' for component '${explicitComponent}'`,
          track: explicitTrack,
          component: explicitComponent,
          sprintPath: resolved.sprintPath,
        });
      }
    }
    if (winningSource === OWNER_SOURCES.FLEET) {
      return { ...resolved, source: OWNER_SOURCES.FLEET };
    }
    return {
      ...resolved,
      source: explicitComponent ? OWNER_SOURCES.EXPLICIT_COMPONENT : OWNER_SOURCES.EXPLICIT_TRACK,
    };
  }

  const issueComponent = parseIssueComponent(issueBody);
  if (issueComponent) {
    const resolved = runSprintState({ component: issueComponent });
    if (!resolved.ok) {
      // If sprint-state cannot resolve but exactly one active sprint matches, fall through.
      if (resolved.reason === "sprint_state_unavailable"
        || resolved.reason === "sprint_state_unresolved"
        || resolved.reason === "sprint_state_unsupported_schema"
        || resolved.reason === "sprint_state_failed"
        || resolved.reason === "sprint_state_invalid") {
        const fallback = resolveSingleActiveFallback(repo, fsDeps);
        if (fallback.ok && fallback.component === issueComponent) {
          return { ...fallback, source: OWNER_SOURCES.ISSUE_COMPONENT };
        }
        if (fallback.reason === "multiple_active_sprints") {
          return {
            ...resolved,
            issueComponent,
            sprintFiles: fallback.sprintFiles,
            detail: resolved.detail
              || "Could not resolve owning track from issue component while multiple sprints are active.",
          };
        }
      }
      return { ...resolved, issueComponent };
    }
    return { ...resolved, source: OWNER_SOURCES.ISSUE_COMPONENT, component: issueComponent };
  }

  return resolveSingleActiveFallback(repo, fsDeps);
}

module.exports = {
  OWNER_SOURCES,
  MIN_SCHEMA_VERSION,
  parseIssueComponent,
  readManifestOwnership,
  listSprintStateCandidates,
  probeSprintStateBinary,
  discoverSprintStateBin,
  normalizeRepoSprintPath,
  validateSprintStatePayload,
  invokeSprintState,
  resolveFromSprintFile,
  listActiveSprintFiles,
  resolveSingleActiveFallback,
  resolveSprintOwner,
  parseFrontmatter,
  readFrontmatterField,
  parseComponents,
  isValidCapabilityName,
};
