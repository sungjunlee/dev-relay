const {
  extractTddFactors,
  firstProbeTestInfra,
} = require("./tdd-flavor");

const CONTRACT_TIER = "contract";
const AUTOMATED_TYPE = "automated";

function stripInlineComment(value) {
  const hashIndex = value.indexOf(" #");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function unquoteYamlScalar(value) {
  const trimmed = stripInlineComment(String(value || "").trim());
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

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

function parseRubricFactors(rubricYaml) {
  assertNoUnclosedInlineCollection(rubricYaml);

  const factors = [];
  let inFactors = false;
  let factorsIndent = null;
  let current = null;
  let currentIndent = null;

  function pushCurrent() {
    if (current) factors.push(current);
    current = null;
    currentIndent = null;
  }

  for (const line of String(rubricYaml || "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;

    const section = line.match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
    if (section && section[2] === "factors") {
      pushCurrent();
      if (section[3] === "[]") {
        inFactors = false;
        factorsIndent = null;
        continue;
      }
      inFactors = true;
      factorsIndent = section[1].length;
      if (section[3]) {
        throw new Error("Invalid rubric YAML: factors must be a block sequence");
      }
      continue;
    }

    if (!inFactors) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (section && indent <= factorsIndent) {
      pushCurrent();
      inFactors = false;
      continue;
    }

    const factorStart = line.match(/^(\s*)-\s+name:\s*(.+?)\s*$/);
    if (factorStart) {
      pushCurrent();
      current = {
        name: unquoteYamlScalar(factorStart[2]),
        tier: null,
        type: null,
        tdd_anchor: null,
      };
      currentIndent = factorStart[1].length;
      continue;
    }

    if (!current || indent <= currentIndent) continue;
    const field = line.match(/^\s*(tier|type|tdd_anchor):\s*(.*?)\s*$/);
    if (field) {
      current[field[1]] = unquoteYamlScalar(field[2]);
    }
  }

  pushCurrent();
  return factors;
}

function isAutomatedContractFactor(factor) {
  return factor.tier === CONTRACT_TIER && factor.type === AUTOMATED_TYPE;
}

function hasNonEmptyTddAnchor(factor) {
  return Boolean(factor.tdd_anchor && factor.tdd_anchor.trim() !== "");
}

function evaluateTddSuggestion({ rubricYaml, probeSignal }) {
  const factors = parseRubricFactors(rubricYaml);
  const tddFactors = extractTddFactors(rubricYaml);
  const runner = firstProbeTestInfra(probeSignal);

  if (!runner) {
    return { suggest: false, reason: "no_test_infra" };
  }

  const automatedContractFactors = factors.filter(isAutomatedContractFactor);
  if (automatedContractFactors.length === 0) {
    return { suggest: false, reason: "no_automated_contract_factor" };
  }

  if (tddFactors.length > 0) {
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
