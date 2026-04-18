#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { persistRequestContract } = require("./relay-request");
const { getArg: sharedGetArg, hasFlag: sharedHasFlag } = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--contract-file", "--json", "--help", "-h"];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: persist-request.js --repo <path> --contract-file <path> [--json]");
  console.log("");
  console.log("Persist a relay-intake request artifact and one-or-more leaf handoff bundles.");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, { reservedFlags: KNOWN_FLAGS });
const hasFlag = (flag) => sharedHasFlag(args, flag);

const repoRoot = path.resolve(getArg("--repo") || ".");
const contractFile = getArg("--contract-file");
const jsonOut = hasFlag("--json");

if (!contractFile) {
  console.error("Error: --contract-file is required");
  process.exit(1);
}

const resolvedContractFile = path.resolve(contractFile);
if (!fs.existsSync(resolvedContractFile)) {
  console.error(`Error: contract file not found: ${resolvedContractFile}`);
  process.exit(1);
}

let contract;
try {
  contract = JSON.parse(fs.readFileSync(resolvedContractFile, "utf-8"));
} catch (error) {
  console.error(`Error: failed to parse contract JSON: ${error.message}`);
  process.exit(1);
}

try {
  const result = persistRequestContract(repoRoot, contract);
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Request:       ${result.requestId}`);
    console.log(`Artifact:      ${result.requestPath}`);
    console.log(`Raw request:   ${result.rawRequestPath}`);
    if (result.leafCount === 1) {
      console.log(`Relay-ready:   ${result.handoffPath}`);
      console.log(`Done criteria: ${result.doneCriteriaPath}`);
    } else {
      console.log(`Leaf count:    ${result.leafCount}`);
      for (const [index, leafId] of result.leafIds.entries()) {
        console.log(`Relay-ready:   ${leafId} -> ${result.handoffPaths[index]}`);
      }
      for (const [index, leafId] of result.leafIds.entries()) {
        console.log(`Done criteria: ${leafId} -> ${result.doneCriteriaPaths[index]}`);
      }
    }
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
