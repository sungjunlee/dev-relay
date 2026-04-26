const {
  extractAllFactors,
  firstProbeTestInfra,
} = require("./tdd-flavor");

const CONTRACT_TIER = "contract";
const AUTOMATED_TYPE = "automated";

function assertNoUnclosedInlineCollection(rubricYaml) {
  const stack = [];
  let quote = null;
  let escaped = false;
  for (const char of String(rubricYaml || "")) {
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === "\"" && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === "]" || char === "}") {
      const open = stack.pop();
      if ((char === "]" && open !== "[") || (char === "}" && open !== "{")) {
        throw new Error("Invalid rubric YAML: unmatched inline collection delimiter");
      }
    }
  }
  if (quote || stack.length > 0) {
    throw new Error("Invalid rubric YAML: unterminated scalar or inline collection");
  }
}

function stripInlineComment(value) {
  const hashIndex = value.indexOf(" #");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function isQuotedScalar(value) {
  const trimmed = stripInlineComment(String(value || "").trim());
  return (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
}

function assertValidRequiredFieldScalar(fieldName, value) {
  const trimmed = stripInlineComment(value).trim();
  if (!trimmed) {
    throw new Error(`Invalid rubric YAML: ${fieldName} must be a scalar value`);
  }
  if (!isQuotedScalar(trimmed) && trimmed.includes(":")) {
    throw new Error(`Invalid rubric YAML: malformed ${fieldName} scalar`);
  }
}

function assertRubricYamlStructurallyValid(rubricYaml) {
  if (rubricYaml == null || String(rubricYaml).trim() === "") {
    throw new Error("Invalid rubric YAML: input is empty");
  }

  assertNoUnclosedInlineCollection(rubricYaml);

  if (!String(rubricYaml).split(/\r?\n/).some((line) => /^rubric:\s*(?:#.*)?$/.test(line))) {
    throw new Error("Invalid rubric YAML: missing top-level rubric key");
  }

  let inFactors = false;
  let factorsIndent = null;
  let factorsKeySeen = false;
  let factorsSequenceSeen = false;

  for (const line of String(rubricYaml || "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;

    const section = line.match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
    if (section && section[2] === "factors") {
      factorsKeySeen = true;
      factorsSequenceSeen = section[3] === "[]";
      if (section[3] && section[3] !== "[]") {
        throw new Error("Invalid rubric YAML: factors must be a sequence");
      }
      if (section[3] === "[]") {
        inFactors = false;
        factorsIndent = null;
        continue;
      }
      inFactors = true;
      factorsIndent = section[1].length;
      continue;
    }

    if (!inFactors) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (section && indent <= factorsIndent) {
      inFactors = false;
      continue;
    }

    const factorItem = line.match(/^\s*-\s*(?:([A-Za-z_][\w.-]*):\s*(.*))?$/);
    if (factorItem) {
      factorsSequenceSeen = true;
      if (factorItem[1] === "tier" || factorItem[1] === "type") {
        assertValidRequiredFieldScalar(factorItem[1], factorItem[2]);
      }
      continue;
    }

    const requiredField = line.match(/^\s*(tier|type):\s*(.*?)\s*$/);
    if (requiredField) {
      assertValidRequiredFieldScalar(requiredField[1], requiredField[2]);
    }
  }

  if (!factorsKeySeen) {
    throw new Error("Invalid rubric YAML: missing factors key");
  }
  if (!factorsSequenceSeen) {
    throw new Error("Invalid rubric YAML: factors must be a sequence");
  }
}

function isAutomatedContractFactor(factor) {
  return factor.tier === CONTRACT_TIER && factor.type === AUTOMATED_TYPE;
}

function hasNonEmptyTddAnchor(factor) {
  return Boolean(factor.tdd_anchor && factor.tdd_anchor.trim() !== "");
}

function evaluateTddSuggestion({ rubricYaml, probeSignal }) {
  assertRubricYamlStructurallyValid(rubricYaml);

  const factors = extractAllFactors(rubricYaml);
  const runner = firstProbeTestInfra(probeSignal);

  if (!runner) {
    return { suggest: false, reason: "no_test_infra" };
  }

  const automatedContractFactors = factors.filter(isAutomatedContractFactor);
  if (automatedContractFactors.length === 0) {
    return { suggest: false, reason: "no_automated_contract_factor" };
  }

  if (factors.some(hasNonEmptyTddAnchor)) {
    return { suggest: false, reason: "tdd_already_opted_in" };
  }

  return {
    suggest: true,
    runner,
    candidates: automatedContractFactors
      .filter((factor) => !hasNonEmptyTddAnchor(factor))
      .map((factor) => factor.name),
  };
}

module.exports = {
  evaluateTddSuggestion,
};
