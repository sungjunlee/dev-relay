#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  readTextFileWithoutFollowingSymlinks,
} = require("../../relay-dispatch/scripts/manifest/rubric");

const SIGNAL_KEYS = ["test_infra", "type_check", "lint_format"];
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

function scoreTemplate(probe, entry, repoDir) {
  let score = 0;
  for (const key of SIGNAL_KEYS) {
    const probeValues = new Set(normalizeSignalValues(probe?.[key]));
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
  const allMatches = catalog.map((entry) => {
    const score = scoreTemplate(probe, entry, repoDir);
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
      reason: "no template scored above 0",
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
  scoreTemplate,
  bestMatch,
  hasGoFiles,
};
