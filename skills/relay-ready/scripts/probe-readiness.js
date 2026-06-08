#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const scoreReadiness = require("./score-readiness");
const { READINESS_CONDITIONS } = require("./score-readiness");
const { appendEventLineToPath, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { bindCliArgs } = require("../../relay-dispatch/scripts/cli-args");

const KNOWN_FLAGS = [
  "--body",
  "--body-file",
  "--issue-number",
  "--manifest",
  "--json",
  "--help",
  "-h",
];

const CONDITION_LABELS = Object.freeze({
  [READINESS_CONDITIONS.VAGUE_VERB]: "vague verb",
  [READINESS_CONDITIONS.MISSING_TARGET]: "missing target",
  [READINESS_CONDITIONS.SHORT_BODY]: "short body",
  [READINESS_CONDITIONS.TOP_LEVEL_AND]: "multi-part opener",
  [READINESS_CONDITIONS.MULTI_VERB_OPENER]: "multi-verb opener",
  [READINESS_CONDITIONS.BULLETS_ACROSS_MODULES]: "cross-module bullets",
  [READINESS_CONDITIONS.SUBJECTIVE_LANGUAGE]: "subjective criteria",
  [READINESS_CONDITIONS.MISSING_OBSERVABLE_DONE_CRITERIA]: "missing observable criteria",
  [READINESS_CONDITIONS.DONE_CRITERIA_HEADING]: "missing Done Criteria",
  [READINESS_CONDITIONS.OBSERVABLE_ASSERTION]: "missing observable assertion",
  [READINESS_CONDITIONS.HIGH_RISK_KEYWORD]: "high-risk keyword",
  [READINESS_CONDITIONS.SINGLE_LEAF]: "not single-leaf",
  [READINESS_CONDITIONS.STRONG_TASK_SHAPE]: "task-shape decomposition",
});

function elapsedMsSince(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function clipLine(value, maxLength = 140) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function parsePositiveInteger(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readInput(cliArgs) {
  const body = cliArgs.getArg("--body");
  const bodyFile = cliArgs.getArg("--body-file");
  const hasBody = body !== undefined;
  const hasBodyFile = bodyFile !== undefined;

  if (hasBody && hasBodyFile) {
    throw new Error("Use only one of --body or --body-file");
  }
  if (hasBody) return body;
  if (hasBodyFile) return fs.readFileSync(path.resolve(bodyFile), "utf-8");
  return fs.readFileSync(0, "utf-8");
}

function summarizeSignals(scoreResult) {
  if (scoreResult.bypass) {
    return "Ready: bypass conditions passed.";
  }

  const lowDimensions = Object.entries(scoreResult.readiness)
    .filter(([, level]) => level === "low")
    .map(([dimension]) => `${dimension}=low`);
  const failingConditions = scoreResult.signals
    .filter((signal) => signal.dimension === "bypass" && /^fail:/i.test(signal.evidence))
    .map((signal) => CONDITION_LABELS[signal.condition] || signal.condition);
  const parts = [...lowDimensions, ...failingConditions];

  if (!parts.length) {
    return clipLine(`Not bypassed: next action ${scoreResult.next_action}.`);
  }
  return clipLine(`Gaps: ${[...new Set(parts)].join(", ")}.`);
}

function emptyTaskShape() {
  return {
    strength: "none",
    strong: false,
    signals: [],
  };
}

function taskShapeEnvelope(taskShape) {
  if (!taskShape || typeof taskShape !== "object") {
    return emptyTaskShape();
  }
  return {
    strength: taskShape.strength || "none",
    strong: Boolean(taskShape.strong),
    signals: Array.isArray(taskShape.signals) ? taskShape.signals.map((signal) => ({
      condition: String(signal.condition || ""),
      evidence: clipLine(signal.evidence, 80),
    })) : [],
  };
}

function buildEnvelope(scoreResult, elapsedMs) {
  return {
    readiness_score: {
      clarity: scoreResult.readiness.clarity,
      granularity: scoreResult.readiness.granularity,
      verifiability: scoreResult.readiness.verifiability,
    },
    bypass: scoreResult.bypass,
    next_action: scoreResult.next_action,
    signals_summary: summarizeSignals(scoreResult),
    task_shape: taskShapeEnvelope(scoreResult.task_shape),
    elapsed_ms: elapsedMs,
  };
}

function buildDegradedEnvelope(error, elapsedMs) {
  return {
    readiness_score: {
      clarity: "medium",
      granularity: "medium",
      verifiability: "medium",
    },
    bypass: true,
    next_action: "proceed",
    signals_summary: clipLine(`Readiness probe degraded; proceeding fail-open: ${error.message}`),
    task_shape: emptyTaskShape(),
    elapsed_ms: elapsedMs,
  };
}

function resolveEventsPath(manifestPath) {
  const resolved = path.resolve(manifestPath);
  if (path.basename(resolved) === "events.jsonl" || resolved.endsWith(".jsonl")) {
    return resolved;
  }
  if (resolved.endsWith(".md")) {
    const runId = path.basename(resolved, ".md");
    return path.join(path.dirname(resolved), runId, "events.jsonl");
  }
  return resolved;
}

function appendReadinessProbeEvent(manifestPath, envelope, issueNumber) {
  const eventsPath = resolveEventsPath(manifestPath);
  const record = {
    ts: new Date().toISOString(),
    event: EVENTS.READINESS_PROBE,
    actor: "relay-ready",
    issue_number: issueNumber,
    readiness_score: envelope.readiness_score,
    bypass: envelope.bypass,
    next_action: envelope.next_action,
    task_shape: envelope.task_shape,
    elapsed_ms: envelope.elapsed_ms,
  };
  appendEventLineToPath(eventsPath, record);
}

function formatHuman(envelope) {
  return [
    `readiness_score=${JSON.stringify(envelope.readiness_score)}`,
    `bypass=${envelope.bypass}`,
    `next_action=${envelope.next_action}`,
    `signals_summary="${envelope.signals_summary}"`,
    `task_shape=${JSON.stringify(envelope.task_shape)}`,
    `elapsed_ms=${envelope.elapsed_ms.toFixed(3)}`,
  ].join(" ");
}

function usage() {
  return [
    "Usage: probe-readiness.js [--json] (--body <text> | --body-file <path> | < stdin)",
    "",
    "Options:",
    "  --body <text>        Issue body text",
    "  --body-file <path>   Issue body file",
    "  --issue-number <n>   Optional event tag",
    "  --manifest <path>    Optional events.jsonl or run manifest path",
    "  --json               Emit JSON envelope",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const startedAt = process.hrtime.bigint();
  const cliArgs = bindCliArgs(argv, {
    commandName: "probe-readiness",
    reservedFlags: KNOWN_FLAGS,
  });
  const jsonOut = cliArgs.hasFlag("--json");

  if (cliArgs.hasFlag(["--help", "-h"])) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let envelope;
  try {
    const body = readInput(cliArgs);
    const scoreResult = scoreReadiness(body);
    envelope = buildEnvelope(scoreResult, elapsedMsSince(startedAt));
  } catch (error) {
    envelope = buildDegradedEnvelope(error, elapsedMsSince(startedAt));
  }

  const manifestPath = cliArgs.getArg("--manifest");
  if (manifestPath) {
    try {
      appendReadinessProbeEvent(
        manifestPath,
        envelope,
        parsePositiveInteger(cliArgs.getArg("--issue-number"))
      );
    } catch {
      // The probe is fail-open: event persistence failures must not block /relay.
    }
  }

  process.stdout.write(jsonOut ? `${JSON.stringify(envelope)}\n` : `${formatHuman(envelope)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const envelope = buildDegradedEnvelope(error, 0);
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = 0;
  }
}

module.exports = {
  buildEnvelope,
  summarizeSignals,
  main,
};
