const { summarizeFailure } = require("../../relay-dispatch/scripts/manifest/paths");
const {
  formatAdapterPhase,
  parseJsonObject,
  recoverExecStdout,
} = require("../../relay-dispatch/scripts/agent-adapters/transport");
const { validateReviewVerdict } = require("./review-runner/verdict");

function ensureJsonText(text, label) {
  if (label && typeof label === "object") {
    parseJsonObject(text, label);
    return;
  }
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

function parseReviewerJsonObject(text, context) {
  return parseJsonObject(text, context);
}

function findTopLevelJsonObjectSpans(text) {
  const raw = String(text);
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let malformedBoundary = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (depth > 0 && char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        malformedBoundary = true;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        spans.push({ start, end: index + 1 });
        start = -1;
      }
    }
  }

  if (depth !== 0 || inString) {
    malformedBoundary = true;
  }

  return { malformedBoundary, spans };
}

function isLikelyJsonArrayWrapper(raw, span) {
  const before = raw.slice(0, span.start).trim();
  const after = raw.slice(span.end).trim();
  return before.endsWith("[") || after.startsWith("]");
}

function parsePossiblyWrappedReviewerJsonObject(text, {
  adapter,
  phase,
  description = "review verdict",
} = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  const raw = String(text);
  const trimmed = raw.trim();
  let fullParseError = null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${context} ${description} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error.message.startsWith(`${context} `)) {
      throw error;
    }
    fullParseError = error;
  }

  const { malformedBoundary, spans } = findTopLevelJsonObjectSpans(raw);
  if (spans.length > 1) {
    throw new Error(`${context} ${description} must be valid JSON: multiple JSON objects found`);
  }
  if (spans.length === 0) {
    const reason = malformedBoundary ? "no complete JSON object found" : fullParseError.message;
    throw new Error(`${context} ${description} must be valid JSON: ${reason}`);
  }
  if (malformedBoundary || isLikelyJsonArrayWrapper(raw, spans[0])) {
    throw new Error(`${context} ${description} must be valid JSON: malformed JSON object wrapper`);
  }

  return parseJsonObject(raw.slice(spans[0].start, spans[0].end), {
    adapter,
    phase,
    description,
  });
}

function parseReviewerVerdictObject(text, context = {}) {
  const adapterPhase = formatAdapterPhase(context);
  try {
    const parsed = parsePossiblyWrappedReviewerJsonObject(text, {
      ...context,
      description: context.description || "review verdict",
    });
    return validateReviewVerdict(parsed, { requireExecutionStatus: false });
  } catch (error) {
    const message = error?.message || String(error);
    if (message.startsWith(`${adapterPhase} `)) {
      throw error;
    }
    throw new Error(`${adapterPhase} ${message}`);
  }
}

module.exports = {
  ensureJsonText,
  parsePossiblyWrappedReviewerJsonObject,
  parseReviewerJsonObject,
  parseReviewerVerdictObject,
  recoverExecStdout,
  summarizeFailure,
};
