const fs = require("fs");
const path = require("path");

const TDD_ANCHOR_LINE_REGEX = /^\s*tdd_anchor:\s*\S+/m;
const TDD_STEP_MARKER = "  0a. TDD RED ANCHOR STEP:";
const TDD_COMMIT_PREFIX = "tdd: red — ";

function hasTddAnchor(rubricYaml) {
  return extractTddFactors(rubricYaml).length > 0;
}

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

function createFactor() {
  return {
    name: null,
    tier: null,
    type: null,
    tdd_anchor: null,
    tdd_runner: null,
    fix_hint: null,
  };
}

function extractAllFactors(rubricYaml) {
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
      inFactors = !section[3];
      factorsIndent = inFactors ? section[1].length : null;
      continue;
    }

    if (!inFactors) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (section && indent <= factorsIndent) {
      pushCurrent();
      inFactors = false;
      continue;
    }

    const factorStart = line.match(/^(\s*)-\s*(?:([A-Za-z_][\w.-]*):\s*(.*?)\s*)?$/);
    if (factorStart) {
      pushCurrent();
      current = createFactor();
      currentIndent = factorStart[1].length;
      if (["name", "tier", "type", "tdd_anchor", "tdd_runner", "fix_hint"].includes(factorStart[2])) {
        current[factorStart[2]] = unquoteYamlScalar(factorStart[3]);
      }
      continue;
    }

    if (!current || indent <= currentIndent) continue;
    const field = line.match(/^\s*(name|tier|type|tdd_anchor|tdd_runner|fix_hint):\s*(.*?)\s*$/);
    if (field) {
      current[field[1]] = unquoteYamlScalar(field[2]);
    }
  }

  pushCurrent();
  return factors;
}

function extractTddFactors(rubricYaml) {
  return extractAllFactors(rubricYaml)
    .filter((factor) => factor.tdd_anchor && factor.tdd_anchor.trim() !== "")
    .map((factor) => ({
      name: factor.name,
      tdd_anchor: factor.tdd_anchor,
      tdd_runner: factor.tdd_runner,
    }));
}

function normalizeProbeSignal(probeSignal) {
  if (!probeSignal || typeof probeSignal !== "string") return null;
  try {
    return JSON.parse(probeSignal);
  } catch {
    return null;
  }
}

function firstProbeTestInfra(probeSignal) {
  const parsed = normalizeProbeSignal(probeSignal);
  const explicit = parsed?.test_infra;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const first = explicit[0];
    return typeof first === "string" ? first : first?.name || null;
  }
  const frameworks = parsed?.project_tools?.frameworks;
  if (!Array.isArray(frameworks)) return null;
  const knownTestFrameworks = new Set(["jest", "pytest", "mocha", "vitest", "node:test", "playwright", "@playwright/test"]);
  const found = frameworks.find((framework) => knownTestFrameworks.has(framework?.name));
  return found?.name || null;
}

function resolveTddFactors({ rubricYaml, probeSignal }) {
  const fallbackRunner = firstProbeTestInfra(probeSignal);
  return extractTddFactors(rubricYaml).map((factor) => {
    const runner = factor.tdd_runner || fallbackRunner;
    if (!runner) {
      throw new Error(
        `TDD factor "${factor.name || factor.tdd_anchor}" sets tdd_anchor but omits tdd_runner, ` +
        "and probe-executor-env --project-only reported zero test_infra entries."
      );
    }
    return { ...factor, tdd_runner: runner };
  });
}

function formatAnchorList(factors) {
  return factors.map((factor) => `\`${factor.tdd_anchor}\` via \`${factor.tdd_runner}\``).join(", ");
}

function buildTddStep0a(factors) {
  return [
    TDD_STEP_MARKER,
    `     Active anchors: ${formatAnchorList(factors)}.`,
    "     a) Write failing test(s) targeting every factor's `tdd_anchor`, grouped into a SINGLE commit covering all anchors.",
    `     b) The commit subject MUST start with the literal prefix \`${TDD_COMMIT_PREFIX}\` (lowercase \`tdd\`, lowercase \`red\`, em-dash U+2014 surrounded by single spaces).`,
    "     c) Run every `rubric.prerequisites[].command` with the executor's framework-native exclusion flag for every `tdd_anchor` path. Assert exit 0 on each.",
    "        If any prerequisite command does not support such a path-exclusion flag, surface a stuck signal at the start of Step 0a and STOP.",
    "        Do not modify `rubric.factors[].command`; the exclusion applies only to Step 0a prerequisite commands.",
    "     d) Run the test command resolved from `tdd_runner` on the `tdd_anchor` paths and assert NON-zero exit. Red verified.",
    "     e) Proceed to Step 0 and the rest of the loop.",
  ].join("\n");
}

function relaxStep4ForTdd(protocolText) {
  const needle = "     - For each automated check: could the target be met by a shortcut that misses the intent?";
  if (!protocolText.includes(needle)) return protocolText;
  const insertion = [
    needle,
    "       For factors carrying `tdd_anchor`, a red test commit that is green at HEAD is not a shortcut by itself; this relaxation applies only to factors carrying `tdd_anchor`; other factors in the same rubric are reviewed under the existing rule.",
  ].join("\n");
  return protocolText.replace(needle, insertion);
}

function insertTddStep0a(protocolText, tddStep) {
  if (protocolText.includes(TDD_STEP_MARKER)) return protocolText;
  const step0 = /^  0\. PREREQUISITE GATE:.*$/m;
  if (!step0.test(protocolText)) {
    return `${protocolText.replace(/\s*$/, "")}\n${tddStep}`;
  }
  return protocolText.replace(step0, `${tddStep}\n$&`);
}

function renderIterationProtocolForRubric({ iterationProtocolText, rubricYaml, probeSignal }) {
  if (!hasTddAnchor(rubricYaml)) return iterationProtocolText;
  const factors = resolveTddFactors({ rubricYaml, probeSignal });
  const withStep = insertTddStep0a(iterationProtocolText, buildTddStep0a(factors));
  return relaxStep4ForTdd(withStep);
}

function applyTddFlavorToDispatchPrompt({ dispatchPrompt, rubricYaml, probeSignal }) {
  if (!hasTddAnchor(rubricYaml)) return dispatchPrompt;
  if (dispatchPrompt.includes(TDD_STEP_MARKER)) return dispatchPrompt;
  const factors = resolveTddFactors({ rubricYaml, probeSignal });
  const tddStep = buildTddStep0a(factors);
  const step0 = /^  0\. PREREQUISITE GATE:.*$/m;
  if (step0.test(dispatchPrompt)) {
    return relaxStep4ForTdd(dispatchPrompt.replace(step0, `${tddStep}\n$&`));
  }

  const iterationProtocolPath = path.join(__dirname, "..", "references", "iteration-protocol.md");
  const renderedProtocol = renderIterationProtocolForRubric({
    iterationProtocolText: fs.readFileSync(iterationProtocolPath, "utf-8"),
    rubricYaml,
    probeSignal,
  });
  return `${dispatchPrompt.replace(/\s*$/, "")}\n\n${renderedProtocol.replace(/\s*$/, "")}`;
}

module.exports = {
  TDD_ANCHOR_LINE_REGEX,
  TDD_COMMIT_PREFIX,
  TDD_STEP_MARKER,
  applyTddFlavorToDispatchPrompt,
  buildTddStep0a,
  extractAllFactors,
  extractTddFactors,
  firstProbeTestInfra,
  hasTddAnchor,
  renderIterationProtocolForRubric,
  resolveTddFactors,
};
