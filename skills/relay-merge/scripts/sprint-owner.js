#!/usr/bin/env node
/**
 * Shared sprint ownership seam for relay-merge (and future relay-fleet #957).
 *
 * Resolves which active sprint/track owns a merge so capability Learnings and
 * other per-track writers do not assume a global singleton.
 *
 * Precedence (first decisive win):
 *   1. Explicit owner object (fleet/manifest injection)
 *   2. Explicit --sprint path
 *   3. Explicit --track OR --component (mutually exclusive; both → reject)
 *   4. Structured issue `component:` metadata (standalone derivation)
 *   5. Exactly-one-active sprint fallback
 *
 * Track/component lookups consume validated dev-backlog sprint-state.js JSON
 * (schema_version >= 2). Relay does not grow a second multi-sprint markdown
 * parser for those lookups.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const OWNER_SOURCES = Object.freeze({
  EXPLICIT_SPRINT: "explicit_sprint",
  EXPLICIT_TRACK: "explicit_track",
  EXPLICIT_COMPONENT: "explicit_component",
  FLEET: "fleet",
  ISSUE_COMPONENT: "issue_component",
  SINGLE_ACTIVE: "single_active",
});

const MIN_SCHEMA_VERSION = 2;

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
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const normalized = content.replace(/^\uFEFF/, "");
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

function parseComponents(fmValue) {
  if (!fmValue) return [];
  return fmValue.split(",").map((s) => s.trim()).filter(Boolean);
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
 * Manifest/call seam for fleet (#957): prefer `ownership`, accept legacy aliases.
 * Returns a partial handle object or null.
 */
function readManifestOwnership(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const raw = manifest.ownership
    || manifest.fleet_ownership
    || manifest.routing?.ownership
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

function listSprintStateCandidates({
  env = process.env,
  homedir = os.homedir,
  existsSync = fs.existsSync,
} = {}) {
  const home = homedir();
  const fromEnv = [];
  if (env.RELAY_SPRINT_STATE_BIN) fromEnv.push(env.RELAY_SPRINT_STATE_BIN);
  if (env.RELAY_DEV_BACKLOG_ROOT) {
    fromEnv.push(path.join(env.RELAY_DEV_BACKLOG_ROOT, "scripts", "sprint-state.js"));
    fromEnv.push(path.join(env.RELAY_DEV_BACKLOG_ROOT, "skills", "dev-backlog", "scripts", "sprint-state.js"));
  }

  const skillRoots = [
    path.join(home, ".agents", "skills", "dev-backlog", "scripts", "sprint-state.js"),
    path.join(home, ".claude", "skills", "dev-backlog", "scripts", "sprint-state.js"),
    path.join(home, ".codex", "skills", "dev-backlog", "scripts", "sprint-state.js"),
  ];

  const seen = new Set();
  const out = [];
  for (const candidate of [...fromEnv, ...skillRoots]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

function probeSprintStateBinary(binPath, {
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
} = {}) {
  let help = "";
  try {
    help = execFileSyncFn(nodeBin, [binPath, "--help"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    help = `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`;
  }
  const text = String(help || "");
  const supportsSelectors = /--track/.test(text) && /--component/.test(text);
  return {
    path: binPath,
    supportsSelectors,
    help: text,
  };
}

function discoverSprintStateBin({
  env = process.env,
  homedir = os.homedir,
  existsSync = fs.existsSync,
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
} = {}) {
  const candidates = listSprintStateCandidates({ env, homedir, existsSync });
  if (candidates.length === 0) {
    return buildFailure("sprint_state_unavailable", {
      detail: "No sprint-state.js candidate found. Set RELAY_SPRINT_STATE_BIN to a schema_version>=2 binary.",
      candidates: [],
    });
  }

  const probed = [];
  for (const candidate of candidates) {
    const probe = probeSprintStateBinary(candidate, { execFileSyncFn, nodeBin });
    probed.push(probe);
    if (probe.supportsSelectors) {
      return { ok: true, path: candidate, probed };
    }
  }

  return buildFailure("sprint_state_unavailable", {
    detail: "Found sprint-state.js but none advertise --track/--component (need schema_version>=2). Set RELAY_SPRINT_STATE_BIN to a current dev-backlog checkout.",
    candidates: probed.map((p) => p.path),
  });
}

function validateSprintStatePayload(payload, { track = null, component = null } = {}) {
  if (!payload || typeof payload !== "object") {
    return buildFailure("sprint_state_invalid", { detail: "payload is not an object" });
  }
  const schemaVersion = Number(payload.schema_version);
  if (!Number.isFinite(schemaVersion) || schemaVersion < MIN_SCHEMA_VERSION) {
    return buildFailure("sprint_state_unsupported_schema", {
      schemaVersion: payload.schema_version ?? null,
      detail: `Expected schema_version >= ${MIN_SCHEMA_VERSION}`,
    });
  }

  const active = payload.active_sprint;
  if (!active || typeof active !== "object" || !active.path) {
    return buildFailure("sprint_state_unresolved", {
      schemaVersion,
      track,
      component,
      activeSprints: Array.isArray(payload.active_sprints)
        ? payload.active_sprints.map((s) => s?.active_sprint?.path || s?.path || null).filter(Boolean)
        : [],
      detail: "sprint-state returned no single active_sprint for the selector",
    });
  }

  const fm = active.frontmatter || {};
  const componentRaw = typeof fm.component === "string" ? fm.component.trim() : "";
  const components = parseComponents(componentRaw);
  if (components.length === 0) {
    return buildFailure("component_empty", {
      sprintPath: active.path,
      schemaVersion,
    });
  }
  if (components.length > 1) {
    return buildFailure("multiple_components", {
      sprintPath: active.path,
      components,
      schemaVersion,
    });
  }
  if (component && components[0] !== component) {
    return buildFailure("contradictory_owner", {
      detail: `selector component '${component}' does not match sprint component '${components[0]}'`,
      sprintPath: active.path,
      component: components[0],
      schemaVersion,
    });
  }

  const trackSlug = path.basename(active.path, ".md");
  return buildOwner({
    sprintPath: active.path,
    track: trackSlug,
    component: components[0],
    source: track ? OWNER_SOURCES.EXPLICIT_TRACK : OWNER_SOURCES.EXPLICIT_COMPONENT,
    schemaVersion,
  });
}

function invokeSprintState({
  binPath,
  backlogDir,
  track = null,
  component = null,
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
}) {
  if (track && component) {
    return buildFailure("contradictory_owner", {
      detail: "Use only one of track / component (matches sprint-state.js).",
      track,
      component,
    });
  }
  if (!track && !component) {
    return buildFailure("sprint_state_invalid", { detail: "track or component required" });
  }

  const args = [binPath, "--json"];
  if (track) args.push("--track", track);
  if (component) args.push("--component", component);
  args.push(backlogDir);

  let stdout = "";
  try {
    stdout = execFileSyncFn(nodeBin, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr || error.message || "").trim();
    return buildFailure("sprint_state_failed", {
      detail: stderr || "sprint-state.js exited non-zero",
      track,
      component,
      binPath,
    });
  }

  let payload;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch (error) {
    return buildFailure("sprint_state_invalid", {
      detail: `JSON parse failed: ${error.message}`,
      binPath,
    });
  }

  const validated = validateSprintStatePayload(payload, { track, component });
  if (!validated.ok) return validated;
  return {
    ...validated,
    source: track ? OWNER_SOURCES.EXPLICIT_TRACK : OWNER_SOURCES.EXPLICIT_COMPONENT,
  };
}

function resolveFromSprintFile(sprintPath, {
  source,
  readFile = fs.readFileSync,
  existsSync = fs.existsSync,
  expectedComponent = null,
} = {}) {
  if (!sprintPath) {
    return buildFailure("sprint_path_missing", { detail: "sprint path is empty" });
  }
  if (!existsSync(sprintPath)) {
    return buildFailure("sprint_path_missing", { sprintPath });
  }
  const content = readFile(sprintPath, "utf-8");
  const fm = parseFrontmatter(content);
  if (!fm) {
    return buildFailure("sprint_frontmatter_missing", { sprintPath });
  }
  const components = parseComponents(readFrontmatterField(fm, "component"));
  if (components.length === 0) {
    return buildFailure("component_empty", { sprintPath });
  }
  if (components.length > 1) {
    return buildFailure("multiple_components", { sprintPath, components });
  }
  if (expectedComponent && components[0] !== expectedComponent) {
    return buildFailure("contradictory_owner", {
      detail: `sprint component '${components[0]}' contradicts expected '${expectedComponent}'`,
      sprintPath,
      component: components[0],
    });
  }
  return buildOwner({
    sprintPath,
    track: path.basename(sprintPath, ".md"),
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
    readFile: fsDeps.readFile || fs.readFileSync,
    existsSync: fsDeps.existsSync || fs.existsSync,
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
  readdir = fs.readdirSync,
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
  env = process.env,
  homedir = os.homedir,
} = {}) {
  if (!repo) return buildFailure("repo_missing");

  const fsDeps = { readFile, existsSync, readdir };
  const backlogDir = path.join(repo, "backlog");

  const runSprintState = sprintState || ((selector) => {
    const discovered = discoverBin({ env, homedir, existsSync, execFileSyncFn, nodeBin });
    if (!discovered.ok) return discovered;
    return invokeSprintState({
      binPath: discovered.path,
      backlogDir,
      track: selector.track || null,
      component: selector.component || null,
      execFileSyncFn,
      nodeBin,
    });
  });

  // Normalize injected owner / fleet flags into a single first-class handle set.
  const injected = owner && typeof owner === "object" ? owner : null;
  let explicitSprint = sprint || injected?.sprint || injected?.sprintPath || null;
  let explicitTrack = track || injected?.track || null;
  let explicitComponent = component || injected?.component || null;
  const injectedSource = injected?.source || null;

  // When a concrete sprint path is present it wins; track/component are only
  // validated against that file. Bare track+component without sprint: prefer
  // component for sprint-state lookup, then require track agreement when both
  // are present (fleet may supply both). Reject only when they disagree after
  // resolution, or when both are CLI selectors without an owner object.
  const cliTrackAndComponent = Boolean(track && component && !sprint && !injected);
  if (cliTrackAndComponent) {
    return buildFailure("contradictory_owner", {
      detail: "Use only one of --track / --component on the CLI.",
      track: explicitTrack,
      component: explicitComponent,
    });
  }

  if (explicitSprint) {
    const resolvedPath = path.isAbsolute(explicitSprint)
      ? explicitSprint
      : path.resolve(repo, explicitSprint);
    const fromFile = resolveFromSprintFile(resolvedPath, {
      source: injectedSource === OWNER_SOURCES.FLEET ? OWNER_SOURCES.FLEET : OWNER_SOURCES.EXPLICIT_SPRINT,
      readFile,
      existsSync,
      expectedComponent: explicitComponent || null,
    });
    if (!fromFile.ok) return fromFile;
    if (explicitTrack && fromFile.track !== explicitTrack && path.basename(resolvedPath, ".md") !== explicitTrack) {
      return buildFailure("contradictory_owner", {
        detail: `sprint path track '${fromFile.track}' contradicts track '${explicitTrack}'`,
        sprintPath: fromFile.sprintPath,
        track: explicitTrack,
      });
    }
    return fromFile;
  }

  if (explicitTrack || explicitComponent) {
    const selector = explicitComponent
      ? { component: explicitComponent }
      : { track: explicitTrack };
    const resolved = runSprintState(selector);
    if (!resolved.ok) return resolved;
    if (explicitTrack && explicitComponent && resolved.track !== explicitTrack) {
      return buildFailure("contradictory_owner", {
        detail: `track '${explicitTrack}' does not match resolved sprint '${resolved.track}' for component '${explicitComponent}'`,
        track: explicitTrack,
        component: explicitComponent,
        sprintPath: resolved.sprintPath,
      });
    }
    if (injectedSource === OWNER_SOURCES.FLEET) {
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
