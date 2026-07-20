#!/usr/bin/env node
/**
 * Append a one-line entry to the matching capability's `## Learnings` block
 * in <target-repo>/spec/capabilities.md after a successful relay-merge.
 *
 * Structurally bounded: this script is the only writer for `## Learnings`,
 * inserts only between `<!-- LEARN:BEGIN -->` / `<!-- LEARN:END -->` markers,
 * and refuses to touch any other region. Source: dev-backlog spec-system
 * v0.1 design doc — anti-adversarial-Goodhart defense.
 *
 * Usage:
 *   ./append-learnings.js --repo <path> --run-id <id> --pr <number>
 *     [--sprint <path>] [--track <slug>] [--component <slug>]
 *     [--synthesis "<one-line>"] [--date YYYY-MM-DD] [--dry-run] [--json]
 *
 * Ownership resolution (see sprint-owner.js):
 *   caller/CLI sprint|track|component → manifest/fleet owner →
 *   issue-body `component:` → exactly-one-active fallback.
 *   `multiple_active_sprints` only when N>1 and no owner resolves.
 *
 * Graceful no-ops (status: skipped, exit 0):
 *   - spec/capabilities.md missing
 *   - active sprint missing or has no component:
 *   - component does not match any declared capability
 *   - entry for this run-id already present (idempotent)
 *
 * Loud failures (status: failed, exit 1):
 *   - multiple active sprint files with no resolvable owner
 *   - contradictory explicit handles
 *   - multiple component values in sprint frontmatter
 *   - markers missing or out of order in the matching block (tampering)
 *   - malformed inputs / sprint-state dependency failures when required
 *
 * Designed to be invoked from finalize-run.js; failure must not block merge
 * cleanup. The caller treats a non-zero exit as a warning, not a fatal error.
 */

const fs = require("fs");
const path = require("path");
const {
  OWNER_SOURCES,
  resolveSprintOwner,
  parseFrontmatter,
  readFrontmatterField,
  parseComponents,
  isValidCapabilityName,
  listActiveSprintFiles,
} = require("./sprint-owner");

const STATUS = Object.freeze({
  APPENDED: "appended",
  SKIPPED: "skipped",
  FAILED: "failed",
});

const MARKER_BEGIN = "<!-- LEARN:BEGIN -->";
const MARKER_END = "<!-- LEARN:END -->";
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function usage() {
  return [
    "Usage: append-learnings.js --repo <path> --run-id <id> --pr <number>",
    "  [--sprint <path>] [--track <slug> | --component <slug>]",
    "  [--synthesis TEXT] [--date YYYY-MM-DD] [--dry-run] [--json]",
  ].join(" ");
}

function parseArgs(args) {
  const options = {
    repo: null,
    runId: null,
    pr: null,
    sprint: null,
    track: null,
    component: null,
    synthesis: null,
    date: null,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--json")    { options.json = true;   continue; }
    if (arg === "--help" || arg === "-h") return { ...options, help: true };

    const pair = (flag, key) => {
      if (arg === flag) {
        const next = args[i + 1];
        if (!next) return `Missing value for ${flag}. ${usage()}`;
        options[key] = next; i += 1; return null;
      }
      const equalsPrefix = `${flag}=`;
      if (arg.startsWith(equalsPrefix)) {
        options[key] = arg.slice(equalsPrefix.length); return null;
      }
      return false;
    };

    const handlers = [
      ["--repo", "repo"], ["--run-id", "runId"], ["--pr", "pr"],
      ["--sprint", "sprint"], ["--track", "track"], ["--component", "component"],
      ["--synthesis", "synthesis"], ["--date", "date"],
    ];
    let handled = false;
    let err = null;
    for (const [flag, key] of handlers) {
      const result = pair(flag, key);
      if (result === null) { handled = true; break; }
      if (typeof result === "string") { err = result; handled = true; break; }
    }
    if (err) return { ...options, error: err };
    if (handled) continue;

    return { ...options, error: `Unknown argument: ${arg}. ${usage()}` };
  }

  if (!options.help) {
    if (!options.repo)  return { ...options, error: `Missing --repo. ${usage()}` };
    if (!options.runId) return { ...options, error: `Missing --run-id. ${usage()}` };
    if (!options.pr)    return { ...options, error: `Missing --pr. ${usage()}` };
    for (const [flag, key] of [["--sprint", "sprint"], ["--track", "track"], ["--component", "component"]]) {
      if (typeof options[key] === "string" && !options[key].trim()) {
        return { ...options, error: `Empty value for ${flag}. ${usage()}` };
      }
    }
    if (options.track && options.component) {
      return {
        ...options,
        error: `Use only one of --track / --component. ${usage()}`,
      };
    }
  }
  return options;
}

function parseCapabilityHeading(line) {
  const match = line.match(/^## Capability:\s+(.+?)\s*$/);
  if (!match) return null;
  const name = match[1].trim();
  return isValidCapabilityName(name) ? name : null;
}

function isCapabilityBoundary(line) {
  return /^## Capability:\s+/.test(line);
}

/**
 * Legacy single-active discovery kept for N==1 fallback and tests.
 * Returns one active sprint, null, or a multiple_active_sprints failure.
 */
function resolveActiveSprint(sprintsDir, { readdir = fs.readdirSync, readFile = fs.readFileSync, fileExists = fs.existsSync } = {}) {
  const activeFiles = listActiveSprintFiles(sprintsDir, {
    readdir,
    readFile,
    existsSync: fileExists,
  });
  if (activeFiles.length > 1) {
    return buildFailure("multiple_active_sprints", {
      sprintFiles: activeFiles,
    });
  }
  if (activeFiles.length === 1) {
    const file = activeFiles[0];
    return { file, content: readFile(file, "utf-8") };
  }
  return null;
}

const findActiveSprint = resolveActiveSprint;

function findCapabilityBlock(capabilitiesContent, name) {
  if (!isValidCapabilityName(name)) return null;
  const lines = capabilitiesContent.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseCapabilityHeading(lines[i]);
    if (heading === name) { start = i; break; }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isCapabilityBoundary(lines[i])) { end = i; break; }
  }
  return { start, end, lines };
}

function locateMarkers(blockLines, blockStart) {
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < blockLines.length; i += 1) {
    const trimmed = blockLines[i].trim();
    if (trimmed === MARKER_BEGIN) beginIdx = i + blockStart;
    if (trimmed === MARKER_END)   endIdx   = i + blockStart;
  }
  return { beginIdx, endIdx };
}

function buildEntry({ date, runId, synthesis, pr }) {
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const text = (synthesis || "").trim() || `relay-merge of PR #${pr}`;
  return `- ${dateStr} (run #${runId}): ${text} [PR #${pr}]`;
}

function buildSkip(reason, extras = {}) {
  return { status: STATUS.SKIPPED, reason, ...extras };
}

function buildFailure(reason, extras = {}) {
  return { status: STATUS.FAILED, reason, ...extras };
}

function appendLearningsCore({
  capabilitiesContent,
  primaryComponent,
  runId,
  pr,
  synthesis,
  date,
}) {
  if (!isValidCapabilityName(primaryComponent)) {
    return buildSkip("invalid_component_name", { primaryComponent });
  }

  const block = findCapabilityBlock(capabilitiesContent, primaryComponent);
  if (!block) {
    return buildSkip("component_not_found", { primaryComponent });
  }

  const blockLines = block.lines.slice(block.start, block.end);
  const { beginIdx, endIdx } = locateMarkers(blockLines, block.start);

  if (beginIdx === -1 || endIdx === -1) {
    return buildFailure("markers_missing", { primaryComponent });
  }
  if (endIdx <= beginIdx) {
    return buildFailure("markers_tampered", { primaryComponent });
  }

  const newEntry = buildEntry({ date, runId, synthesis, pr });
  const runMarker = `run #${runId}`;
  for (let i = beginIdx + 1; i < endIdx; i += 1) {
    if (block.lines[i].includes(runMarker)) {
      return buildSkip("idempotent_match", { primaryComponent, runId });
    }
  }

  const before = block.lines.slice(0, endIdx);
  const after = block.lines.slice(endIdx);
  const updatedLines = [...before, newEntry, ...after];

  return {
    status: STATUS.APPENDED,
    primaryComponent,
    entry: newEntry,
    updatedContent: updatedLines.join("\n"),
  };
}

function mapOwnerFailure(ownerResult) {
  const skipReasons = new Set([
    "active_sprint_absent",
    "component_empty",
    "capabilities_absent",
  ]);
  const reason = ownerResult.reason || "owner_unresolved";
  const extras = { ...ownerResult };
  delete extras.ok;
  if (skipReasons.has(reason)) {
    return buildSkip(reason, extras);
  }
  return buildFailure(reason, extras);
}

function appendLearnings({
  repo,
  runId,
  pr,
  synthesis = null,
  date = null,
  dryRun = false,
  sprint = null,
  track = null,
  component = null,
  owner = null,
  issueBody = null,
  resolveOwner = resolveSprintOwner,
  sprintState = null,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  fileExists = fs.existsSync,
  readdir = fs.readdirSync,
} = {}) {
  const capabilitiesPath = path.join(repo, "spec", "capabilities.md");
  if (!fileExists(capabilitiesPath)) {
    return buildSkip("capabilities_absent", { capabilitiesPath });
  }

  const ownerResult = resolveOwner({
    repo,
    sprint,
    track,
    component,
    owner,
    issueBody,
    sprintState,
    readFile,
    existsSync: fileExists,
    readdir,
  });

  if (!ownerResult.ok) {
    return mapOwnerFailure(ownerResult);
  }

  const primaryComponent = ownerResult.component;
  const capabilitiesContent = readFile(capabilitiesPath, "utf-8");

  const coreResult = appendLearningsCore({
    capabilitiesContent,
    primaryComponent,
    runId,
    pr,
    synthesis,
    date,
  });

  const result = {
    ...coreResult,
    capabilitiesPath,
    sprintFile: ownerResult.sprintPath,
    owner: {
      sprintPath: ownerResult.sprintPath,
      track: ownerResult.track,
      component: ownerResult.component,
      source: ownerResult.source,
    },
  };
  if (result.status !== STATUS.APPENDED) return result;

  if (!dryRun) {
    writeFile(capabilitiesPath, result.updatedContent);
  }
  delete result.updatedContent;
  return result;
}

function formatHumanReport(result) {
  if (result.status === STATUS.APPENDED) {
    const lines = [
      `Appended to ${result.capabilitiesPath} (capability: ${result.primaryComponent}):`,
      `  ${result.entry}`,
    ];
    if (result.owner?.source) {
      lines.push(`  owner: ${result.owner.source} → ${result.sprintFile}`);
    }
    return lines.join("\n");
  }
  if (result.status === STATUS.SKIPPED) {
    return `skipped: ${result.reason}` + (result.primaryComponent ? ` (component: ${result.primaryComponent})` : "");
  }
  return `failed: ${result.reason}` + (result.primaryComponent ? ` (component: ${result.primaryComponent})` : "");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) { console.error(parsed.error); process.exit(1); }
  if (parsed.help) { console.log(usage()); return; }

  const result = appendLearnings(parsed);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanReport(result));
  }

  if (result.status === STATUS.FAILED) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  STATUS,
  MARKER_BEGIN,
  MARKER_END,
  OWNER_SOURCES,
  parseArgs,
  parseFrontmatter,
  readFrontmatterField,
  parseComponents,
  isValidCapabilityName,
  parseCapabilityHeading,
  isCapabilityBoundary,
  resolveActiveSprint,
  findActiveSprint,
  findCapabilityBlock,
  locateMarkers,
  buildEntry,
  appendLearningsCore,
  appendLearnings,
  formatHumanReport,
};
