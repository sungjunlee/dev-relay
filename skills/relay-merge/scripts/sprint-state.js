"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  MIN_SCHEMA_VERSION,
  buildFailure,
  discoverSprintStateBin,
  listSprintStateCandidates,
  normalizeRepoSprintPath,
  parseComponents,
  probeSprintStateBinary,
  validateSprintStatePayload,
} = require("./sprint-state-helpers");

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
