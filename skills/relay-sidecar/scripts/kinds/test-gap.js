const KIND_NAME = "test-gap";

function valueOrNone(value) {
  if (value === undefined || value === null || value === "") return "none";
  return String(value);
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getBranch(manifest) {
  return manifest?.git?.working_branch || manifest?.branch || "unknown";
}

function getVerdicts(runContext) {
  return Array.isArray(runContext?.verdicts)
    ? [...runContext.verdicts].sort((left, right) => Number(left.round || 0) - Number(right.round || 0))
    : [];
}

function tokenizeCommand(command) {
  return String(command || "")
    .match(/"[^"]*"|'[^']*'|[^\s]+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, ""))
    || [];
}

function collectCommandStrings(value, output = []) {
  if (value === undefined || value === null) return output;
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      const match = line.match(/^\s*command\s*:\s*(.+?)\s*$/);
      if (match) output.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCommandStrings(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "command" && typeof item === "string") output.push(item);
      else collectCommandStrings(item, output);
    }
  }
  return output;
}

function isPathToken(token) {
  return token
    && !token.startsWith("-")
    && !["&&", "||", "|", ";"].includes(token);
}

function extractNodeTestPathsFromCommand(command) {
  const tokens = tokenizeCommand(command);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "node") continue;
    for (let testIndex = index + 1; testIndex < tokens.length; testIndex += 1) {
      const token = tokens[testIndex];
      if (token.startsWith("--test=")) {
        const value = token.slice("--test=".length);
        if (isPathToken(value)) paths.push(value);
        break;
      }
      if (token !== "--test") continue;
      for (let pathIndex = testIndex + 1; pathIndex < tokens.length; pathIndex += 1) {
        const candidate = tokens[pathIndex];
        if (!isPathToken(candidate)) break;
        paths.push(candidate);
      }
      break;
    }
  }
  return paths;
}

function getRubricTestCommands(runContext) {
  return collectCommandStrings(runContext?.rubric)
    .map((command) => ({
      command,
      paths: extractNodeTestPathsFromCommand(command),
    }))
    .filter((entry) => entry.paths.length > 0);
}

function extractDiffPaths(diffText) {
  const paths = new Set();
  for (const line of String(diffText || "").replace(/\r\n/g, "\n").split("\n")) {
    let match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      paths.add(match[2]);
      continue;
    }
    match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) paths.add(match[1]);
    match = line.match(/^rename to (.+)$/);
    if (match) paths.add(match[1]);
  }
  return [...paths].filter((candidate) => candidate !== "/dev/null");
}

function diffMentionsPath(diffText, diffPaths, filePath) {
  if (!filePath) return false;
  return diffPaths.includes(filePath) || String(diffText || "").includes(filePath);
}

function detectRequiredGaps(runContext) {
  const diffText = runContext?.diff || "";
  const diffPaths = extractDiffPaths(diffText);
  const gaps = [];
  const seen = new Set();
  for (const entry of getRubricTestCommands(runContext)) {
    for (const testPath of entry.paths) {
      if (seen.has(testPath) || diffMentionsPath(diffText, diffPaths, testPath)) continue;
      seen.add(testPath);
      gaps.push({ testPath, command: entry.command });
    }
  }
  return gaps;
}

function isSourcePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return normalized.startsWith("skills/")
    && normalized.endsWith(".js")
    && !normalized.endsWith(".test.js");
}

function pairedTestPath(sourcePath) {
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const match = normalized.match(/^skills\/([^/]+)\/(.+)\.js$/);
  if (!match) return null;
  return `tests/${match[1]}/${match[2]}.test.js`;
}

function detectOptionalHardening(runContext, requiredTestPaths) {
  const diffText = runContext?.diff || "";
  const diffPaths = extractDiffPaths(diffText);
  const suggestions = [];
  const seenSources = new Set();
  for (const sourcePath of diffPaths.filter(isSourcePath)) {
    if (seenSources.has(sourcePath)) continue;
    seenSources.add(sourcePath);
    const testPath = pairedTestPath(sourcePath);
    if (!testPath || requiredTestPaths.has(testPath)) continue;
    if (diffMentionsPath(diffText, diffPaths, testPath)) continue;
    suggestions.push({ sourcePath, testPath });
  }
  return suggestions;
}

function extractDoneCriteriaItems(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s+\[[ xX]\]\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function buildSummarySection(runContext) {
  const manifest = runContext.manifest || {};
  const lines = [
    "## Run summary",
    "",
    `- run_id: ${valueOrNone(runContext.runId || manifest.run_id)}`,
    `- branch: ${valueOrNone(getBranch(manifest))}`,
    "- kind: test-gap",
    `- current state: ${valueOrNone(manifest.state)}`,
    `- total round count: ${getVerdicts(runContext).length}`,
  ];
  if (runContext.prNumber !== undefined && runContext.prNumber !== null) {
    lines.push(`- PR number: ${runContext.prNumber}`);
  }
  return lines.join("\n");
}

function buildRequiredGapsSection(requiredGaps) {
  const lines = ["## Required gaps", ""];
  if (requiredGaps.length === 0) {
    lines.push("No required test gaps detected.");
    return lines.join("\n");
  }
  for (const gap of requiredGaps) {
    lines.push(`- Missing rubric test diff for \`${gap.testPath}\` from command \`${gap.command}\`.`);
  }
  return lines.join("\n");
}

function buildOptionalHardeningSection(suggestions) {
  const lines = ["## Optional hardening", ""];
  if (suggestions.length === 0) {
    lines.push("No optional hardening suggestions.");
    return lines.join("\n");
  }
  for (const suggestion of suggestions) {
    lines.push(`- \`${suggestion.sourcePath}\` changed without paired test diff \`${suggestion.testPath}\`.`);
  }
  return lines.join("\n");
}

function buildDoneCriteriaCoverageSection(runContext, rubricTestPaths) {
  if (runContext.doneCriteria === undefined || runContext.doneCriteria === null || runContext.doneCriteria === "") {
    return [
      "## Done Criteria coverage",
      "",
      "Done Criteria text was unavailable in this run context.",
    ].join("\n");
  }

  const items = extractDoneCriteriaItems(runContext.doneCriteria);
  const lines = [
    "## Done Criteria coverage",
    "",
    `Detected ${items.length} Done Criteria item(s) and ${rubricTestPaths.length} rubric test file reference(s).`,
  ];
  if (items.length === 0) {
    lines.push("- No parseable Done Criteria items found in the available text.");
  } else {
    for (const item of items) {
      const normalizedItem = normalizeText(item);
      const matchingTests = rubricTestPaths.filter((testPath) => {
        const basename = testPath.split("/").pop()?.replace(/\.test\.js$/, "") || "";
        return basename && normalizedItem.toLowerCase().includes(basename.toLowerCase());
      });
      lines.push(`- ${normalizedItem}: ${matchingTests.length ? `rubric test reference(s): ${matchingTests.join(", ")}` : "no direct rubric test file reference found."}`);
    }
  }
  return lines.join("\n");
}

function buildConfidenceAndLimitationsSection() {
  return [
    "## Confidence and limitations",
    "",
    "This report is advisory. It uses simple substring and path-glob heuristics over rubric commands, Done Criteria text, and diff paths; the reviewer remains the final gate for test adequacy, and absence of a gap signal does not mean coverage is complete.",
  ].join("\n");
}

function buildRecap({ runContext }) {
  const safeContext = runContext || {};
  const requiredGaps = detectRequiredGaps(safeContext);
  const requiredTestPaths = new Set(requiredGaps.map((gap) => gap.testPath));
  const optionalHardening = detectOptionalHardening(safeContext, requiredTestPaths);
  const rubricTestPaths = [...new Set(getRubricTestCommands(safeContext).flatMap((entry) => entry.paths))];
  const sections = [
    buildSummarySection(safeContext),
    buildRequiredGapsSection(requiredGaps),
    buildOptionalHardeningSection(optionalHardening),
    buildDoneCriteriaCoverageSection(safeContext, rubricTestPaths),
    buildConfidenceAndLimitationsSection(),
  ];
  return `# Test gap report: ${valueOrNone(safeContext.runId || safeContext.manifest?.run_id)}\n\n${sections.join("\n\n")}\n`;
}

function buildOpencodeAugmentationPrompt({ runContext, baselineRecap }) {
  const diffEvidence = runContext?.diff || runContext?.lastDiff || "";
  return [
    "TEST_GAP_AUGMENTATION_REQUEST",
    "",
    "You are augmenting an automatically generated relay test-gap report.",
    "Use the baseline report as the factual source. Do not contradict it, invent findings, or claim completion.",
    "",
    "Run metadata:",
    `- run_id: ${valueOrNone(runContext?.runId || runContext?.manifest?.run_id)}`,
    `- state: ${valueOrNone(runContext?.manifest?.state)}`,
    `- pr_number: ${valueOrNone(runContext?.prNumber)}`,
    "",
    "BASELINE REPORT:",
    "",
    String(baselineRecap || ""),
    "",
    "DIFF EVIDENCE:",
    "",
    diffEvidence || "No diff evidence was available in this run context.",
    "",
    "Refine the prose for clarity. Preserve uncertainty. Do not add findings beyond the rubric, Done Criteria, and diff evidence.",
  ].join("\n");
}

module.exports = {
  KIND_NAME,
  buildRecap,
  buildOpencodeAugmentationPrompt,
};
