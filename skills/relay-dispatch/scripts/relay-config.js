#!/usr/bin/env node

const { ADAPTER_PHASES, getAdapter, listAdapters } = require("./adapters");
const { validateCapabilities } = require("./adapter-contract");
const { bindCliArgs, findUnknownFlags } = require("./cli-args");

const KNOWN_FLAGS = ["--phase", "--executor", "--reviewer", "--model", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: [],
};

function printHelp() {
  console.log("Usage: relay-config.js doctor|check [options]");
  console.log("");
  console.log("Relay has no route catalog or policy configuration. Select adapters and models explicitly per run.");
  console.log("  doctor [--json]");
  console.log("  check --phase <dispatch|review> --executor <name> [--model <name>] [--json]");
}

function requestedPhase(value) {
  if (value === "dispatch") return ADAPTER_PHASES.DISPATCH;
  if (value === "review") return ADAPTER_PHASES.PRIMARY_REVIEW;
  throw new Error("--phase must be dispatch or review");
}

function adapterStatus(name) {
  const adapter = getAdapter(name);
  const probe = adapter.probe({ timeoutMs: 5000 });
  return { adapter: name, probe };
}

function run(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = argv.slice(1);
  const unknown = findUnknownFlags(args, CLI_ARG_OPTIONS);
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const cli = bindCliArgs(args, CLI_ARG_OPTIONS);
  const jsonOut = cli.hasFlag("--json");
  if (!command || ["help", "--help", "-h"].includes(command) || cli.hasFlag(["--help", "-h"])) {
    printHelp();
    return 0;
  }
  if (command === "doctor") {
    const result = { ok: true, adapters: listAdapters().map(adapterStatus) };
    if (jsonOut) console.log(JSON.stringify(result, null, 2));
    else result.adapters.forEach(({ adapter, probe }) => console.log(`${adapter}: ${probe.status}`));
    return 0;
  }
  if (command !== "check") throw new Error(`unknown command '${command}'; supported: doctor, check`);
  const phase = requestedPhase(cli.getArg("--phase"));
  const actor = cli.getArg("--executor") || cli.getArg("--reviewer");
  if (!actor) throw new Error("--executor (or --reviewer for review) is required");
  const adapter = getAdapter(actor);
  const capability = validateCapabilities(adapter, phase, {
    readOnly: phase === ADAPTER_PHASES.PRIMARY_REVIEW,
    sandbox: phase === ADAPTER_PHASES.PRIMARY_REVIEW ? "read-only" : "workspace-write",
    networkAccess: "disabled",
  });
  const result = {
    ok: true,
    phase,
    adapter: actor,
    model: cli.getArg("--model") || null,
    model_source: cli.getArg("--model") ? "explicit" : "adapter_default",
    capability,
  };
  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else console.log(`${actor}: ${phase} supported; model=${result.model || "(adapter default)"}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { run };
