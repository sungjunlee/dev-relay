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
 *   2. Read its `component:` frontmatter; multi-component is comma-separated;
 *      first declared wins per design doc D4 (and a warn is emitted).
 *   3. Locate <repo>/spec/capabilities.md and the matching `## Capability: <name>`
 *      block; require its LEARN:BEGIN/LEARN:END marker pair to be intact.
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

function findActiveSprint(sprintsDir, { readdir = fs.readdirSync, readFile = fs.readFileSync, fileExists = fs.existsSync } = {}) {
  if (!fileExists(sprintsDir)) return null;
  const files = readdir(sprintsDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => path.join(sprintsDir, f));
  for (const file of files) {
    const content = readFile(file, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    if (/^status:\s*active\s*$/m.test(fm)) return { file, content };
  }
  return null;
}

function findCapabilityBlock(capabilitiesContent, name) {
  const lines = capabilitiesContent.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^## Capability:\s+(\S+)/);
    if (match && match[1] === name) { start = i; break; }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## Capability:\s+/.test(lines[i])) { end = i; break; }
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
  secondaryComponents,
  runId,
  pr,
  synthesis,
  date,
}) {
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

  const warnings = [];
  if (secondaryComponents.length > 0) {
    warnings.push({
      kind: "secondary_components_ignored",
      detail: `D4 first-wins: secondary components ${secondaryComponents.join(", ")} were ignored.`,
    });
  }

  return {
    status: STATUS.APPENDED,
    primaryComponent,
    entry: newEntry,
    updatedContent: updatedLines.join("\n"),
    warnings,
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
  if (!sprint) return buildSkip("active_sprint_absent", { sprintsDir });

  const fm = parseFrontmatter(sprint.content);
  const componentRaw = readFrontmatterField(fm, "component");
  const components = parseComponents(componentRaw);
  if (components.length === 0) {
    return buildSkip("component_empty", { sprintFile: sprint.file });
  }

  const [primaryComponent, ...secondaryComponents] = components;
  const capabilitiesContent = readFile(capabilitiesPath, "utf-8");

  const coreResult = appendLearningsCore({
    capabilitiesContent,
    primaryComponent,
    secondaryComponents,
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
    for (const w of result.warnings || []) lines.push(`  warning: ${w.detail}`);
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
  findActiveSprint,
  findCapabilityBlock,
  locateMarkers,
  buildEntry,
  appendLearningsCore,
  appendLearnings,
  formatHumanReport,
};
