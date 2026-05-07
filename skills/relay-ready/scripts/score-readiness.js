"use strict";

const READINESS_CONDITIONS = Object.freeze({
  VAGUE_VERB: "vague_verb",
  MISSING_TARGET: "missing_target",
  SHORT_BODY: "short_body",
  EXPLICIT_TARGET: "explicit_target",
  OBSERVABLE_END_STATE: "observable_end_state",
  TOP_LEVEL_AND: "top_level_and",
  MULTI_VERB_OPENER: "multi_verb_opener",
  BULLETS_ACROSS_MODULES: "bullets_across_modules",
  SINGLE_VERB: "single_verb",
  SINGLE_SUBSYSTEM: "single_subsystem",
  SUBJECTIVE_LANGUAGE: "subjective_language",
  MISSING_OBSERVABLE_DONE_CRITERIA: "missing_observable_done_criteria",
  TEST_PATH: "test_path",
  LOG_LINE: "log_line",
  FILE_DIFF_TARGET: "file_diff_target",
  NUMERIC_THRESHOLD: "numeric_threshold",
  DONE_CRITERIA_HEADING: "done_criteria_heading",
  OBSERVABLE_ASSERTION: "observable_assertion",
  HIGH_RISK_KEYWORD: "high_risk_keyword",
  SINGLE_LEAF: "single_leaf",
});

const VAGUE_VERB_RE = /\b(?:improve|enhance|clean up|polish)\b/i;
const SUBJECTIVE_LANGUAGE_RE = /\b(?:feels|good|smoother|nicer)\b/i;
const HIGH_RISK_RE = /\b(?:migration|drop|delete|schema|auth|secret|prod)\b/i;
const DONE_CRITERIA_HEADING_RE = /^##\s+(?:Done Criteria|Acceptance Criteria)\s*$/im;
const FILE_PATH_RE = /`?(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?::\d+)?`?/i;
const TEST_PATH_RE = /`?(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:test|spec)\.[A-Za-z0-9]+`?/i;
const FUNCTION_RE = /`?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\)`?/;
const NUMERIC_THRESHOLD_RE = /\b(?:p\d{2}|latency|duration|coverage|count|runs?|size)?\s*(?:<=|>=|<|>|=|\u2264|\u2265)\s*\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|gb|%|runs?)?\b/i;
const LOG_LINE_RE = /\b(?:prints?|logs?|emits?|outputs?|stderr|stdout|console)\b.{0,50}`[^`\n]+`/i;

const ACTION_VERBS = Object.freeze([
  "add",
  "backfill",
  "build",
  "change",
  "clean",
  "create",
  "delete",
  "document",
  "fix",
  "implement",
  "move",
  "polish",
  "refactor",
  "remove",
  "rename",
  "replace",
  "update",
]);

const ACTION_VERB_RE = new RegExp(`\\b(?:${ACTION_VERBS.join("|")})\\b`, "ig");
const SHARED_OBJECT_MULTI_VERB_RE = new RegExp(
  `^\\s*(?:please\\s+)?(?:${ACTION_VERBS.join("|")})\\s+and\\s+(?:${ACTION_VERBS.join("|")})\\s+`,
  "i"
);
const CLAUSE_AND_RE = new RegExp(
  `\\b(?:${ACTION_VERBS.join("|")})\\b[^\\n.;:]*\\band\\s+(?:${ACTION_VERBS.join("|")})\\b`,
  "i"
);

function scoreReadiness(input, metadata = {}) {
  const normalized = normalizeInput(input, metadata);
  const body = normalized.body;
  const combinedText = [normalized.title, body].filter(Boolean).join("\n").trim();
  const scanText = stripFencedCodeBlocks(combinedText);
  const criteria = extractCriteriaSection(body);
  const criteriaObservable = criteria.section ? findObservable(criteria.section) : null;
  const highRisk = findFirst(scanText, HIGH_RISK_RE);
  const granularitySignals = inspectGranularity(scanText);
  const signals = [];

  addBypassSignals(signals, {
    criteria,
    criteriaObservable,
    highRisk,
    granularitySignals,
  });

  const clarity = scoreClarity(signals, combinedText, scanText);
  const granularity = scoreGranularity(signals, granularitySignals);
  const verifiability = scoreVerifiability(signals, combinedText, scanText, criteria, criteriaObservable);
  const readiness = { clarity, granularity, verifiability };
  const bypass = Boolean(
    criteria.heading
      && criteriaObservable
      && !highRisk
      && granularitySignals.singleLeaf
  );

  return {
    readiness,
    bypass,
    signals,
    next_action: determineNextAction(readiness, bypass, Boolean(highRisk)),
  };
}

function normalizeInput(input, metadata) {
  if (typeof input === "string") {
    return {
      title: normalizeString(metadata.title || metadata.issueTitle || ""),
      body: input,
    };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    return {
      title: normalizeString(input.title || metadata.title || metadata.issueTitle || ""),
      body: normalizeString(
        input.body
          || input.text
          || input.request_text
          || input.issueBody
          || metadata.body
          || ""
      ),
    };
  }

  return {
    title: normalizeString(metadata.title || metadata.issueTitle || ""),
    body: normalizeString(metadata.body || ""),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function stripFencedCodeBlocks(value) {
  return value.replace(/```[\s\S]*?```/g, "\n");
}

function extractCriteriaSection(body) {
  const heading = body.match(DONE_CRITERIA_HEADING_RE);
  if (!heading) {
    return { heading: null, section: "" };
  }

  const sectionStart = heading.index + heading[0].length;
  const rest = body.slice(sectionStart);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return {
    heading: heading[0].trim(),
    section,
  };
}

function addBypassSignals(signals, { criteria, criteriaObservable, highRisk, granularitySignals }) {
  pushSignal(
    signals,
    "bypass",
    READINESS_CONDITIONS.DONE_CRITERIA_HEADING,
    criteria.heading
      ? `pass: ${criteria.heading}`
      : "fail: missing Done Criteria or Acceptance Criteria heading"
  );
  pushSignal(
    signals,
    "bypass",
    READINESS_CONDITIONS.OBSERVABLE_ASSERTION,
    criteriaObservable
      ? `pass: ${criteriaObservable.evidence}`
      : "fail: no observable assertion in criteria section"
  );
  pushSignal(
    signals,
    "bypass",
    READINESS_CONDITIONS.HIGH_RISK_KEYWORD,
    highRisk
      ? `fail: ${highRisk}`
      : "pass: no high-risk keyword outside fenced code"
  );
  pushSignal(
    signals,
    "bypass",
    READINESS_CONDITIONS.SINGLE_LEAF,
    granularitySignals.singleLeaf
      ? "pass: no top-level and, multi-verb opener, or cross-module bullets"
      : `fail: ${granularitySignals.singleLeafFailures.join(", ")}`
  );
}

function scoreClarity(signals, combinedText, scanText) {
  const firstParagraph = getFirstParagraph(scanText);
  const vagueVerb = findFirst(scanText, VAGUE_VERB_RE);
  const explicitTarget = findTarget(scanText);
  const observableEndState = findObservable(firstParagraph);
  const shortBody = combinedText.trim().length < 200;

  if (vagueVerb) {
    pushSignal(signals, "clarity", READINESS_CONDITIONS.VAGUE_VERB, vagueVerb);
  }
  if (!explicitTarget) {
    pushSignal(signals, "clarity", READINESS_CONDITIONS.MISSING_TARGET, "no target file or function");
  } else {
    pushSignal(signals, "clarity", READINESS_CONDITIONS.EXPLICIT_TARGET, explicitTarget);
  }
  if (shortBody) {
    pushSignal(signals, "clarity", READINESS_CONDITIONS.SHORT_BODY, `${combinedText.trim().length} chars`);
  }
  if (observableEndState) {
    pushSignal(signals, "clarity", READINESS_CONDITIONS.OBSERVABLE_END_STATE, observableEndState.evidence);
  }

  if (explicitTarget && observableEndState) {
    return "high";
  }
  if (vagueVerb || (!explicitTarget && shortBody)) {
    return "low";
  }
  return "medium";
}

function scoreGranularity(signals, granularitySignals) {
  if (granularitySignals.topLevelAnd) {
    pushSignal(signals, "granularity", READINESS_CONDITIONS.TOP_LEVEL_AND, granularitySignals.topLevelAnd);
  }
  if (granularitySignals.multiVerbOpener) {
    pushSignal(signals, "granularity", READINESS_CONDITIONS.MULTI_VERB_OPENER, granularitySignals.multiVerbOpener);
  }
  if (granularitySignals.bulletsAcrossModules) {
    pushSignal(
      signals,
      "granularity",
      READINESS_CONDITIONS.BULLETS_ACROSS_MODULES,
      granularitySignals.bulletsAcrossModules
    );
  }
  if (granularitySignals.singleVerb) {
    pushSignal(signals, "granularity", READINESS_CONDITIONS.SINGLE_VERB, granularitySignals.singleVerb);
  }
  if (granularitySignals.singleSubsystem) {
    pushSignal(signals, "granularity", READINESS_CONDITIONS.SINGLE_SUBSYSTEM, granularitySignals.singleSubsystem);
  }

  if (
    granularitySignals.topLevelAnd
      || granularitySignals.bulletsAcrossModules
      || (granularitySignals.multiVerbOpener && !granularitySignals.singleSubsystem)
  ) {
    return "low";
  }
  if (granularitySignals.singleVerb && granularitySignals.singleSubsystem && !granularitySignals.multiVerbOpener) {
    return "high";
  }
  return "medium";
}

function scoreVerifiability(signals, combinedText, scanText, criteria, criteriaObservable) {
  const subjectiveLanguage = findFirst(scanText, SUBJECTIVE_LANGUAGE_RE);
  const testPath = findFirst(combinedText, TEST_PATH_RE);
  const logLine = findFirst(combinedText, LOG_LINE_RE);
  const fileDiffTarget = findFirst(combinedText, FILE_PATH_RE);
  const numericThreshold = findFirst(combinedText, NUMERIC_THRESHOLD_RE);

  if (subjectiveLanguage) {
    pushSignal(signals, "verifiability", READINESS_CONDITIONS.SUBJECTIVE_LANGUAGE, subjectiveLanguage);
  }
  if (criteria.heading && !criteriaObservable) {
    pushSignal(
      signals,
      "verifiability",
      READINESS_CONDITIONS.MISSING_OBSERVABLE_DONE_CRITERIA,
      criteria.heading
    );
  }
  if (testPath) {
    pushSignal(signals, "verifiability", READINESS_CONDITIONS.TEST_PATH, testPath);
  }
  if (logLine) {
    pushSignal(signals, "verifiability", READINESS_CONDITIONS.LOG_LINE, logLine);
  }
  if (fileDiffTarget) {
    pushSignal(signals, "verifiability", READINESS_CONDITIONS.FILE_DIFF_TARGET, fileDiffTarget);
  }
  if (numericThreshold) {
    pushSignal(signals, "verifiability", READINESS_CONDITIONS.NUMERIC_THRESHOLD, numericThreshold);
  }

  if (subjectiveLanguage || (criteria.heading && !criteriaObservable)) {
    return "low";
  }
  if (testPath || logLine || fileDiffTarget || numericThreshold) {
    return "high";
  }
  return "medium";
}

function inspectGranularity(text) {
  const opener = getOpener(text);
  const actionVerbs = extractActionVerbs(opener);
  const multiVerbOpener = actionVerbs.length > 1 ? actionVerbs.join(" and ") : null;
  const topLevelAnd = detectTopLevelAnd(opener);
  const bulletsAcrossModules = detectBulletsAcrossModules(text);
  const subsystems = extractSubsystems(text);
  const singleSubsystem = subsystems.length === 1 ? subsystems[0] : null;
  const singleVerb = actionVerbs.length === 1 ? actionVerbs[0] : null;
  const singleLeafFailures = [];

  if (topLevelAnd) singleLeafFailures.push(READINESS_CONDITIONS.TOP_LEVEL_AND);
  if (multiVerbOpener) singleLeafFailures.push(READINESS_CONDITIONS.MULTI_VERB_OPENER);
  if (bulletsAcrossModules) singleLeafFailures.push(READINESS_CONDITIONS.BULLETS_ACROSS_MODULES);

  return {
    opener,
    topLevelAnd,
    multiVerbOpener,
    bulletsAcrossModules,
    singleSubsystem,
    singleVerb,
    singleLeaf: singleLeafFailures.length === 0,
    singleLeafFailures,
  };
}

function getFirstParagraph(text) {
  return text.trim().split(/\n\s*\n/)[0] || "";
}

function getOpener(text) {
  const firstParagraph = getFirstParagraph(text);
  return firstParagraph.split(/\n/).find((line) => line.trim()) || "";
}

function extractActionVerbs(opener) {
  const normalized = opener.toLowerCase();
  const matches = normalized.match(ACTION_VERB_RE) || [];
  return [...new Set(matches.map((match) => match.toLowerCase()))];
}

function detectTopLevelAnd(opener) {
  if (!/\band\b/i.test(opener)) {
    return null;
  }
  if (SHARED_OBJECT_MULTI_VERB_RE.test(opener)) {
    return null;
  }
  const match = opener.match(CLAUSE_AND_RE);
  return match ? match[0] : null;
}

function detectBulletsAcrossModules(text) {
  const bulletLines = text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line));
  if (bulletLines.length < 3) {
    return null;
  }

  const modules = new Set();
  for (const line of bulletLines) {
    const subsystem = extractSubsystemFromText(line);
    if (subsystem) {
      modules.add(subsystem);
    }
  }

  return modules.size >= 2 ? `${bulletLines.length} bullets across ${modules.size} modules` : null;
}

function extractSubsystems(text) {
  const modules = new Set();
  const pathMatches = text.match(new RegExp(FILE_PATH_RE.source, "ig")) || [];
  for (const pathMatch of pathMatches) {
    const subsystem = subsystemFromPath(pathMatch);
    if (subsystem) {
      modules.add(subsystem);
    }
  }

  if (!modules.size) {
    const nounMatch = text.match(/\b(?:parser|router|middleware|database|cli|scorer|reviewer|dispatcher)\b/i);
    if (nounMatch) {
      modules.add(nounMatch[0].toLowerCase());
    }
  }

  return [...modules];
}

function extractSubsystemFromText(text) {
  const pathMatch = findFirst(text, FILE_PATH_RE);
  if (pathMatch) {
    return subsystemFromPath(pathMatch);
  }
  const nounMatch = text.match(/\b(?:auth|billing|parser|router|docs|cli|review|dispatch|ready|plan)\b/i);
  return nounMatch ? nounMatch[0].toLowerCase() : null;
}

function subsystemFromPath(value) {
  const clean = value.replace(/`/g, "").replace(/^\.\//, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === "skills" && parts[1]) return parts[1];
  if (parts[0] === "tests" && parts[1]) return parts[1];
  if (parts[0] === "src" && parts[1]) return parts[1];
  return parts[0];
}

function findTarget(text) {
  return findFirst(text, FILE_PATH_RE) || findFirst(text, FUNCTION_RE);
}

function findObservable(text) {
  const checks = [
    [READINESS_CONDITIONS.TEST_PATH, TEST_PATH_RE],
    [READINESS_CONDITIONS.LOG_LINE, LOG_LINE_RE],
    [READINESS_CONDITIONS.FILE_DIFF_TARGET, FILE_PATH_RE],
    [READINESS_CONDITIONS.NUMERIC_THRESHOLD, NUMERIC_THRESHOLD_RE],
  ];

  for (const [condition, regex] of checks) {
    const evidence = findFirst(text, regex);
    if (evidence) {
      return { condition, evidence };
    }
  }
  return null;
}

function findFirst(text, regex) {
  const match = text.match(regex);
  return match ? match[0] : null;
}

function pushSignal(signals, dimension, condition, evidence) {
  signals.push({
    dimension,
    condition,
    evidence: clipEvidence(evidence),
  });
}

function clipEvidence(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function determineNextAction(readiness, bypass, hasHighRisk) {
  const allHigh = readiness.clarity === "high"
    && readiness.granularity === "high"
    && readiness.verifiability === "high";
  const anyLow = readiness.clarity === "low"
    || readiness.granularity === "low"
    || readiness.verifiability === "low";

  // Deterministic switch tree from the score vector plus bypass/high-risk state.
  switch (true) {
    case bypass:
    case allHigh:
      return "proceed";
    case anyLow && hasHighRisk:
      return "escalate";
    default:
      return "qa_needed";
  }
}

module.exports = scoreReadiness;
module.exports.READINESS_CONDITIONS = READINESS_CONDITIONS;
module.exports.scoreReadiness = scoreReadiness;
module.exports.stripFencedCodeBlocks = stripFencedCodeBlocks;
