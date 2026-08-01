#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { persistRequestContract } = require("./relay-request");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function validateString(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field}: is required`);
  }
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field}: must be an array`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${field}[${index}]: must be a non-empty string`);
    }
  });
}

function validateOptionalStringArray(value, field, errors) {
  if (value === undefined) return;
  validateStringArray(value, field, errors);
}

function validateReadiness(readiness, field, schema, errors) {
  if (readiness === undefined) return;
  if (!isObject(readiness)) {
    errors.push(`${field}: must be an object`);
    return;
  }

  const readinessFields = schema?.$defs?.readiness?.properties || {};
  const requiredReadinessFields = schema?.$defs?.readiness?.required || [];
  for (const name of requiredReadinessFields) {
    if (!hasOwn(readiness, name)) {
      errors.push(`${field}.${name}: is required`);
    }
  }
  for (const [name, definition] of Object.entries(readinessFields)) {
    if (!hasOwn(readiness, name)) continue;
    const allowed = definition.enum || [];
    if (allowed.length && !allowed.includes(readiness[name])) {
      errors.push(`${field}.${name}: must be one of: ${allowed.join(", ")}`);
    }
  }
}

function validateLeafHandoff(handoff, field, schema, errors, defaultOrder) {
  if (!isObject(handoff)) {
    errors.push(`${field}: must be an object`);
    return;
  }

  for (const name of ["leaf_id", "title", "goal", "done_criteria_markdown"]) {
    validateString(handoff[name], `${field}.${name}`, errors);
  }
  for (const name of ["in_scope", "out_of_scope", "assumptions", "escalation_conditions"]) {
    validateOptionalStringArray(handoff[name], `${field}.${name}`, errors);
  }
  if (hasOwn(handoff, "depends_on")) {
    validateStringArray(handoff.depends_on, `${field}.depends_on`, errors);
  }
  if (!hasOwn(handoff, "order") && defaultOrder === undefined) {
    errors.push(`${field}.order: is required`);
  } else if (hasOwn(handoff, "order") && (!Number.isInteger(handoff.order) || handoff.order < 1)) {
    errors.push(`${field}.order: must be a positive integer`);
  }
  validateReadiness(handoff.readiness, `${field}.readiness`, schema, errors);
}

function validateContractAgainstSchema(contract, schema) {
  const errors = [];
  if (!isObject(contract)) return "contract: must be an object";

  if (!isObject(contract.source)) {
    errors.push("source: is required");
  } else {
    validateString(contract.source.kind, "source.kind", errors);
  }
  validateString(contract.request_text, "request_text", errors);

  const hasHandoff = hasOwn(contract, "handoff");
  const hasHandoffs = hasOwn(contract, "handoffs");
  if (hasHandoff === hasHandoffs) {
    errors.push("handoff: exactly one of handoff or handoffs is required");
  } else if (hasHandoffs) {
    if (!Array.isArray(contract.handoffs) || contract.handoffs.length === 0) {
      errors.push("handoffs: must be a non-empty array");
    } else {
      contract.handoffs.forEach((handoff, index) => {
        validateLeafHandoff(handoff, `handoffs[${index}]`, schema, errors);
      });
    }
  } else {
    validateLeafHandoff(contract.handoff, "handoff", schema, errors, 1);
  }

  validateReadiness(contract.readiness, "readiness", schema, errors);
  return errors[0] || null;
}

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--contract-file", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--contract-file"],
};
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS), bool = new Set(CLI_ARG_OPTIONS.booleanFlags), verbatim = new Set(CLI_ARG_OPTIONS.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  return { hasFlag: (flags) => (Array.isArray(flags) ? flags : [flags]).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flag, fallback) => { for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}
let cliArgs;
try { cliArgs = parseCli(args); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
const formatCliModeLabel = (flag) => CLI_ARG_OPTIONS.booleanFlags.includes(flag) ? "[boolean]" : "[value]";

if (!args.length || cliArgs.hasFlag(["--help", "-h"])) {
  console.log("Usage: persist-request.js --repo <path> --contract-file <path> [--json]");
  console.log("");
  console.log("Persist a relay-ready request artifact and one-or-more leaf handoff bundles.");
  console.log("");
  console.log("Options:");
  console.log(`  --repo <path>          ${formatCliModeLabel("--repo", CLI_ARG_OPTIONS)} Repository root`);
  console.log(`  --contract-file <path> ${formatCliModeLabel("--contract-file", CLI_ARG_OPTIONS)} Request contract JSON path`);
  console.log(`  --json                 ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output JSON`);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}

const repoRoot = path.resolve(cliArgs.getArg("--repo") || ".");
const contractFile = cliArgs.getArg("--contract-file");
const jsonOut = cliArgs.hasFlag("--json");

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

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "request-contract.schema.json"), "utf-8"));
const validationError = validateContractAgainstSchema(contract, schema);
if (validationError) {
  console.error(`Error: contract validation failed: ${validationError}`);
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
