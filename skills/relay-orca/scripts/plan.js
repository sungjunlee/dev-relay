#!/usr/bin/env node
"use strict";

// relay-orca `plan` — a deterministic, READ-ONLY compiler (D6). It converts an
// already-accepted program contract into an ordered, immutable wave plan. It only
// ever reads its input file and writes to stdout/stderr: it creates no Orca
// task/terminal, no relay request/run/worktree, no pull request, no tracker issue,
// and no files. It deliberately avoids any subprocess or cross-skill module so it
// structurally cannot mutate external state.
const fs = require("node:fs");
const { compileProgram } = require("./lib/compile-program");
const { PlanError } = require("./lib/reasons");

const USAGE_EXIT = 64;

function parseArgs(argv) {
  const opts = { programFile: null, json: false, concurrency: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-file" || arg === "-f") opts.programFile = argv[(i += 1)];
    else if (arg === "--json") opts.json = true;
    else if (arg === "--concurrency") opts.concurrency = Number(argv[(i += 1)]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.programFile) opts.programFile = arg;
    else usageError(`unrecognized argument: ${arg}`);
  }
  return opts;
}

function usageError(message) {
  process.stderr.write(`relay-orca plan: ${message}\n`);
  process.stderr.write("usage: plan.js --program-file <accepted-program.json> [--json] [--concurrency N]\n");
  process.exit(USAGE_EXIT);
}

function readProgram(programFile) {
  if (!programFile) usageError("--program-file is required");
  let text;
  try {
    text = fs.readFileSync(programFile, "utf-8");
  } catch (error) {
    usageError(`cannot read program file ${programFile}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    usageError(`program file ${programFile} is not valid JSON: ${error.message}`);
  }
}

function printPlan(plan, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`relay-orca plan for ${plan.program_id} (concurrency ${plan.concurrency})\n`);
  plan.waves.forEach((wave) => {
    process.stdout.write(`  wave ${wave.wave}: ${wave.task_ids.join(", ")}\n`);
  });
  process.stdout.write(`  exit gates: ${plan.exit_gates.length}\n`);
}

function fail(error, json) {
  if (!(error instanceof PlanError)) throw error;
  const body = { ok: false, reason_code: error.reasonCode, message: error.message };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca plan rejected [${error.reasonCode}]: ${error.message}\n`);
  process.exit(error.exitCode);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("read-only wave-plan compiler");
  const program = readProgram(opts.programFile);
  try {
    printPlan(compileProgram(program, { concurrency: opts.concurrency }), opts.json);
  } catch (error) {
    fail(error, opts.json);
  }
}

main();
