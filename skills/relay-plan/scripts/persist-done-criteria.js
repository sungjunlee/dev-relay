#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const {
  ensureRunLayout,
  getRunDir,
  requireValidRunId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  bindCliArgs,
  findUnknownFlags,
} = require("../../relay-dispatch/scripts/cli-args");

const KNOWN_FLAGS = ["--repo", "--run-id", "--text", "--file", "--json", "--help", "-h"];

function usage() {
  console.error([
    "Usage: persist-done-criteria.js --repo <path> --run-id <id> (--text <text> | --file <path>) [--json]",
    "",
    "Writes operator-authored Phase 1 Done Criteria to:",
    "  ~/.relay/runs/<repo-slug>/<run-id>/done-criteria.md",
  ].join("\n"));
}

function readInputText({ text, file }) {
  if (text && file) {
    throw new Error("use either --text or --file, not both");
  }
  if (!text && !file) {
    throw new Error("one of --text or --file is required");
  }
  if (text) return text;

  const inputPath = path.resolve(file);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }
  return fs.readFileSync(inputPath, "utf-8");
}

function persistDoneCriteria({ repo, runId, text }) {
  const repoRoot = path.resolve(repo);
  const normalizedRunId = requireValidRunId(runId);
  ensureRunLayout(repoRoot, normalizedRunId);
  const outputPath = path.join(getRunDir(repoRoot, normalizedRunId), "done-criteria.md");
  fs.writeFileSync(outputPath, `${String(text).trim()}\n`, "utf-8");
  return { path: outputPath, source: "planner_decision" };
}

function main() {
  const args = process.argv.slice(2);
  const { getArg, hasFlag } = bindCliArgs(args, {
    commandName: "persist-done-criteria",
    reservedFlags: KNOWN_FLAGS,
  });

  try {
    const unknownFlags = findUnknownFlags(args, "persist-done-criteria");
    if (unknownFlags.length) {
      throw new Error(`unknown flag(s): ${unknownFlags.join(", ")}`);
    }

    if (hasFlag("--help") || hasFlag("-h")) {
      usage();
      return;
    }

    const repo = getArg("--repo");
    const runId = getArg("--run-id");
    if (!repo) throw new Error("--repo is required");
    if (!runId) throw new Error("--run-id is required");

    const result = persistDoneCriteria({
      repo,
      runId,
      text: readInputText({
        text: getArg("--text"),
        file: getArg("--file"),
      }),
    });

    if (hasFlag("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Done Criteria: ${result.path}`);
      console.log(`Source: ${result.source}`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  persistDoneCriteria,
};
