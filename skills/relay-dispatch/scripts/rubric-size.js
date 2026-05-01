const fs = require("fs");

const RUBRIC_SIZE_MISSING = "__rubric_size_missing__";
const RUBRIC_SIZE_UNPARSEABLE = "__rubric_size_unparseable__";
const DEFAULT_REASONING_BY_SIZE = { S: "medium", M: "high", L: "xhigh", XL: "xhigh" };
const VALID_RUBRIC_SIZES = new Set(Object.keys(DEFAULT_REASONING_BY_SIZE));

function extractRubricSize(rubricPath) {
  if (!rubricPath || !fs.existsSync(rubricPath)) return RUBRIC_SIZE_MISSING;
  const rubricText = fs.readFileSync(rubricPath, "utf-8");
  const match = rubricText.match(/^[ \t]*(size_class|size)\s*:\s*(.*?)\s*$/m);
  if (!match) return RUBRIC_SIZE_MISSING;

  const rawValue = match[2].trim();
  const quoted = rawValue.match(/^["']([A-Za-z]+)["']$/);
  const unquoted = rawValue.match(/^([A-Za-z]+)$/);
  const size = (quoted ? quoted[1] : unquoted ? unquoted[1] : "").toUpperCase();
  return VALID_RUBRIC_SIZES.has(size) ? size : RUBRIC_SIZE_UNPARSEABLE;
}

function resolveReasoningEffort({ override, rubricPath }) {
  if (override) return override;
  const rubricSize = extractRubricSize(rubricPath);
  if (rubricSize === RUBRIC_SIZE_UNPARSEABLE) {
    process.stderr.write(`Warning: rubric size is unparseable in ${rubricPath}; falling back to xhigh reasoning.\n`);
    return "xhigh";
  }
  return DEFAULT_REASONING_BY_SIZE[rubricSize] || "xhigh";
}

module.exports = {
  extractRubricSize,
  resolveReasoningEffort,
  RUBRIC_SIZE_MISSING,
  RUBRIC_SIZE_UNPARSEABLE,
};
