#!/usr/bin/env node
"use strict";

// Exceptional operator command for monotonically extending review.max_rounds.
//
// Trust root: the manifest lock acquired by withManifestTransaction is the
// enforcement layer. Any guard display or validation before that lock is only
// advisory. The mutating path re-reads the manifest, validates every guard, and
// performs the manifest/event pair while the same per-run lock remains held.

const fs = require("fs");
const path = require("path");

const { bindCliArgs, findUnknownFlags, modeLabel } = require("./cli-args");
const { STATES, isTerminalState } = require("./manifest/lifecycle");
const { nowIso } = require("./manifest/paths");
const {
  parseFrontmatter,
  withManifestTransaction,
  writeManifestUnlocked,
} = require("./manifest/store");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");

const COMMAND_NAME = "extend-review-policy";
const CLI_ARG_OPTIONS = { commandName: COMMAND_NAME, reservedFlags: ["-h"] };
const ACTIVE_STATES = new Set(Object.values(STATES).filter((state) => !isTerminalState(state)));

class PolicyUpdateRefusal extends Error {
  constructor(result) {
    super(result.message);
    this.name = "PolicyUpdateRefusal";
    this.result = result;
  }
}

function refuse(errorCode, message, details = {}) {
  throw new PolicyUpdateRefusal({
    status: "refused",
    error_code: errorCode,
    message,
    ...details,
  });
}

function parsePositiveInteger(value, label) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    refuse("invalid_max_rounds", `${label} must be an explicitly supplied positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    refuse("invalid_max_rounds", `${label} must be a safe positive integer`);
  }
  return parsed;
}

function parseExpectedRound(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) {
    refuse("invalid_expected_round", "--expected-round must be a non-negative integer");
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    refuse("invalid_expected_round", "--expected-round must be a safe non-negative integer");
  }
  return parsed;
}

function requireReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    refuse("missing_reason", "--reason must be non-empty");
  }
  return reason;
}

function requireMutationGuards({ expectedState, expectedRound, expectedHead }) {
  const missing = [];
  if (typeof expectedState !== "string" || !expectedState.trim()) missing.push("--expected-state");
  if (expectedRound === undefined || expectedRound === null || expectedRound === "") missing.push("--expected-round");
  if (typeof expectedHead !== "string" || !expectedHead.trim()) missing.push("--expected-head");
  if (missing.length) {
    refuse(
      "missing_guards",
      `Mutating calls require explicit optimistic guards: ${missing.join(", ")}. Run with --dry-run to derive them.`
    );
  }
}

function validateManifestSnapshot(data) {
  if (!ACTIVE_STATES.has(data?.state)) {
    const code = isTerminalState(data?.state) ? "terminal_state" : "invalid_state";
    refuse(code, `Review policy cannot be extended while the run state is '${String(data?.state)}'`, {
      actual_state: data?.state ?? null,
    });
  }

  const round = data?.review?.rounds;
  if (!Number.isInteger(round) || round < 0) {
    refuse("invalid_manifest_round", "Persisted review.rounds must be a non-negative integer", {
      actual_round: round ?? null,
    });
  }

  const head = data?.git?.head_sha;
  if (typeof head !== "string" || !head.trim()) {
    refuse("missing_manifest_head", "Persisted git.head_sha must be non-empty before review policy can be extended", {
      actual_head: head ?? null,
    });
  }

  const oldMaxRounds = data?.review?.max_rounds;
  if (!Number.isInteger(oldMaxRounds) || oldMaxRounds <= 0) {
    refuse("invalid_persisted_policy", "Persisted review.max_rounds must be a positive integer", {
      actual_max_rounds: oldMaxRounds ?? null,
    });
  }

  return { state: data.state, round, head, oldMaxRounds };
}

function validateGuards(snapshot, guards) {
  const mismatches = [];
  if (guards.expectedState !== snapshot.state) {
    mismatches.push({ guard: "expected_state", expected: guards.expectedState, actual: snapshot.state });
  }
  if (guards.expectedRound !== snapshot.round) {
    mismatches.push({ guard: "expected_round", expected: guards.expectedRound, actual: snapshot.round });
  }
  if (guards.expectedHead !== snapshot.head) {
    mismatches.push({ guard: "expected_head", expected: guards.expectedHead, actual: snapshot.head });
  }
  if (mismatches.length) {
    refuse("concurrent_manifest_drift", "Manifest state, round, or HEAD no longer matches the supplied guards", {
      mismatches,
      guards: {
        expected_state: guards.expectedState,
        expected_round: guards.expectedRound,
        expected_head: guards.expectedHead,
      },
      actual: {
        state: snapshot.state,
        round: snapshot.round,
        head: snapshot.head,
      },
    });
  }
}

function getEventsPathForManifest(manifestPath, runId) {
  return path.join(path.dirname(manifestPath), runId, "events.jsonl");
}

function inspectEventSink(eventsPath, fsApi = fs) {
  let stat;
  try {
    stat = fsApi.lstatSync(eventsPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      refuse("missing_event_sink", `Required event sink does not exist: ${eventsPath}`, { events_path: eventsPath });
    }
    refuse("unwritable_event_sink", `Cannot inspect event sink ${eventsPath}: ${error.message}`, { events_path: eventsPath });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    refuse("unwritable_event_sink", `Event sink must be an existing regular file: ${eventsPath}`, { events_path: eventsPath });
  }
  if ((stat.mode & 0o222) === 0) {
    refuse("unwritable_event_sink", `Event sink has no writable permission bits: ${eventsPath}`, { events_path: eventsPath });
  }
  try {
    fsApi.accessSync(eventsPath, fs.constants.W_OK);
    return { bytes: fsApi.readFileSync(eventsPath), stat };
  } catch (error) {
    refuse("unwritable_event_sink", `Event sink is not writable: ${eventsPath}: ${error.message}`, {
      events_path: eventsPath,
    });
  }
}

function restoreFileBytes(filePath, bytes, stat, fsApi = fs) {
  const tmpPath = `${filePath}.rollback.${process.pid}.${Date.now()}`;
  try {
    fsApi.writeFileSync(tmpPath, bytes, { mode: stat.mode & 0o777 });
    fsApi.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fsApi.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function normalizeOptions(options) {
  const dryRun = options.dryRun === true;
  const maxRounds = parsePositiveInteger(options.maxRounds, "--max-rounds");
  const reason = requireReason(options.reason);
  if (!options.runId && !options.manifestPath) {
    refuse("missing_target", "Provide --run-id or --manifest");
  }
  if (!dryRun) requireMutationGuards(options);

  return {
    ...options,
    repoRoot: path.resolve(options.repoRoot || "."),
    maxRounds,
    reason,
    dryRun,
    expectedRound: options.expectedRound === undefined || options.expectedRound === null || options.expectedRound === ""
      ? undefined
      : parseExpectedRound(options.expectedRound),
  };
}

function extendReviewPolicy(options, dependencies = {}) {
  const runtime = {
    appendRunEvent,
    fs,
    nowIso,
    parseFrontmatter,
    resolveManifestRecord,
    withManifestTransaction,
    writeManifestUnlocked,
    ...dependencies,
  };
  const normalized = normalizeOptions(options);

  let resolved;
  try {
    resolved = runtime.resolveManifestRecord({
      repoRoot: normalized.repoRoot,
      runId: normalized.runId,
      manifestPath: normalized.manifestPath,
    });
  } catch (error) {
    if (error instanceof PolicyUpdateRefusal) throw error;
    refuse("run_resolution_failed", `Cannot resolve relay run: ${error.message}`);
  }

  try {
    return runtime.withManifestTransaction(resolved.manifestPath, () => {
      let current;
      let originalManifestBytes;
      let originalManifestStat;
      try {
        originalManifestBytes = runtime.fs.readFileSync(resolved.manifestPath);
        originalManifestStat = runtime.fs.lstatSync(resolved.manifestPath);
        current = runtime.parseFrontmatter(originalManifestBytes.toString("utf-8"));
      } catch (error) {
        refuse("manifest_read_failed", `Cannot read locked manifest snapshot: ${error.message}`, {
          manifest_path: resolved.manifestPath,
        });
      }

      if (current.data?.run_id !== resolved.data?.run_id) {
        refuse("concurrent_manifest_drift", "Manifest run_id changed after resolution", {
          expected_run_id: resolved.data?.run_id ?? null,
          actual_run_id: current.data?.run_id ?? null,
        });
      }

      const snapshot = validateManifestSnapshot(current.data);
      const effectiveGuards = {
        expectedState: normalized.expectedState ?? snapshot.state,
        expectedRound: normalized.expectedRound ?? snapshot.round,
        expectedHead: normalized.expectedHead ?? snapshot.head,
      };

      // Mutating calls always supplied all three guards. Dry-runs may derive
      // omitted guards, but any explicitly supplied guard is still checked.
      validateGuards(snapshot, effectiveGuards);

      if (normalized.maxRounds <= snapshot.oldMaxRounds) {
        refuse(
          "non_monotonic_max_rounds",
          `--max-rounds must be strictly greater than persisted review.max_rounds=${snapshot.oldMaxRounds}`,
          { current_max_rounds: snapshot.oldMaxRounds, requested_max_rounds: normalized.maxRounds }
        );
      }

      const eventsPath = getEventsPathForManifest(resolved.manifestPath, current.data.run_id);
      const eventSinkSnapshot = inspectEventSink(eventsPath, runtime.fs);
      const resultBase = {
        status: normalized.dryRun ? "dry_run" : "updated",
        manifestPath: resolved.manifestPath,
        runId: current.data.run_id,
        dryRun: normalized.dryRun,
        reason: normalized.reason,
        guards: {
          expected_state: snapshot.state,
          expected_round: snapshot.round,
          expected_head: snapshot.head,
        },
        delta: {
          current_max_rounds: snapshot.oldMaxRounds,
          requested_max_rounds: normalized.maxRounds,
          increase: normalized.maxRounds - snapshot.oldMaxRounds,
        },
      };

      if (normalized.dryRun) return resultBase;

      const updated = {
        ...current.data,
        review: {
          ...(current.data.review || {}),
          max_rounds: normalized.maxRounds,
        },
        timestamps: {
          ...(current.data.timestamps || {}),
          updated_at: runtime.nowIso(),
        },
      };

      try {
        runtime.writeManifestUnlocked(resolved.manifestPath, updated, current.body);
      } catch (error) {
        refuse("manifest_write_failed", `Manifest policy write failed: ${error.message}`, {
          manifest_path: resolved.manifestPath,
        });
      }

      let event;
      try {
        // Event values come only from the locked manifest snapshot and the
        // manifest object just written, never from raw CLI guard values.
        event = runtime.appendRunEvent(
          current.data.paths?.repo_root || normalized.repoRoot,
          current.data.run_id,
          {
            event: EVENTS.POLICY_UPDATED,
            state: snapshot.state,
            state_from: snapshot.state,
            state_to: snapshot.state,
            round: snapshot.round,
            head_sha: snapshot.head,
            old_max_rounds: snapshot.oldMaxRounds,
            new_max_rounds: updated.review.max_rounds,
            reason: normalized.reason,
            origin: "operator",
          },
          { eventsPath, lockHeld: true }
        );
      } catch (error) {
        const rollbackErrors = [];
        try {
          restoreFileBytes(resolved.manifestPath, originalManifestBytes, originalManifestStat, runtime.fs);
        } catch (rollbackError) {
          rollbackErrors.push(`manifest: ${rollbackError.message}`);
        }
        try {
          restoreFileBytes(eventsPath, eventSinkSnapshot.bytes, eventSinkSnapshot.stat, runtime.fs);
        } catch (rollbackError) {
          rollbackErrors.push(`events: ${rollbackError.message}`);
        }
        refuse(
          rollbackErrors.length ? "policy_update_rollback_failed" : "event_append_failed",
          `Policy event append failed: ${error.message}` +
            (rollbackErrors.length ? `; rollback also failed (${rollbackErrors.join("; ")})` : "; manifest and event bytes were restored"),
          { manifest_path: resolved.manifestPath, events_path: eventsPath, rollback_errors: rollbackErrors }
        );
      }

      return { ...resultBase, event };
    });
  } catch (error) {
    if (error instanceof PolicyUpdateRefusal) throw error;
    if (error?.code === "MANIFEST_LOCK_TIMEOUT") {
      refuse("lock_contention", `Could not acquire the manifest lock: ${error.message}`, {
        manifest_path: resolved.manifestPath,
        lock_path: error.lockPath || null,
      });
    }
    refuse("policy_update_failed", `Review policy update failed: ${error.message}`, {
      manifest_path: resolved.manifestPath,
    });
  }
}

function printUsage(stream = console.log) {
  stream(
    "Usage: extend-review-policy.js (--repo <path> --run-id <id> | --manifest <path>) --max-rounds <n> --reason <text> " +
    "[--expected-state <state> --expected-round <n> --expected-head <sha>] [--dry-run] [--json]\n\n" +
    "Options:\n" +
    `  --repo <path>          ${modeLabel("--repo")} Repository root\n` +
    `  --run-id <id>          ${modeLabel("--run-id")} Relay run identifier\n` +
    `  --manifest <path>      ${modeLabel("--manifest")} Explicit manifest path\n` +
    `  --max-rounds <n>       ${modeLabel("--max-rounds")} Strictly higher review round cap\n` +
    `  --reason <text>        ${modeLabel("--reason")} Non-empty operator audit reason\n` +
    `  --expected-state <s>   ${modeLabel("--expected-state")} Locked manifest state guard\n` +
    `  --expected-round <n>   ${modeLabel("--expected-round")} Locked review round guard\n` +
    `  --expected-head <sha>  ${modeLabel("--expected-head")} Locked manifest HEAD guard\n` +
    `  --dry-run              ${modeLabel("--dry-run")} Derive guards and report the delta without mutation\n` +
    `  --json                 ${modeLabel("--json")} Output structured JSON\n` +
    `  --help                 ${modeLabel("--help")} Show this help`
  );
}

function printResult(result, jsonOut) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.dryRun ? "Review policy extension dry-run:" : "Review policy extended:");
  console.log(`  Run:        ${result.runId}`);
  console.log(`  Max rounds: ${result.delta.current_max_rounds} -> ${result.delta.requested_max_rounds}`);
  console.log(`  State:      ${result.guards.expected_state}`);
  console.log(`  Round:      ${result.guards.expected_round}`);
  console.log(`  HEAD:       ${result.guards.expected_head}`);
  console.log(`  Reason:     ${result.reason}`);
  if (result.dryRun) console.log("  dry-run:    no manifest or event changes written");
}

function printRefusal(result, jsonOut) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error(`Refused review-policy extension [${result.error_code}]: ${result.message}`);
  if (result.mismatches) {
    for (const mismatch of result.mismatches) {
      console.error(`  ${mismatch.guard}: expected ${String(mismatch.expected)}, actual ${String(mismatch.actual)}`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const cli = bindCliArgs(argv, CLI_ARG_OPTIONS);
  if (cli.hasFlag(["--help", "-h"])) {
    printUsage();
    return 0;
  }
  const jsonOut = cli.hasFlag("--json");
  try {
    const unknownFlags = findUnknownFlags(argv, COMMAND_NAME);
    if (unknownFlags.length) {
      refuse("unknown_flags", `unknown flags: ${unknownFlags.join(", ")}`);
    }
    const result = extendReviewPolicy({
      repoRoot: cli.getArg("--repo", "."),
      runId: cli.getArg("--run-id", undefined),
      manifestPath: cli.getArg("--manifest", undefined),
      maxRounds: cli.getArg("--max-rounds", undefined),
      reason: cli.getArg("--reason", undefined),
      expectedState: cli.getArg("--expected-state", undefined),
      expectedRound: cli.getArg("--expected-round", undefined),
      expectedHead: cli.getArg("--expected-head", undefined),
      dryRun: cli.hasFlag("--dry-run"),
    });
    printResult(result, jsonOut);
    return 0;
  } catch (error) {
    const result = error instanceof PolicyUpdateRefusal
      ? error.result
      : { status: "refused", error_code: "invalid_arguments", message: error.message };
    printRefusal(result, jsonOut);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  PolicyUpdateRefusal,
  extendReviewPolicy,
  main,
};
