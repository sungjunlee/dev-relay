"use strict";

const { scoreReadiness } = require("./score-readiness");

const BUDGET_MAX = 3;
const QUESTION_PRIORITY = Object.freeze(["verifiability", "clarity", "granularity"]);
const ACK_RE = /^(?:y|yes|yeah|yep|ok|okay|sure|accept|accepted|default|use default|looks good)$/i;
const NO_ANSWER_RE = /^(?:|n|no|skip|pass|none|silent)$/i;
const FILE_PATH_RE = /`?((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?::\d+)?`?/i;
const TEST_PATH_RE = /`?((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:test|spec)\.[A-Za-z0-9]+)`?/i;
const FUNCTION_RE = /`?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\))`?/;
const NUMERIC_THRESHOLD_RE = /\b((?:p\d{2}|latency|duration|coverage|count|runs?|size)?\s*(?:<=|>=|<|>|=|\u2264|\u2265)\s*\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|gb|%|runs?)?)\b/i;

function runQaLoop(input = {}) {
  const normalized = normalizeInput(input);
  const answers = normalizeAnswers(input.answers);
  const events = [];
  const retryCounts = new Map();
  const reentryRequested = Boolean(input.reentry ?? input.re_entry);
  let reentryAnswered = !reentryRequested;
  let effectiveBody = normalized.body;
  let changedBody = false;
  let budgetUsed = 0;
  let score = scoreCurrent(normalized, effectiveBody, changedBody);
  let pendingAsk = null;

  for (let index = 0; index < answers.length; index += 1) {
    const rawAnswer = answers[index];
    const emitAnswerEvents = index === answers.length - 1;
    pendingAsk = pendingAsk || nextAsk({
      score,
      budgetUsed,
      reentryAnswered,
      leafId: normalized.leafId,
      body: effectiveBody,
    });

    if (!pendingAsk) {
      break;
    }

    const answer = normalizeAnswer(rawAnswer, pendingAsk.dimension);
    const classification = classifyAnswer(answer.answer, pendingAsk.default);

    if (emitAnswerEvents) {
      events.push(questionAnsweredEvent({
        ask: pendingAsk,
        answer: answer.answer,
        acceptedDefault: classification.kind === "accepted_default",
      }));
    }

    if (pendingAsk.dimension === "_reentry") {
      reentryAnswered = true;
      pendingAsk = null;
      continue;
    }

    if (classification.kind === "no_answer") {
      const retry = recordRetry(retryCounts, pendingAsk.dimension);
      if (retry.exhausted) {
        return escalateResult({
          reason: "clarification_retry_exhausted",
          score,
          budgetUsed,
          events,
          leafId: normalized.leafId,
          dimensionsLow: [pendingAsk.dimension],
        });
      }
      pendingAsk = buildClarificationAsk({
        dimension: pendingAsk.dimension,
        body: effectiveBody,
        score,
        budgetUsed,
        leafId: normalized.leafId,
        defaultValue: pendingAsk.default,
        answer: answer.answer,
        reason: "Please provide a concrete answer or accept the default.",
      });
      continue;
    }

    if (classification.kind === "accepted_default") {
      if (emitAnswerEvents) {
        events.push(proposalAcceptedEvent({
          ask: pendingAsk,
          defaultValue: pendingAsk.default,
        }));
      }
      effectiveBody = appendDimensionAnswer(effectiveBody, pendingAsk.dimension, pendingAsk.default);
      changedBody = true;
      budgetUsed += 1;
      score = scoreCurrent(normalized, effectiveBody, changedBody);
      pendingAsk = null;
      continue;
    }

    if (emitAnswerEvents) {
      events.push(proposalEditedEvent({
        ask: pendingAsk,
        override: answer.answer,
      }));
    }

    const trialBody = appendDimensionAnswer(effectiveBody, pendingAsk.dimension, answer.answer);
    const trialScore = scoreReadiness(trialBody);
    if (trialScore.readiness[pendingAsk.dimension] === "high") {
      effectiveBody = trialBody;
      changedBody = true;
      budgetUsed += 1;
      score = trialScore;
      pendingAsk = null;
      continue;
    }

    const retry = recordRetry(retryCounts, pendingAsk.dimension);
    if (retry.exhausted) {
      effectiveBody = trialBody;
      changedBody = true;
      budgetUsed += 1;
      score = trialScore;
      pendingAsk = null;
      continue;
    }
    pendingAsk = buildClarificationAsk({
      dimension: pendingAsk.dimension,
      body: effectiveBody,
      score,
      budgetUsed,
      leafId: normalized.leafId,
      defaultValue: pendingAsk.default,
      answer: answer.answer,
      reason: `Your answer "${answer.answer}" is still too vague to close ${pendingAsk.dimension}.`,
    });
  }

  const decision = decideNext({
    score,
    budgetUsed,
    reentryAnswered,
    pendingAsk,
    leafId: normalized.leafId,
    body: effectiveBody,
  });

  if (decision.action === "ask") {
    events.push(questionAskedEvent(decision));
    return {
      ...decision,
      events,
    };
  }

  return {
    ...decision,
    events,
  };
}

function normalizeInput(input) {
  const scored = input.scored || input.score || (isScoredOutput(input.body) ? input.body : null);
  const body = typeof input.body === "string" ? input.body : normalizeString(input.text || input.request_text || "");
  return {
    body,
    scored,
    leafId: normalizeOptionalString(input.leaf_id ?? input.leafId),
  };
}

function normalizeAnswers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") {
      return { dimension: null, answer: entry };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { dimension: null, answer: "" };
    }
    return {
      dimension: normalizeOptionalString(entry.dimension),
      answer: normalizeString(entry.answer ?? entry.answer_text ?? entry.text),
    };
  });
}

function normalizeAnswer(answer, fallbackDimension) {
  return {
    dimension: answer.dimension || fallbackDimension,
    answer: normalizeString(answer.answer),
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeString(value).trim();
  return normalized || null;
}

function isScoredOutput(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.readiness
      && typeof value.readiness === "object"
  );
}

function scoreCurrent(normalized, body, changedBody) {
  if (normalized.scored && !changedBody) {
    return normalizeScoredOutput(normalized.scored);
  }
  return scoreReadiness(body);
}

function normalizeScoredOutput(scored) {
  return {
    readiness: scored.readiness || {},
    bypass: Boolean(scored.bypass),
    signals: Array.isArray(scored.signals) ? scored.signals : [],
    next_action: scored.next_action || "qa_needed",
  };
}

function decideNext({ score, budgetUsed, reentryAnswered, pendingAsk, leafId, body }) {
  if (pendingAsk) {
    return pendingAsk;
  }
  if (!reentryAnswered) {
    return buildReentryAsk(leafId);
  }
  if (score.bypass || score.next_action === "proceed" || !selectQuestionDimension(score.readiness)) {
    return proceedResult(score, budgetUsed);
  }

  const dimensionsLow = lowDimensions(score.readiness);
  if (budgetUsed >= BUDGET_MAX) {
    return escalateResult({
      reason: dimensionsLow.length >= 3 ? "low_dimensions_exhausted" : "question_budget_exhausted",
      score,
      budgetUsed,
      events: [],
      leafId,
      dimensionsLow,
    });
  }

  return buildAsk({
    dimension: selectQuestionDimension(score.readiness),
    body,
    score,
    budgetUsed,
    leafId,
  });
}

function nextAsk({ score, budgetUsed, reentryAnswered, leafId, body }) {
  const decision = decideNext({
    score,
    budgetUsed,
    reentryAnswered,
    pendingAsk: null,
    leafId,
    body,
  });
  return decision.action === "ask" ? decision : null;
}

function proceedResult(score, budgetUsed) {
  return {
    action: "proceed",
    readiness_score: score.readiness,
    signals: score.signals,
    budget_used: budgetUsed,
  };
}

function escalateResult({ reason, score, budgetUsed, events, leafId, dimensionsLow }) {
  return {
    action: "escalate",
    reason,
    dimensions_low: dimensionsLow || lowDimensions(score.readiness),
    readiness_score: score.readiness,
    signals: score.signals,
    budget_used: budgetUsed,
    budget_max: BUDGET_MAX,
    leaf_id: leafId,
    events,
  };
}

function buildReentryAsk(leafId) {
  return {
    action: "ask",
    dimension: "_reentry",
    question: "Discard prior or update?",
    default: null,
    budget_used: 0,
    budget_max: BUDGET_MAX,
    leaf_id: leafId,
    readiness_score: null,
    signals: [],
  };
}

function buildAsk({ dimension, body, score, budgetUsed, leafId }) {
  return {
    action: "ask",
    dimension,
    question: questionForDimension(dimension),
    default: extractDefault(dimension, body, score.signals),
    budget_used: budgetUsed,
    budget_max: BUDGET_MAX,
    leaf_id: leafId,
    readiness_score: score.readiness,
    signals: score.signals,
  };
}

function buildClarificationAsk({
  dimension,
  body,
  score,
  budgetUsed,
  leafId,
  defaultValue,
  answer,
  reason,
}) {
  return {
    action: "ask",
    dimension,
    question: answer.trim()
      ? `${reason} Please provide a concrete answer for ${dimension}.`
      : `Please provide a concrete answer for ${dimension} or accept the default.`,
    default: defaultValue === undefined ? extractDefault(dimension, body, score.signals) : defaultValue,
    budget_used: budgetUsed,
    budget_max: BUDGET_MAX,
    leaf_id: leafId,
    readiness_score: score.readiness,
    signals: score.signals,
  };
}

function questionForDimension(dimension) {
  switch (dimension) {
    case "verifiability":
      return "What concrete check will prove this is done?";
    case "clarity":
      return "What exact target file, function, or behavior should change?";
    case "granularity":
      return "What single leaf should this request focus on?";
    default:
      return "What clarification should be applied?";
  }
}

function selectQuestionDimension(readiness = {}) {
  for (const dimension of QUESTION_PRIORITY) {
    if (readiness[dimension] === "low") {
      return dimension;
    }
  }
  return null;
}

function lowDimensions(readiness = {}) {
  return QUESTION_PRIORITY.filter((dimension) => readiness[dimension] === "low");
}

function classifyAnswer(answer, defaultValue) {
  const trimmed = answer.trim();
  if (NO_ANSWER_RE.test(trimmed)) {
    return { kind: "no_answer" };
  }
  if (defaultValue && ACK_RE.test(trimmed)) {
    return { kind: "accepted_default" };
  }
  return { kind: "override" };
}

function recordRetry(retryCounts, dimension) {
  const used = retryCounts.get(dimension) || 0;
  retryCounts.set(dimension, used + 1);
  return { exhausted: used >= 1 };
}

function appendDimensionAnswer(body, dimension, answer) {
  const normalizedBody = body.trim();
  const normalizedAnswer = answer.trim();
  const bullet = dimension === "verifiability" ? `- ${normalizedAnswer}` : normalizedAnswer;
  const section = `\n\nRelay-ready ${dimension} answer:\n${bullet}\n`;
  return normalizedBody ? `${normalizedBody}${section}` : section.trim();
}

function questionAskedEvent(ask) {
  return eventRecord("question_asked", ask.leaf_id, {
    dimension: ask.dimension,
    question: ask.question,
    default: ask.default,
    budget_used: ask.budget_used,
  });
}

function questionAnsweredEvent({ ask, answer, acceptedDefault }) {
  return eventRecord("question_answered", ask.leaf_id, {
    dimension: ask.dimension,
    question: ask.question,
    answer,
    accepted_default: acceptedDefault,
  });
}

function proposalAcceptedEvent({ ask, defaultValue }) {
  return eventRecord("proposal_accepted", ask.leaf_id, {
    dimension: ask.dimension,
    default: defaultValue,
  });
}

function proposalEditedEvent({ ask, override }) {
  return eventRecord("proposal_edited", ask.leaf_id, {
    dimension: ask.dimension,
    default: ask.default,
    override,
  });
}

function eventRecord(event, leafId, payload) {
  return {
    event,
    leaf_id: leafId,
    payload: {
      leaf_id: leafId,
      ...payload,
    },
  };
}

function emitQaEvents({ repoRoot, requestId, events, helpers } = {}) {
  const qnaHelpers = helpers || require("./relay-request");
  return (events || []).map((entry) => emitQaEvent({ repoRoot, requestId, entry, helpers: qnaHelpers }));
}

function emitQaEvent({ repoRoot, requestId, entry, helpers }) {
  const payload = entry.payload || {};
  switch (entry.event) {
    case "question_asked":
      return helpers.clarify(repoRoot, requestId, {
        ...payload,
        question_text: payload.question,
        response_options: payload.default
          ? [`Accept default: ${payload.default}`, "Provide another answer", "Skip"]
          : ["Provide answer", "Skip"],
        reason: payload.dimension,
      });
    case "question_answered":
      return helpers.answerQuestion(repoRoot, requestId, {
        ...payload,
        question_text: payload.question || `Question for ${payload.dimension}`,
        answer_text: payload.answer.trim() || "(no answer)",
        answer_choice: payload.accepted_default ? "default" : undefined,
        reason: payload.dimension,
      });
    case "proposal_accepted":
      return helpers.acceptProposal(repoRoot, requestId, {
        ...payload,
        proposal_summary: `Use default for ${payload.dimension}`,
        acceptance_note: payload.default || "Accepted default.",
        accepted_with_edits: false,
        reason: payload.dimension,
      });
    case "proposal_edited":
      return helpers.editProposal(repoRoot, requestId, {
        ...payload,
        proposal_summary: payload.default
          ? `Default for ${payload.dimension}: ${payload.default}`
          : `Answer for ${payload.dimension}`,
        edit_summary: payload.override,
        proposal_text: payload.override,
        reason: payload.dimension,
      });
    default:
      throw new Error(`unsupported Q&A event: ${entry.event}`);
  }
}

function extractDefault(dimension, body, signals = []) {
  const text = normalizeString(body);

  // Phase 1 D3 heuristic table, fail-open:
  // - verifiability: existing test/spec path, numeric threshold, or target JS path
  //   that can be mapped to a likely sibling test path.
  // - clarity: explicit file/function target already present in the request.
  // - granularity: first concrete subsystem from a file path or scorer signal.
  switch (dimension) {
    case "verifiability":
      return extractVerifiabilityDefault(text);
    case "clarity":
      return extractClarityDefault(text);
    case "granularity":
      return extractGranularityDefault(text, signals);
    default:
      return null;
  }
}

function extractVerifiabilityDefault(text) {
  const testPath = firstMatch(text, TEST_PATH_RE);
  if (testPath) {
    return `\`${testPath}\` passes.`;
  }

  const threshold = firstMatch(text, NUMERIC_THRESHOLD_RE);
  if (threshold) {
    return `The measurable threshold is ${threshold}.`;
  }

  const targetPath = firstMatch(text, FILE_PATH_RE);
  const inferredTestPath = targetPath ? inferTestPath(targetPath) : null;
  if (inferredTestPath) {
    return `\`${inferredTestPath}\` passes.`;
  }

  return null;
}

function extractClarityDefault(text) {
  const targetPath = firstMatch(text, FILE_PATH_RE);
  if (targetPath) {
    return `Change \`${targetPath}\` only, preserving behavior outside that target.`;
  }
  const functionName = firstMatch(text, FUNCTION_RE);
  if (functionName) {
    return `Change \`${functionName}\` only, preserving behavior outside that target.`;
  }
  return null;
}

function extractGranularityDefault(text, signals) {
  const targetPath = firstMatch(text, FILE_PATH_RE);
  const subsystem = targetPath ? subsystemFromPath(targetPath) : subsystemFromSignals(signals);
  if (!subsystem) {
    return null;
  }
  return `Keep one relay leaf focused on ${subsystem}.`;
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] || match[0] : null;
}

function inferTestPath(value) {
  const clean = cleanPath(value);
  const skillScript = clean.match(/^skills\/([^/]+)\/scripts\/(.+)\.js$/);
  if (skillScript) {
    return `tests/${skillScript[1]}/scripts/${skillScript[2]}.test.js`;
  }

  const srcPath = clean.match(/^src\/([^/]+)\/(.+)\.js$/);
  if (srcPath) {
    return `tests/${srcPath[1]}/${srcPath[2]}.test.js`;
  }

  if (clean.endsWith(".test.js") || clean.endsWith(".spec.js")) {
    return clean;
  }
  return null;
}

function cleanPath(value) {
  return value.replace(/`/g, "").replace(/^\.\//, "");
}

function subsystemFromPath(value) {
  const parts = cleanPath(value).split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === "skills" && parts[1]) return parts[1];
  if (parts[0] === "tests" && parts[1]) return parts[1];
  if (parts[0] === "src" && parts[1]) return parts[1];
  return parts[0];
}

function subsystemFromSignals(signals) {
  const signal = signals.find((entry) => entry.dimension === "granularity" && /single_subsystem/.test(entry.condition));
  return signal ? signal.evidence : null;
}

module.exports = runQaLoop;
module.exports.BUDGET_MAX = BUDGET_MAX;
module.exports.QUESTION_PRIORITY = QUESTION_PRIORITY;
module.exports.emitQaEvents = emitQaEvents;
module.exports.extractDefault = extractDefault;
module.exports.runQaLoop = runQaLoop;
module.exports.selectQuestionDimension = selectQuestionDimension;
