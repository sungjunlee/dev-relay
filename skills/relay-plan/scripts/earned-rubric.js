const {
  classifyEvaluationArtifact,
} = require("../../relay-dispatch/scripts/evaluation-contract");

const ELIGIBILITY_KEYS = ["gradient", "observable", "actionable", "consequential"];
const ANCHOR_KEYS = ["weak", "adequate", "strong"];
const GENERIC_FACTOR = /^(?:code quality|quality|best practices|maintainability|clean code)$/i;

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function findLine(lines, key, start = 0, end = lines.length, parentIndent = -1) {
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
    if (match && match[2] === key && match[1].length > parentIndent) {
      return { index, indent: match[1].length, value: unquote(match[3]) };
    }
  }
  return null;
}

function blockEnd(lines, start, indent, limit = lines.length) {
  for (let index = start + 1; index < limit; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    if (lines[index].match(/^\s*/)[0].length <= indent) return index;
  }
  return limit;
}

function factorBlocks(content) {
  const lines = String(content || "").split(/\r?\n/);
  const earned = findLine(lines, "earned_rubric");
  if (!earned) return [];
  const earnedEnd = blockEnd(lines, earned.index, earned.indent);
  const factors = findLine(lines, "factors", earned.index + 1, earnedEnd, earned.indent);
  if (!factors || factors.value) return [];
  const factorsEnd = blockEnd(lines, factors.index, factors.indent, earnedEnd);
  const starts = [];
  let itemIndent = null;

  for (let index = factors.index + 1; index < factorsEnd; index += 1) {
    const item = lines[index].match(/^(\s*)-\s+/);
    if (!item) continue;
    const indent = item[1].length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) starts.push(index);
  }

  return starts.map((start, position) => ({
    lines: lines.slice(start, starts[position + 1] || factorsEnd),
    itemIndent,
  }));
}

function scalarFromBlock(block, key) {
  for (const line of block.lines) {
    const match = line.match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.*?)\\s*$`));
    if (match) return unquote(match[1]);
  }
  return "";
}

function nestedMap(block, parent, keys) {
  const parentLine = findLine(block.lines, parent, 0, block.lines.length, block.itemIndent);
  if (!parentLine) return {};
  const end = blockEnd(block.lines, parentLine.index, parentLine.indent);
  return Object.fromEntries(keys.map((key) => {
    const field = findLine(block.lines, key, parentLine.index + 1, end, parentLine.indent);
    return [key, field?.value || ""];
  }));
}

function issue(code, factor, message) {
  return { code, factor, message };
}

function validateEarnedRubricArtifact(content) {
  const classification = classifyEvaluationArtifact(content);
  if (classification.kind !== "structured") {
    return {
      valid: false,
      factor_count: 0,
      numeric_factor_count: 0,
      errors: [issue("not_structured", null, "Earned Rubric validation requires evaluation.schema_version: 2.")],
    };
  }

  const blocks = factorBlocks(content);
  const errors = [];
  let numericFactorCount = 0;

  blocks.forEach((block, index) => {
    const name = scalarFromBlock(block, "name") || `factor-${index + 1}`;
    const evidence = scalarFromBlock(block, "evidence");
    const eligibility = nestedMap(block, "eligibility", ELIGIBILITY_KEYS);
    const anchors = nestedMap(block, "anchors", ANCHOR_KEYS);
    if (!evidence || (GENERIC_FACTOR.test(name) && evidence.length < 12)) {
      errors.push(issue("ungrounded_factor", name, "Factor needs task-specific evidence."));
    }
    if (ELIGIBILITY_KEYS.some((key) => !eligibility[key])) {
      errors.push(issue("incomplete_eligibility", name, "Gradient, Observable, Actionable, and Consequential are all required."));
    }
    if (ANCHOR_KEYS.some((key) => !anchors[key])) {
      errors.push(issue("incomplete_anchors", name, "Weak, adequate, and strong qualitative anchors are all required."));
    }
    if (scalarFromBlock(block, "numeric_scale")) numericFactorCount += 1;
  });

  return {
    valid: errors.length === 0,
    factor_count: blocks.length,
    numeric_factor_count: numericFactorCount,
    errors,
  };
}

module.exports = {
  validateEarnedRubricArtifact,
};
