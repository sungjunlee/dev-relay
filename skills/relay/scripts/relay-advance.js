#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const runStore = require("../../relay-dispatch/scripts/run-store");
const { inspectProductionRun, recoverProductionRun } = require("../../relay-dispatch/scripts/recover");

const KNOWN_FLAGS = [
  "--repo", "--run-id", "--run-dir", "--max-steps", "--verification-file", "--actor",
  "--json", "--help", "-h",
];
const VALUE_FLAGS = new Set(["--repo", "--run-dir", "--run-id", "--max-steps", "--verification-file", "--actor"]);

function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS);
  const consumed = new Set();
  const name = (token) => String(token).split("=", 1)[0];
  const accepts = (value) => value !== undefined && !String(value).startsWith("-");
  argv.forEach((token, index) => {
    const flag = name(token);
    if (known.has(flag) && VALUE_FLAGS.has(flag) && !String(token).includes("=") && accepts(argv[index + 1])) {
      consumed.add(index + 1);
    }
  });
  const unknown = argv.filter((token, index) => !consumed.has(index)
    && String(token).startsWith("-") && !known.has(name(token)));
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  if (argv.some((token, index) => !consumed.has(index) && !String(token).startsWith("-"))) {
    throw new Error("unexpected positional arguments");
  }
  const variants = (flag) => Array.isArray(flag) ? flag : [flag];
  return {
    hasFlag(flags) {
      return variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index)
        && (token === flag || String(token).startsWith(`${flag}=`))));
    },
    getArg(flags, fallback) {
      for (const flag of variants(flags)) {
        for (let index = 0; index < argv.length; index += 1) {
          if (consumed.has(index)) continue;
          const token = String(argv[index]);
          if (token !== flag && !token.startsWith(`${flag}=`)) continue;
          const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1);
          if (token === flag && !accepts(value)) throw new Error(`${flag} requires a non-empty value`);
          if (VALUE_FLAGS.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`);
          return value;
        }
      }
      return fallback;
    },
  };
}

function usage() {
  return [
    "Usage: relay-advance.js (--repo <path> --run-id <id> | --run-dir <path>) [options]",
    "",
    "Options:",
    "  --max-steps <n>           Maximum recoveries to apply (default: 8).",
    "  --verification-file <p>   Immutable verification evidence for record_verification.",
    "  --actor <name>            Recovery actor (default: RELAY_ACTOR or git user.name).",
    "  --json                    Emit one JSON object.",
    "",
    "Advance only invokes canonical recovery for a currently recommended recover action.",
  ].join("\n");
}

function getActorName(repoRoot) {
  if (process.env.RELAY_ACTOR?.trim()) return process.env.RELAY_ACTOR.trim();
  try {
    const value = execFileSync("git", ["-C", repoRoot, "config", "user.name"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (value) return value;
  } catch {}
  return String(process.env.USER || "relay-operator").trim() || "relay-operator";
}

function resolveRunDir(cli) {
  const explicit = cli.getArg("--run-dir");
  const runId = cli.getArg("--run-id");
  const repo = cli.getArg("--repo");
  if (explicit) {
    if (runId || repo) throw new Error("--run-dir is mutually exclusive with --repo/--run-id");
    return path.resolve(explicit);
  }
  if (!repo || !runId) throw new Error("--repo and --run-id are required unless --run-dir is provided");
  return runStore.resolveRunDirectory(path.resolve(repo), runId);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandFor(runDir, record, kind, verificationFile = null, actor = null) {
  const root = path.resolve(__dirname, "..", "..");
  const advance = path.join(root, "relay", "scripts", "relay-advance.js");
  const recover = path.join(root, "relay", "scripts", "relay-recover.js");
  const review = path.join(root, "relay-review", "scripts", "review-runner.js");
  const merge = path.join(root, "relay-merge", "scripts", "finalize-run.js");
  const dispatch = path.join(root, "relay-dispatch", "scripts", "dispatch.js");
  const run = shellQuote(runDir);
  const binding = `--repo ${shellQuote(record.repo.root)} --run-dir ${run}`;
  const actorArg = actor ? ` --actor ${shellQuote(actor)}` : "";
  if (kind === "review") return `node ${shellQuote(review)} ${binding} --json`;
  if (kind === "merge") return `node ${shellQuote(merge)} ${binding}${actorArg} --json`;
  if (kind === "redispatch") {
    return `node ${shellQuote(dispatch)} ${shellQuote(record.repo.root)} --run-id ${shellQuote(record.run_id)} --prompt '<operator correction prompt>' --json`;
  }
  if (kind === "wait" || kind === "step_budget_exhausted") {
    const extra = verificationFile ? ` --verification-file ${shellQuote(verificationFile)}` : "";
    return `node ${shellQuote(advance)} --run-dir ${run}${extra}${actorArg} --json`;
  }
  if (kind === "missing_required_input:verification_file") {
    return `node ${shellQuote(advance)} --run-dir ${run} --verification-file '<verification-file>'${actorArg} --json`;
  }
  return `node ${shellQuote(recover)} inspect --run-dir ${run} --json`;
}

function formatText(result) {
  const lines = [
    `Run: ${result.run_id}`,
    `Applied recover actions: ${result.applied_actions}`,
    `Stop: ${result.stop_reason}`,
    `Final action: ${result.recommended_action?.kind || "unknown"}${result.recommended_action?.reason ? ` (${result.recommended_action.reason})` : ""}`,
    `Next: ${result.next_command}`,
  ];
  if (result.failure) lines.push(`Failure: ${result.failure.code}: ${result.failure.message}`);
  return lines.join("\n");
}

function formatFailure(error, json) {
  const failure = { ok: false, code: error.code || "ADVANCE_FAILED", error: error.message };
  return json ? JSON.stringify(failure) : `relay-advance: ${failure.code}: ${failure.error}`;
}

async function advanceRun({ runDir, actor, maxSteps, verificationFile = null }) {
  const record = runStore.readRunRecord({ runDir });
  let appliedActions = 0;
  let finalInspection = null;
  let failure = null;
  let stopReason = null;
  let stepsUsed = 0;
  for (;;) {
    finalInspection = await inspectProductionRun({ runDir });
    const action = finalInspection.recommended_action || {};
    const kind = action.kind;
    if (kind !== "recover") {
      stopReason = kind || "operator_attention";
      break;
    }
    const required = Array.isArray(action.required_inputs) ? action.required_inputs : [];
    const providedInputs = new Set(verificationFile ? ["verification_file"] : []);
    const missing = required.filter((input) => !providedInputs.has(input));
    if (missing.length) {
      stopReason = `missing_required_input:${missing[0]}`;
      break;
    }
    if (stepsUsed >= maxSteps) {
      stopReason = "step_budget_exhausted";
      break;
    }
    let recovered;
    try {
      recovered = await recoverProductionRun({
        runDir,
        actor,
        reason: `relay-advance: ${action.reason}`,
        expectedActionKey: action.key,
        verificationFile,
      });
      if (!recovered || !new Set(["converged", "noop"]).has(recovered.status)) {
        const blocker = recovered?.blockers?.[0];
        const error = new Error(blocker?.message || `canonical recovery returned status ${recovered?.status || "unknown"}`);
        error.code = blocker?.code || "RECOVERY_REFUSED";
        throw error;
      }
    } catch (error) {
      failure = { code: error.code || "RECOVERY_FAILED", message: error.message };
      stopReason = "recover_failed";
      break;
    }
    stepsUsed += 1;
    if (recovered.status === "converged") appliedActions += 1;
  }
  const result = {
    ok: !failure,
    run_id: record.run_id,
    applied_actions: appliedActions,
    stop_reason: stopReason,
    recommended_action: finalInspection?.recommended_action || null,
    final_inspection: finalInspection,
    next_command: commandFor(runDir, record, stopReason, verificationFile, actor),
  };
  if (failure) result.failure = failure;
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (!argv.length || cli.hasFlag(["--help", "-h"])) {
    console.log(usage());
    return argv.length ? 0 : 1;
  }
  const runDir = resolveRunDir(cli);
  const suppliedMaxRaw = cli.getArg("--max-steps");
  if (cli.hasFlag("--max-steps") && suppliedMaxRaw === undefined) throw new Error("--max-steps requires a positive integer");
  const maxRaw = suppliedMaxRaw ?? "8";
  const maxSteps = Number(maxRaw);
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) throw new Error("--max-steps must be a positive integer");
  const record = runStore.readRunRecord({ runDir });
  const actor = String(cli.getArg("--actor") || getActorName(record.repo.root)).trim();
  const result = await advanceRun({
    runDir,
    actor,
    maxSteps,
    verificationFile: cli.getArg("--verification-file") || null,
  });
  console.log(cli.hasFlag("--json") ? JSON.stringify(result, null, 2) : formatText(result));
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(formatFailure(error, process.argv.slice(2).includes("--json")));
    process.exitCode = 1;
  });
}

module.exports = {
  advanceRun,
  commandFor,
  formatFailure,
  getActorName,
  main,
  parseCli,
  resolveRunDir,
};
