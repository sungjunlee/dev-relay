const STRUCTURED_SCHEMA_VERSION = 2;

function keyMatch(line) {
  return String(line || "").match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
}

function findKey(lines, key, start, end, parentIndent = -1) {
  for (let index = start; index < end; index += 1) {
    const match = keyMatch(lines[index]);
    if (!match || match[2] !== key) continue;
    const indent = match[1].length;
    if (indent > parentIndent) {
      return { index, indent, value: match[3] };
    }
  }
  return null;
}

function blockEnd(lines, start, indent, limit = lines.length) {
  for (let index = start + 1; index < limit; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    const currentIndent = lines[index].match(/^\s*/)[0].length;
    if (currentIndent <= indent) return index;
  }
  return limit;
}

function countListItems(lines, key, start, end, parentIndent) {
  const section = findKey(lines, key, start, end, parentIndent);
  if (!section) return 0;
  if (/^\[\s*\]$/.test(section.value)) return 0;
  if (section.value) return 0;

  const sectionEnd = blockEnd(lines, section.index, section.indent, end);
  let itemIndent = null;
  let count = 0;
  for (let index = section.index + 1; index < sectionEnd; index += 1) {
    const item = lines[index].match(/^(\s*)-\s+/);
    if (!item) continue;
    const indent = item[1].length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) count += 1;
  }
  return count;
}

function structuredClassification(content) {
  const lines = String(content || "").split(/\r?\n/);
  const root = findKey(lines, "evaluation", 0, lines.length);
  if (!root || root.value) return null;
  const end = blockEnd(lines, root.index, root.indent);
  const version = findKey(lines, "schema_version", root.index + 1, end, root.indent);
  const outcome = findKey(lines, "outcome_contract", root.index + 1, end, root.indent);
  const verification = findKey(lines, "verification", root.index + 1, end, root.indent);
  const earned = findKey(lines, "earned_rubric", root.index + 1, end, root.indent);
  if (!version || Number(version.value) !== STRUCTURED_SCHEMA_VERSION || !outcome || !verification || !earned) {
    return null;
  }

  const earnedEnd = blockEnd(lines, earned.index, earned.indent, end);
  return {
    kind: "structured",
    schema_version: STRUCTURED_SCHEMA_VERSION,
    has_outcome_contract: true,
    has_verification: true,
    earned_factor_count: countListItems(
      lines,
      "factors",
      earned.index + 1,
      earnedEnd,
      earned.indent
    ),
  };
}

function classifyEvaluationArtifact(content) {
  const structured = structuredClassification(content);
  if (structured) return structured;
  if (/^\s*rubric:\s*$/m.test(String(content || ""))) {
    return {
      kind: "legacy",
      schema_version: 1,
      has_outcome_contract: false,
      has_verification: false,
      earned_factor_count: null,
    };
  }
  return {
    kind: "unknown",
    schema_version: null,
    has_outcome_contract: false,
    has_verification: false,
    earned_factor_count: null,
  };
}

module.exports = {
  STRUCTURED_SCHEMA_VERSION,
  classifyEvaluationArtifact,
};
