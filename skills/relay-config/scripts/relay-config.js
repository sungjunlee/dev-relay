#!/usr/bin/env node
"use strict";

const { ADAPTER_PHASES, getAdapter, listAdapters } = require("../../relay-dispatch/scripts/adapters");
const { validateCapabilities } = require("../../relay-dispatch/scripts/adapter-contract");

const CLI = {
  reservedFlags: ["--phase", "--executor", "--reviewer", "--model", "--json", "--help", "-h"],
  booleanFlags: ["--json", "--help", "-h"], verbatimValueFlags: [],
};
function parseCli(argv) {
  const known = new Set(CLI.reservedFlags), bool = new Set(CLI.booleanFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (value) => value !== undefined && !String(value).startsWith("--") && !known.has(String(value));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  return { hasFlag: (flags) => (Array.isArray(flags) ? flags : [flags]).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flag, fallback) => { for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); return accepts(value) ? value : fallback; } } return fallback; } };
}
function help() {
  console.log("Usage: relay-config.js doctor|check [options]");
  console.log("Relay has no route catalog or mutable policy configuration; select adapter and model explicitly per run.");
}
function phase(value) {
  if (value === "dispatch") return ADAPTER_PHASES.DISPATCH;
  if (value === "review") return ADAPTER_PHASES.PRIMARY_REVIEW;
  throw new Error("--phase must be dispatch or review");
}
function run(argv = process.argv.slice(2)) {
  const command = argv[0]; const raw = argv.slice(1);
  const args = parseCli(raw); const json = args.hasFlag("--json");
  if (!command || ["help", "--help", "-h"].includes(command) || args.hasFlag(["--help", "-h"])) { help(); return 0; }
  if (command === "doctor") {
    const result = { ok: true, adapters: listAdapters().map((name) => ({ adapter: name, probe: getAdapter(name).probe({ timeoutMs: 5000 }) })) };
    if (json) console.log(JSON.stringify(result, null, 2)); else result.adapters.forEach(({ adapter, probe }) => console.log(`${adapter}: ${probe.status}`));
    return 0;
  }
  if (command !== "check") throw new Error(`unknown command '${command}'; supported: doctor, check`);
  const selectedPhase = phase(args.getArg("--phase"));
  const executor = args.getArg("--executor");
  const reviewer = args.getArg("--reviewer");
  if (selectedPhase === ADAPTER_PHASES.DISPATCH && (!executor || reviewer)) {
    throw new Error("--phase dispatch requires --executor only");
  }
  if (selectedPhase === ADAPTER_PHASES.PRIMARY_REVIEW && (!reviewer || executor)) {
    throw new Error("--phase review requires --reviewer only");
  }
  const actor = executor || reviewer;
  const capability = validateCapabilities(getAdapter(actor), selectedPhase, {
    readOnly: selectedPhase === ADAPTER_PHASES.PRIMARY_REVIEW,
    networkAccess: "enabled",
  });
  const model = args.getArg("--model") || null;
  const result = { ok: true, phase: selectedPhase, adapter: actor, model, model_source: model ? "explicit" : "adapter_default", capability };
  if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`${actor}: ${selectedPhase} supported; model=${model || "(adapter default)"}`);
  return 0;
}
if (require.main === module) {
  try { process.exitCode = run(); } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
module.exports = { run };
