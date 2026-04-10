#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { persistRequestContract } = require("./relay-request");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--contract-file", "--json", "--help", "-h"];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: persist-request.js --repo <path> --contract-file <path> [--json]");
  console.log("");
  console.log("Persist a single-leaf relay-intake request artifact and handoff bundle.");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function getArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return KNOWN_FLAGS.includes(value) ? undefined : value;
}

function hasFlag(flag) {
  return args.includes(flag);
}

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
    console.log(`Relay-ready:   ${result.handoffPath}`);
    console.log(`Done criteria: ${result.doneCriteriaPath}`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
