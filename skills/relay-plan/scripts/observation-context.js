const {
  classifyEvaluationArtifact,
} = require("../../relay-dispatch/scripts/evaluation-contract");

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

function keyMatch(line) {
  return String(line || "").match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
}

function findKey(lines, key, start = 0, end = lines.length, parentIndent = -1) {
  for (let index = start; index < end; index += 1) {
    const match = keyMatch(lines[index]);
    if (match && match[2] === key && match[1].length > parentIndent) {
      return {
        index,
        indent: match[1].length,
        value: unquote(match[3]),
      };
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

function listItemBlocks(lines, section, limit) {
  if (!section || section.value) return [];
  const end = blockEnd(lines, section.index, section.indent, limit);
  const starts = [];
  let itemIndent = null;
  for (let index = section.index + 1; index < end; index += 1) {
    const item = lines[index].match(/^(\s*)-\s+/);
    if (!item) continue;
    const indent = item[1].length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) starts.push(index);
  }
  return starts.map((start, position) => ({
    start,
    end: starts[position + 1] || end,
    indent: itemIndent,
  }));
}

function scalar(lines, key, start, end, parentIndent) {
  const direct = findKey(lines, key, start, end, parentIndent);
  if (direct) return direct.value;
  const itemPattern = new RegExp(`^\\s*-\\s*${key}:\\s*(.*?)\\s*$`);
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(itemPattern);
    if (match) return unquote(match[1]);
  }
  return "";
}

function issue(code, message) {
  return { code, message };
}

function validateObservationContext(content) {
  const classification = classifyEvaluationArtifact(content);
  if (classification.kind !== "structured") {
    return {
      valid: false,
      factor_count: 0,
      lens_count: 0,
      errors: [issue("not_structured", "Observation validation requires evaluation.schema_version: 2.")],
    };
  }

  const lines = String(content || "").split(/\r?\n/);
  const root = findKey(lines, "evaluation");
  const rootEnd = blockEnd(lines, root.index, root.indent);
  const observation = findKey(lines, "observation", root.index + 1, rootEnd, root.indent);
  const errors = [];

  if (!observation) {
    if (classification.earned_factor_count > 0) {
      errors.push(issue(
        "missing_observation_context",
        "Earned quality claims require observation of the artifact, intended user, usage context, and available surfaces."
      ));
    }
    return {
      valid: errors.length === 0,
      factor_count: classification.earned_factor_count,
      lens_count: 0,
      errors,
    };
  }

  const observationEnd = blockEnd(lines, observation.index, observation.indent, rootEnd);
  const requiredScalars = ["artifact", "intended_user", "usage_context"];
  if (requiredScalars.some((key) => !scalar(
    lines,
    key,
    observation.index + 1,
    observationEnd,
    observation.indent
  ))) {
    errors.push(issue(
      "incomplete_observation_context",
      "Observation requires artifact, intended_user, and usage_context."
    ));
  }

  const surfaces = findKey(
    lines,
    "surfaces",
    observation.index + 1,
    observationEnd,
    observation.indent
  );
  const surfaceBlocks = listItemBlocks(lines, surfaces, observationEnd);
  if (surfaceBlocks.length === 0) {
    errors.push(issue("missing_observation_surface", "Observation requires at least one available surface."));
  }

  const inquiry = findKey(
    lines,
    "inquiry",
    observation.index + 1,
    observationEnd,
    observation.indent
  );
  const inquiryEnd = inquiry
    ? blockEnd(lines, inquiry.index, inquiry.indent, observationEnd)
    : observationEnd;
  const failure = inquiry && scalar(
    lines,
    "contract_satisfying_failure",
    inquiry.index + 1,
    inquiryEnd,
    inquiry.indent
  );
  const expert = inquiry && scalar(
    lines,
    "expert_notice",
    inquiry.index + 1,
    inquiryEnd,
    inquiry.indent
  );
  if (!failure || !expert) {
    errors.push(issue(
      "incomplete_observation_inquiry",
      "Observation must ask how a contract-satisfying result could fail and what a domain expert would notice."
    ));
  }

  const lenses = findKey(
    lines,
    "lenses",
    observation.index + 1,
    observationEnd,
    observation.indent
  );
  const lensBlocks = listItemBlocks(lines, lenses, observationEnd);
  const lensNames = lensBlocks.map((block) => scalar(
    lines,
    "name",
    block.start,
    block.end,
    block.indent - 1
  ).toLowerCase());

  if (lensNames.includes("design")) {
    const observationText = lines.slice(observation.index, observationEnd).join("\n");
    const hasRendered = /^\s*-\s+kind:\s*rendered_output\s*$/m.test(observationText);
    const hasFlows = /^\s*user_flows:\s*\n\s+-\s+\S/m.test(observationText);
    const hasViewports = /^\s*viewports:\s*\n\s+-\s+\S/m.test(observationText);
    if (!hasRendered || !hasFlows || !hasViewports) {
      errors.push(issue(
        "design_observation_incomplete",
        "A design lens requires rendered output plus relevant user flows and viewports."
      ));
    }
  }

  return {
    valid: errors.length === 0,
    factor_count: classification.earned_factor_count,
    lens_count: lensBlocks.length,
    errors,
  };
}

module.exports = {
  validateObservationContext,
};
