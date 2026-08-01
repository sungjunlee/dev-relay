#!/usr/bin/env node
"use strict";

/** Publish one immutable planner artifact without creating a relay run. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FLAGS = ["--output", "--text", "--file", "--json", "--help", "-h"];
const CLI = { reservedFlags: FLAGS, booleanFlags: ["--json", "--help", "-h"], verbatimValueFlags: ["--output", "--text", "--file"] };
function parseCli(argv) {
  const known = new Set(FLAGS), bool = new Set(CLI.booleanFlags), verbatim = new Set(CLI.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  return { hasFlag: (flags) => (Array.isArray(flags) ? flags : [flags]).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flag, fallback) => { for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}

function usage() {
  return "Usage: persist-done-criteria.js --output <path> (--text <text> | --file <path>) [--json]";
}
function readRegular(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`not a regular file: ${file}`);
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`not a regular file: ${file}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`file changed while being read: ${file}`);
    }
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function configuredRunsBase() {
  return path.resolve(
    process.env.RELAY_RUNS_BASE
      || path.join(process.env.RELAY_HOME || path.join(require("node:os").homedir(), ".relay"), "runs"),
  );
}
function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function trustedOutputPath(output) {
  if (typeof output !== "string" || !output.trim()) throw new Error("--output is required");
  const requested = path.resolve(output);
  const parent = path.dirname(requested);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("--output parent must be a pre-existing real directory");
  }
  const canonicalParent = fs.realpathSync(parent);
  const outputPath = path.join(canonicalParent, path.basename(requested));
  const runsBase = configuredRunsBase();
  let canonicalRunsBase = runsBase;
  try { canonicalRunsBase = fs.realpathSync(runsBase); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (isInside(outputPath, canonicalRunsBase) || isInside(requested, runsBase)) {
    throw new Error("planner artifacts must not preallocate files under the relay runs directory");
  }
  return outputPath;
}
function readInput({ text, file }) {
  if ((text === undefined) === (file === undefined)) throw new Error("supply exactly one of --text or --file");
  return text === undefined ? readRegular(path.resolve(file)).toString("utf8") : String(text);
}
function persistDoneCriteria({ output, text }) {
  const outputPath = trustedOutputPath(output);
  const bytes = Buffer.from(`${String(text).trim()}\n`, "utf8");
  if (bytes.length === 1) throw new Error("Done Criteria must not be empty");
  const directory = path.dirname(outputPath);
  const temporary = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    try { fs.linkSync(temporary, outputPath); fsyncDirectory(directory); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readRegular(outputPath).equals(bytes)) throw new Error(`immutable Done Criteria already exists with different bytes: ${outputPath}`);
    }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); fsyncDirectory(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { path: outputPath, source: "planner_artifact", sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
function main(argv = process.argv.slice(2)) {
  try {
    const args = parseCli(argv);
    if (args.hasFlag(["--help", "-h"])) { console.log(usage()); return 0; }
    const result = persistDoneCriteria({ output: args.getArg("--output"), text: readInput({ text: args.getArg("--text"), file: args.getArg("--file") }) });
    if (args.hasFlag("--json")) console.log(JSON.stringify(result, null, 2)); else console.log(`Done Criteria: ${result.path}`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`); console.error(usage()); return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { persistDoneCriteria };
