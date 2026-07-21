"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MIN_SCHEMA_VERSION = 2;

function buildFailure(reason, extras = {}) {
  return { ok: false, reason, ...extras };
}

function parseComponents(value) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
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
      timeout: 10_000,
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
    candidates: probed.map((probe) => probe.path),
  });
}

/**
 * Resolve a sprint path against the target repo and require containment under
 * `<repo>/backlog/sprints/` (realpath-aware). This consumes a path already
 * emitted by sprint-state; it does not parse sprint markdown.
 */
function normalizeRepoSprintPath(repo, sprintPath, {
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  statSync = fs.statSync,
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
    let realRepo;
    let realSprints;
    try {
      realRepo = realpathSync(repo);
      realSprints = realpathSync(sprintsDir);
    } catch (error) {
      return buildFailure("sprint_path_missing", {
        sprintPath: absPath,
        detail: error.message,
      });
    }

    const rootRel = path.relative(realRepo, realSprints);
    if (
      !rootRel
      || rootRel === ".."
      || rootRel.startsWith(`..${path.sep}`)
      || path.isAbsolute(rootRel)
      || rootRel.split(path.sep).includes("..")
    ) {
      return buildFailure("sprint_path_escaped", {
        detail: `sprints root must resolve within repository ${realRepo}`,
        sprintPath: absPath,
        sprintsDir,
      });
    }

    if (!existsSync(absPath)) {
      return buildFailure("sprint_path_missing", { sprintPath: absPath });
    }
    let realFile;
    let isRegularFile;
    try {
      realFile = realpathSync(absPath);
      isRegularFile = statSync(realFile).isFile();
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
    if (path.dirname(realFile) !== realSprints || !isRegularFile) {
      return buildFailure("sprint_path_invalid", {
        detail: `sprint path must resolve to a direct regular-file child of ${sprintsDir}`,
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
        ? payload.active_sprints.map((sprint) => sprint?.active_sprint?.path || sprint?.path || null).filter(Boolean)
        : [],
      detail: "sprint-state returned no single active_sprint for the selector",
    });
  }

  const frontmatter = active.frontmatter || {};
  const componentRaw = typeof frontmatter.component === "string" ? frontmatter.component.trim() : "";
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

  let normalizedSprintPath = active.path;
  let trackSlug = path.basename(String(active.path).replace(/\\/g, "/"), ".md");
  if (repo) {
    const normalized = normalizeRepoSprintPath(repo, active.path, { existsSync, realpathSync });
    if (!normalized.ok) return { ...normalized, schemaVersion };
    normalizedSprintPath = normalized.sprintPath;
    trackSlug = normalized.trackSlug;
  }

  const returnedTrack = typeof active.track === "string" && active.track.trim()
    ? active.track.trim()
    : (typeof frontmatter.track === "string" && frontmatter.track.trim() ? frontmatter.track.trim() : trackSlug);
  if (track) {
    const trackMatches = track === returnedTrack || track === trackSlug || track === components[0];
    if (!trackMatches) {
      return buildFailure("contradictory_owner", {
        detail: `track selector '${track}' does not match returned track '${returnedTrack}' (slug '${trackSlug}', component '${components[0]}')`,
        sprintPath: normalizedSprintPath,
        track,
        component: components[0],
        schemaVersion,
      });
    }
  }

  return {
    ok: true,
    sprintPath: normalizedSprintPath,
    track: returnedTrack,
    component: components[0],
    source: track ? "explicit_track" : "explicit_component",
    schemaVersion,
  };
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
      timeout: 10_000,
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
    source: track ? "explicit_track" : "explicit_component",
  };
}

module.exports = {
  MIN_SCHEMA_VERSION,
  discoverSprintStateBin,
  invokeSprintState,
  listSprintStateCandidates,
  normalizeRepoSprintPath,
  parseComponents,
  probeSprintStateBinary,
  validateSprintStatePayload,
};
