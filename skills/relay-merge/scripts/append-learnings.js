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
 *   ./append-learnings.js --repo <path> --run-id <id> --pr <number> [--synthesis "<one-line>"] [--date YYYY-MM-DD] [--dry-run] [--json]
 *
 * Resolution flow:
 *   1. Find the active sprint file (status: active) under <repo>/backlog/sprints/
 *   2. Require exactly one active sprint, then read its single primary
 *      `component:` frontmatter handle. Comma-separated multi-component values
 *      fail because the field is a routing address, not prose.
 *   3. Locate <repo>/spec/capabilities.md and the matching `## Capability: <name>`
 *      block. Capability names are kebab-case (`[a-z0-9][a-z0-9-]*`). Require
 *      the block's LEARN:BEGIN/LEARN:END marker pair to be intact.
 *   4. If no entry already exists for run-id (`run #<id>` substring), append a
 *      new line in schema-bound format inside the markers.
 *
 * Graceful no-ops (status: skipped, exit 0):
 *   - spec/capabilities.md missing
 *   - active sprint missing or has no component:
 *   - component does not match any declared capability
 *   - entry for this run-id already present (idempotent)
 *
 * Loud failures (status: failed, exit 1):
 *   - multiple active sprint files (ambiguous component target)
 *   - multiple component values in sprint frontmatter
 *   - markers missing or out of order in the matching block (tampering)
 *   - malformed inputs
 *
 * Designed to be invoked from finalize-run.js; failure must not block merge
 * cleanup. The caller treats a non-zero exit as a warning, not a fatal error.
 */

const fs = require("fs");
const path = require("path");

const STATUS = Object.freeze({
  APPENDED: "appended",
  SKIPPED: "skipped",
  FAILED: "failed",
});

const MARKER_BEGIN = "<!-- LEARN:BEGIN -->";
const MARKER_END = "<!-- LEARN:END -->";
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function usage() {
  return "Usage: append-learnings.js --repo <path> --run-id <id> --pr <number> [--synthesis TEXT] [--date YYYY-MM-DD] [--dry-run] [--json]";
}

function parseArgs(args) {
  const options = {
    repo: null,
    runId: null,
    pr: null,
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
  }
  return options;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return content.slice(4, end);
}

function readFrontmatterField(fm, field) {
  if (!fm) return null;
  const match = fm.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  if (!match) return null;
  let raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
  return raw;
}

function parseComponents(fmValue) {
  if (!fmValue) return [];
  return fmValue.split(",").map((s) => s.trim()).filter(Boolean);
}

function isValidCapabilityName(name) {
  return CAPABILITY_NAME_PATTERN.test(name);
}

function parseCapabilityHeading(line) {
  const match = line.match(/^## Capability:\s+(.+?)\s*$/);
  if (!match) return null;
  const name = match[1].trim();
  return isValidCapabilityName(name) ? name : null;
}

function resolveActiveSprint(sprintsDir, { readdir = fs.readdirSync, readFile = fs.readFileSync, fileExists = fs.existsSync } = {}) {
  if (!fileExists(sprintsDir)) return null;
  const files = readdir(sprintsDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => path.join(sprintsDir, f))
    .sort();
  const active = [];
  for (const file of files) {
    const content = readFile(file, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    if (/^status:\s*active\s*$/m.test(fm)) active.push({ file, content });
  }
  if (active.length > 1) {
    return buildFailure("multiple_active_sprints", {
      sprintFiles: active.map((entry) => entry.file),
    });
  }
  if (active.length === 1) return active[0];
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
    if (parseCapabilityHeading(lines[i])) { end = i; break; }
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

function appendLearnings({
  repo,
  runId,
  pr,
  synthesis = null,
  date = null,
  dryRun = false,
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  fileExists = fs.existsSync,
  readdir = fs.readdirSync,
} = {}) {
  const fsDeps = { readFile, writeFile, fileExists, readdir };

  const capabilitiesPath = path.join(repo, "spec", "capabilities.md");
  if (!fileExists(capabilitiesPath)) {
    return buildSkip("capabilities_absent", { capabilitiesPath });
  }

  const sprintsDir = path.join(repo, "backlog", "sprints");
  const sprint = findActiveSprint(sprintsDir, fsDeps);
  if (sprint?.status === STATUS.FAILED) return { ...sprint, sprintsDir };
  if (!sprint) return buildSkip("active_sprint_absent", { sprintsDir });

  const fm = parseFrontmatter(sprint.content);
  const componentRaw = readFrontmatterField(fm, "component");
  const components = parseComponents(componentRaw);
  if (components.length === 0) {
    return buildSkip("component_empty", { sprintFile: sprint.file });
  }
  if (components.length > 1) {
    return buildFailure("multiple_components", {
      sprintFile: sprint.file,
      components,
      detail: "component: accepts one primary capability slug; put secondary touches in sprint prose",
    });
  }

  const [primaryComponent] = components;
  const capabilitiesContent = readFile(capabilitiesPath, "utf-8");

  const coreResult = appendLearningsCore({
    capabilitiesContent,
    primaryComponent,
    runId,
    pr,
    synthesis,
    date,
  });

  const result = { ...coreResult, capabilitiesPath, sprintFile: sprint.file };
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
  parseArgs,
  parseFrontmatter,
  readFrontmatterField,
  parseComponents,
  isValidCapabilityName,
  parseCapabilityHeading,
  resolveActiveSprint,
  findActiveSprint,
  findCapabilityBlock,
  locateMarkers,
  buildEntry,
  appendLearningsCore,
  appendLearnings,
  formatHumanReport,
};
