#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function readTextFileWithoutFollowingSymlinks(filePath) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`not a regular file: ${filePath}`);
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

const SIGNAL_KEYS = ["test_infra", "type_check", "lint_format"];
const TEST_RUNNERS = new Set([
  "jest",
  "vitest",
  "mocha",
  "playwright",
  "@playwright/test",
  "cypress",
  "pytest",
]);
const LINT_FORMAT_TOOLS = new Set([
  "eslint",
  "prettier",
  "ruff",
  "black",
  "isort",
  "pylint",
]);
const TYPE_CHECK_TOOLS = new Set([
  "typescript",
  "mypy",
]);
const CATALOG_DIR = path.join(__dirname, "..", "references", "rubric-templates");
const CATALOG_PATH = path.join(CATALOG_DIR, "_index.json");

function usage() {
  return [
    "Usage: match-template.js [--probe-file <path> | --probe-json <json>] [--repo <path>] [--json]",
    "",
    "Options:",
    "  --probe-file <path>  Read probe JSON from a file",
    "  --probe-json <json>  Read probe JSON from an inline argument",
    "  --repo <path>        Optional repo root for Go file detection",
    "  --json               Emit JSON output",
    "  --help, -h           Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    probeFile: null,
    probeJson: null,
    repo: null,
    json: false,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--probe-file") {
      index += 1;
      if (index >= argv.length) throw new Error("--probe-file requires a path");
      opts.probeFile = argv[index];
    } else if (arg === "--probe-json") {
      index += 1;
      if (index >= argv.length) throw new Error("--probe-json requires JSON");
      opts.probeJson = argv[index];
    } else if (arg === "--repo") {
      index += 1;
      if (index >= argv.length) throw new Error("--repo requires a path");
      opts.repo = argv[index];
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (opts.probeFile && opts.probeJson) {
    throw new Error("Use only one of --probe-file or --probe-json");
  }

  return opts;
}

function parseProbeJson(text) {
  if (!text || !text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function readProbe({ probeFile, probeJson }) {
  if (probeJson) {
    return parseProbeJson(probeJson);
  }
  if (probeFile) {
    return parseProbeJson(readTextFileWithoutFollowingSymlinks(path.resolve(probeFile)));
  }
  return parseProbeJson(fs.readFileSync(0, "utf-8"));
}

function loadCatalog(catalogPath = CATALOG_PATH) {
  const raw = readTextFileWithoutFollowingSymlinks(catalogPath);
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog)) {
    throw new Error("_index.json must be an array");
  }
  return catalog;
}

function normalizeSignalValues(values) {
  if (typeof values === "string") {
    if (values === "no quality infra detected") return [];
    return values.split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value.name === "string") return value.name;
      return null;
    })
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeScriptEntries(scripts) {
  if (!Array.isArray(scripts)) return [];
  return scripts.filter((entry) => entry && typeof entry === "object");
}

function addScriptToolSignals(signals, scripts) {
  for (const script of normalizeScriptEntries(scripts)) {
    const command = typeof script.command === "string" ? script.command : "";
    const name = typeof script.name === "string" ? script.name : "";
    const searchable = `${name}\n${command}`;

    for (const runner of TEST_RUNNERS) {
      if (new RegExp(`(^|\\b)${runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`).test(searchable)) {
        signals.test_infra.push(runner);
      }
    }
    for (const tool of LINT_FORMAT_TOOLS) {
      if (new RegExp(`(^|\\b)${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`).test(searchable)) {
        signals.lint_format.push(tool);
      }
    }
    if (/tsc\s+--noEmit/.test(searchable)) {
      signals.type_check.push("typescript", "tsc --noEmit");
    }
    if (/\bmypy\b/.test(searchable)) {
      signals.type_check.push("mypy");
    }
  }
}

function normalizeProbeSignals(probe) {
  const signals = {
    test_infra: [],
    type_check: [],
    lint_format: [],
  };

  for (const key of SIGNAL_KEYS) {
    signals[key].push(...normalizeSignalValues(probe?.[key]));
    signals[key].push(...normalizeSignalValues(probe?.probe_signal?.[key]));
  }

  const frameworkNames = normalizeSignalValues(probe?.project_tools?.frameworks);
  signals.test_infra.push(...frameworkNames.filter((name) => TEST_RUNNERS.has(name)));
  signals.lint_format.push(...frameworkNames.filter((name) => LINT_FORMAT_TOOLS.has(name)));
  signals.type_check.push(...frameworkNames.filter((name) => TYPE_CHECK_TOOLS.has(name)));
  addScriptToolSignals(signals, probe?.project_tools?.scripts);

  return {
    test_infra: unique(signals.test_infra),
    type_check: unique(signals.type_check),
    lint_format: unique(signals.lint_format),
  };
}

function scoreTemplate(probeSignals, entry, repoDir) {
  let score = 0;
  for (const key of SIGNAL_KEYS) {
    const probeValues = new Set(probeSignals[key] || []);
    const expectedValues = normalizeSignalValues(entry?.signals?.[key]);
    for (const expected of expectedValues) {
      if (probeValues.has(expected)) {
        score += 1;
      }
    }
  }

  if (entry?.file === "go-test.yaml" && repoDir && hasGoFiles(path.resolve(repoDir))) {
    score += 1;
  }

  return score;
}

function hasGoFiles(repoDir, maxDepth = 3) {
  if (!fs.existsSync(repoDir)) {
    return false;
  }
  const rootGoMod = path.join(repoDir, "go.mod");
  if (fs.existsSync(rootGoMod) && fs.statSync(rootGoMod).isFile()) {
    return true;
  }

  function visit(dir, depth) {
    if (depth > maxDepth) {
      return false;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const childPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".go")) {
        return true;
      }
      if (entry.isDirectory() && visit(childPath, depth + 1)) {
        return true;
      }
    }

    return false;
  }

  return visit(repoDir, 0);
}

function bestMatch(probe, catalog, repoDir = null) {
  const probeSignals = normalizeProbeSignals(probe);
  const allMatches = catalog.map((entry) => {
    const score = scoreTemplate(probeSignals, entry, repoDir);
    return {
      file: entry.file,
      score,
      reason: score > 0 ? "signal overlap" : "no signal overlap",
    };
  });
  const best = allMatches.reduce((current, candidate) => {
    if (!current || candidate.score > current.score) {
      return candidate;
    }
    return current;
  }, null);

  if (!best || best.score <= 0) {
    return {
      matched_template: null,
      score: 0,
      all_matches: allMatches,
      reason: "no clear match",
    };
  }

  return {
    matched_template: best.file,
    score: best.score,
    all_matches: allMatches,
    reason: "matched on signal overlap",
  };
}

function main() {
  try {
    const opts = parseArgs(process.argv);
    if (opts.help) {
      console.log(usage());
      return;
    }

    const probe = readProbe(opts);
    const result = bestMatch(probe, loadCatalog(), opts.repo);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      matched_template: null,
      score: 0,
      all_matches: [],
      reason: error.message,
    }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readProbe,
  loadCatalog,
  normalizeProbeSignals,
  scoreTemplate,
  bestMatch,
  hasGoFiles,
};
