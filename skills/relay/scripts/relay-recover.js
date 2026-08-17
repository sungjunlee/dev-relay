#!/usr/bin/env node
"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

const runStore = require("../../relay-dispatch/scripts/run-store");
const { inspectProductionRun, recoverProductionRun } = require("../../relay-dispatch/scripts/recover");

const KNOWN_FLAGS = [
  "--repo", "--run-id", "--run-dir", "--reason", "--actor",
  "--expected-action-key", "--verification-file", "--break-lock", "--close",
  "--resolve-review", "--review-event-id", "--json", "--help", "-h",
];
const CLI_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--break-lock", "--close", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--run-dir", "--reason", "--actor", "--verification-file"],
};
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS), bool = new Set(CLI_OPTIONS.booleanFlags), verbatim = new Set(CLI_OPTIONS.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const variants = (flag) => Array.isArray(flag) ? flag : [flag]; return { hasFlag: (flags) => variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flags, fallback) => { for (const flag of variants(flags)) for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}

function usage() {
  return [
    "Usage:",
    "  relay-recover.js inspect (--repo <path> --run-id <id> | --run-dir <path>) [--json]",
    "  relay-recover.js recover (--repo <path> --run-id <id> | --run-dir <path>) --reason <text> [--actor <name>] [--expected-action-key <sha256>] [--verification-file <path>] [--break-lock] [--json]",
    "  relay-recover.js recover (--repo <path> --run-id <id> | --run-dir <path>) --reason <text> [--actor <name>] --resolve-review <re_review|redispatch> --review-event-id <id> [--json]",
    "  relay-recover.js recover (--repo <path> --run-id <id> | --run-dir <path>) --reason <text> [--actor <name>] --close [--json]",
    "",
    "inspect is strictly read-only. recover is the sole idempotent mutation operation for an immutable Relay run.",
  ].join("\n");
}

function getActorName(repoRoot) {
  if (process.env.RELAY_ACTOR?.trim()) return process.env.RELAY_ACTOR.trim();
  try {
    const value = execFileSync("git", ["-C", repoRoot, "config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (value) return value;
  } catch {}
  return String(process.env.USER || "relay-operator").trim() || "relay-operator";
}

function resolveRunDir(cli) {
  const explicit = cli.getArg("--run-dir");
  const runId = cli.getArg("--run-id");
  const repoArg = cli.getArg("--repo");
  if (explicit) {
    if (runId || repoArg) throw new Error("--run-dir is mutually exclusive with --repo/--run-id");
    return path.resolve(explicit);
  }
  if (!runId) throw new Error("--run-id is required with --repo");
  return runStore.resolveRunDirectory(path.resolve(repoArg || "."), runId);
}

function formatText(result) {
  const lines = [
    `Run: ${result.run_id}`,
    `Operation: ${result.operation}`,
  ];
  if (result.status) lines.push(`Status: ${result.status}`);
  const action = result.recommended_action || result.after?.recommended_action;
  if (action) lines.push(`Next: ${action.kind} (${action.reason})`);
  for (const item of result.blockers || []) lines.push(`Blocker: ${item.code}: ${item.message}`);
  for (const item of result.derived?.diagnostics || []) {
    const exits = Array.isArray(item.available_exits) ? `; exits: ${item.available_exits.join(", ")}` : "";
    lines.push(`Diagnostic: ${item.code}${exits}`);
  }
  return lines.join("\n");
}

function formatFailure(error, json) {
  const failure = {
    ok: false,
    code: error.code || "RECOVERY_FAILED",
    error: error.message,
  };
  if (error.code === "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED") {
    failure.recommended_action = error.recommended_action;
    failure.process_identity = error.process_identity;
    failure.relay_signalled = false;
  }
  if (json) return JSON.stringify(failure);
  const identity = failure.process_identity;
  const process = identity
    ? ` Exact process: pid=${identity.pid}, pgid=${identity.pgid}, started_at=${identity.started_at}.`
    : "";
  const next = failure.recommended_action
    ? " Verify and terminate that exact process outside Relay, then rerun the same canonical recovery."
    : "";
  return `relay-recover: ${failure.code}: ${failure.error}.${process}${next}`;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  const cli = parseCli(rest);
  if (!command || cli.hasFlag(["--help", "-h"])) {
    console.log(usage());
    return command ? 0 : 1;
  }
  if (!new Set(["inspect", "recover"]).has(command)) {
    throw new Error(`unknown operation ${command}; expected inspect or recover`);
  }
  let result;
  const runDir = resolveRunDir(cli);
  if (command === "inspect") {
    for (const flag of ["--reason", "--actor", "--expected-action-key", "--verification-file", "--break-lock", "--close", "--resolve-review", "--review-event-id"]) {
      if (cli.hasFlag(flag)) throw new Error(`${flag} is only valid for recover`);
    }
    result = await inspectProductionRun({ runDir });
  } else {
    const reason = String(cli.getArg("--reason") || "").trim();
    if (!reason) throw new Error("recover requires --reason <text>");
    const record = runStore.readRunRecord({ runDir });
    const actor = String(cli.getArg("--actor") || getActorName(record.repo.root)).trim();
    const close = cli.hasFlag("--close");
    const disposition = cli.getArg("--resolve-review") || null;
    const reviewEventId = cli.getArg("--review-event-id") || null;
    if (close && disposition) throw new Error("--close and --resolve-review are mutually exclusive");
    if (Boolean(disposition) !== Boolean(reviewEventId)) {
      throw new Error("--resolve-review and --review-event-id must be supplied together");
    }
    if (disposition && !new Set(["re_review", "redispatch"]).has(disposition)) {
      throw new Error("--resolve-review must be re_review or redispatch");
    }
    if ((close || disposition) && cli.hasFlag("--verification-file")) {
      throw new Error("--verification-file cannot be combined with --close or --resolve-review");
    }
    result = await recoverProductionRun({
      runDir,
      actor,
      reason,
      closeIntent: close ? { operator: actor, reason } : null,
      resolutionIntent: disposition ? {
        operator: actor, reason, disposition, escalatedReviewEventId: reviewEventId,
      } : null,
      expectedActionKey: cli.getArg("--expected-action-key") || null,
      verificationFile: cli.getArg("--verification-file") || null,
      breakLock: cli.hasFlag("--break-lock"),
    });
  }
  console.log(cli.hasFlag("--json") ? JSON.stringify(result, null, 2) : formatText(result));
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(formatFailure(error, process.argv.slice(2).includes("--json")));
    process.exitCode = 1;
  });
}

module.exports = { getActorName, main, resolveRunDir };
