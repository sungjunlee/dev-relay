#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const scoreReadiness = require("./score-readiness");
const { READINESS_CONDITIONS } = require("./score-readiness");

const KNOWN_FLAGS = [
  "--body",
  "--body-file",
  "--json",
  "--help",
  "-h",
];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--body", "--body-file"],
};
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS), bool = new Set(CLI_ARG_OPTIONS.booleanFlags), verbatim = new Set(CLI_ARG_OPTIONS.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  return { hasFlag: (flags) => (Array.isArray(flags) ? flags : [flags]).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flag, fallback) => { for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}

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

function riskEnvelope(scoreResult) {
  const highRisk = Array.isArray(scoreResult?.signals)
    && scoreResult.signals.some((signal) => (
      signal?.condition === READINESS_CONDITIONS.HIGH_RISK_KEYWORD
        && /^fail:/i.test(String(signal.evidence || ""))
    ));
  return {
    high: highRisk,
    signals: highRisk ? [READINESS_CONDITIONS.HIGH_RISK_KEYWORD] : [],
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
    risk: riskEnvelope(scoreResult),
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
    risk: { high: false, signals: [] },
    elapsed_ms: elapsedMs,
  };
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
    "  --json               Emit JSON envelope",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const startedAt = process.hrtime.bigint();
  const cliArgs = parseCli(argv);
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

  process.stdout.write(jsonOut ? `${JSON.stringify(envelope)}\n` : `${formatHuman(envelope)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (/^unknown flags:/.test(String(error?.message || ""))) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
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
