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
    path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "skills", "dev-backlog", "scripts", "sprint-state.js"),
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

/**
 * Resolve a sprint path against the target repo and require containment under
 * `<repo>/backlog/sprints/` (realpath-aware). Relative paths resolve against
 * `repo`, never `process.cwd()`. Absolute paths that escape may remap when they
 * still end with `backlog/sprints/<file>`.
 */
function normalizeRepoSprintPath(repo, sprintPath, {
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  if (!repo) return buildFailure("repo_missing");
  if (typeof sprintPath !== "string" || !sprintPath.trim()) {
    return buildFailure("sprint_path_invalid", {
      detail: "sprint path is empty",
      sprintPath,
    });
  }
  if (sprintPath.includes("\0")) {
    return buildFailure("sprint_path_invalid", {
      detail: "sprint path contains NUL",
      sprintPath,
    });
  }

  const sprintsDir = path.join(repo, "backlog", "sprints");
  const raw = sprintPath.trim();
  const posix = raw.replace(/\\/g, "/");
  const marker = "backlog/sprints/";
  const markerIdx = posix.lastIndexOf(marker);

  function tryContainment(absPath) {
    if (!existsSync(sprintsDir)) {
      return buildFailure("sprint_path_missing", { sprintPath: absPath, sprintsDir });
    }
    if (!existsSync(absPath)) {
      return buildFailure("sprint_path_missing", { sprintPath: absPath });
    }
    let realSprints;
    let realFile;
    try {
      realSprints = realpathSync(sprintsDir);
      realFile = realpathSync(absPath);
    } catch (error) {
      return buildFailure("sprint_path_missing", {
        sprintPath: absPath,
        detail: error.message,
      });
    }
    const rel = path.relative(realSprints, realFile);
    if (
      !rel
      || rel === ".."
      || rel.startsWith(`..${path.sep}`)
      || path.isAbsolute(rel)
      || rel.split(path.sep).includes("..")
    ) {
      return buildFailure("sprint_path_escaped", {
        detail: `sprint path must resolve under ${sprintsDir}`,
        sprintPath: absPath,
        sprintsDir,
      });
    }
    return {
      ok: true,
      sprintPath: path.join(sprintsDir, rel),
      trackSlug: path.basename(rel, ".md"),
    };
  }

  const candidate = path.isAbsolute(raw) ? raw : path.resolve(repo, raw);
  let result = tryContainment(candidate);
  if (!result.ok && path.isAbsolute(raw) && markerIdx !== -1) {
    result = tryContainment(path.join(repo, posix.slice(markerIdx)));
  }
  return result;
}

function validateSprintStatePayload(payload, {
  track = null,
  component = null,
  repo = null,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return buildFailure("sprint_state_invalid", {
      detail: "payload is not an object",
    });
  }
  const schemaVersion = Number(payload.schema_version);
  if (!Number.isFinite(schemaVersion) || schemaVersion < MIN_SCHEMA_VERSION) {
    return buildFailure("sprint_state_unsupported_schema", {
      schemaVersion: payload.schema_version ?? null,
      detail: `Expected schema_version >= ${MIN_SCHEMA_VERSION}`,
    });
  }

  const active = payload.active_sprint;
  if (!active || typeof active !== "object" || Array.isArray(active) || !active.path) {
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
      detail: "active_sprint frontmatter has empty/missing component",
    });
  }
  if (components.length > 1) {
    return buildFailure("multiple_components", {
      sprintPath: active.path,
      components,
      schemaVersion,
      detail: `active_sprint lists multiple components: ${components.join(", ")}`,
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

  let sprintPath = active.path;
  let trackSlug = path.basename(String(active.path).replace(/\\/g, "/"), ".md");
  if (repo) {
    const normalized = normalizeRepoSprintPath(repo, active.path, { existsSync, realpathSync });
    if (!normalized.ok) return { ...normalized, schemaVersion };
    sprintPath = normalized.sprintPath;
    trackSlug = normalized.trackSlug;
  }

  // Prefer an explicit track identity from the payload when present; otherwise
  // the normalized sprint slug. Never invent agreement from basename alone when
  // a --track selector was supplied.
  const returnedTrack = typeof active.track === "string" && active.track.trim()
    ? active.track.trim()
    : (typeof fm.track === "string" && fm.track.trim() ? fm.track.trim() : trackSlug);
  if (track) {
    const trackMatches = track === returnedTrack || track === trackSlug || track === components[0];
    if (!trackMatches) {
      return buildFailure("contradictory_owner", {
        detail: `track selector '${track}' does not match returned track '${returnedTrack}' (slug '${trackSlug}', component '${components[0]}')`,
        sprintPath,
        track,
        component: components[0],
        schemaVersion,
      });
    }
  }

  return buildOwner({
    sprintPath,
    track: trackSlug,
    component: components[0],
    source: track ? OWNER_SOURCES.EXPLICIT_TRACK : OWNER_SOURCES.EXPLICIT_COMPONENT,
    schemaVersion,
  });
}

function invokeSprintState({
  binPath,
  backlogDir,
  repo = null,
  track = null,
  component = null,
  execFileSyncFn = execFileSync,
  nodeBin = process.execPath,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
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

  const targetRepo = repo || path.dirname(backlogDir);
  const validated = validateSprintStatePayload(payload, {
    track,
    component,
    repo: targetRepo,
    existsSync,
    realpathSync,
  });
  if (!validated.ok) return validated;
  return {
    ...validated,
    source: track ? OWNER_SOURCES.EXPLICIT_TRACK : OWNER_SOURCES.EXPLICIT_COMPONENT,
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
  if (expectedTrack && expectedTrack !== trackSlug && expectedTrack !== components[0]) {
    return buildFailure("contradictory_owner", {
      detail: `sprint path track '${trackSlug}' contradicts track '${expectedTrack}'`,
      sprintPath: resolvedPath,
      track: expectedTrack,
    });
  }
  return buildOwner({
    sprintPath: resolvedPath,
    track: trackSlug,
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
