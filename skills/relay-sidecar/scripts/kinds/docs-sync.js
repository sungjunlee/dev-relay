const KIND_NAME = "docs-sync";
const requiresDocCandidates = true;

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

function getDiffText(runContext) {
  return runContext?.diff || runContext?.lastDiff || "";
}

function isDocCandidatePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return (/^README.*\.md$/i.test(normalized) && !normalized.includes("/"))
    || (/^CHANGELOG.*\.md$/i.test(normalized) && !normalized.includes("/"))
    || (/^ARCHITECTURE.*\.md$/i.test(normalized) && !normalized.includes("/"))
    || (
      normalized.startsWith("docs/")
      && normalized.endsWith(".md")
      && !/^docs\/issue-[^/]*\.md$/i.test(normalized)
      && !/^docs\/[^/]*-(?:2025|2026)-[^/]*\.md$/i.test(normalized)
    )
    || /^skills\/[^/]+\/SKILL\.md$/i.test(normalized);
}

function isSourcePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized || normalized === "/dev/null") return false;
  if (isDocCandidatePath(normalized)) return false;
  return !/(^|\/)(?:test|tests)\/|\.test\.[cm]?js$|\.test\.js$/i.test(normalized);
}

function extractChangedSourcePaths(diffText) {
  const paths = new Set();
  for (const line of String(diffText || "").replace(/\r\n/g, "\n").split("\n")) {
    let match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      if (isSourcePath(match[1])) paths.add(match[1]);
      if (isSourcePath(match[2])) paths.add(match[2]);
      continue;
    }
    match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match && isSourcePath(match[1])) paths.add(match[1]);
    match = line.match(/^--- a\/(.+)$/);
    if (match && isSourcePath(match[1])) paths.add(match[1]);
    match = line.match(/^(?:rename from|rename to) (.+)$/);
    if (match && isSourcePath(match[1])) paths.add(match[1]);
  }
  return [...paths];
}

function basename(filePath) {
  return String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "";
}

function findMatchedPathReferences(changedPaths, docText) {
  const text = String(docText || "");
  const matched = new Set();
  for (const changedPath of changedPaths) {
    if (text.includes(changedPath)) {
      matched.add(changedPath);
      continue;
    }
    const base = basename(changedPath);
    if (base && base !== changedPath && text.includes(base)) {
      matched.add(base);
    }
  }
  return [...matched];
}

function extractChangedSymbols(diffText) {
  const symbols = new Set();
  const symbolPattern = /^[+-]\s*(?:export\s+)?(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/;
  for (const line of String(diffText || "").replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const match = line.match(symbolPattern);
    if (match) symbols.add(match[1]);
  }
  return [...symbols];
}

function getDocCandidates(runContext) {
  const candidates = runContext?.docCandidates;
  if (!candidates || typeof candidates !== "object" || Array.isArray(candidates)) return {};
  return candidates;
}

function detectStaleDocs(runContext) {
  const diffText = getDiffText(runContext);
  const changedPaths = extractChangedSourcePaths(diffText);
  const changedSymbols = extractChangedSymbols(diffText);
  const staleDocs = [];

  for (const [docPath, docText] of Object.entries(getDocCandidates(runContext)).sort(([left], [right]) => left.localeCompare(right))) {
    const text = String(docText || "");
    const matchedPaths = findMatchedPathReferences(changedPaths, text);
    const matchedSymbols = changedSymbols.filter((symbol) => text.includes(symbol));
    if (matchedPaths.length === 0 && matchedSymbols.length === 0) continue;
    staleDocs.push({ docPath, matchedPaths, matchedSymbols });
  }

  return { changedPaths, changedSymbols, staleDocs };
}

function buildSummarySection(runContext) {
  const manifest = runContext.manifest || {};
  const lines = [
    "## Run summary",
    "",
    `- run_id: ${valueOrNone(runContext.runId || manifest.run_id)}`,
    `- branch: ${valueOrNone(getBranch(manifest))}`,
    "- kind: docs-sync",
    `- current state: ${valueOrNone(manifest.state)}`,
    `- total round count: ${getVerdicts(runContext).length}`,
  ];
  if (runContext.prNumber !== undefined && runContext.prNumber !== null) {
    lines.push(`- PR number: ${runContext.prNumber}`);
  }
  return lines.join("\n");
}

function buildLikelyStaleDocsSection(staleDocs) {
  const lines = ["## Likely stale docs", ""];
  if (staleDocs.length === 0) {
    lines.push("No likely stale docs detected.");
    return lines.join("\n");
  }
  for (const staleDoc of staleDocs) {
    const matches = [
      ...staleDoc.matchedPaths.map((item) => `path \`${item}\``),
      ...staleDoc.matchedSymbols.map((item) => `symbol \`${item}\``),
    ];
    lines.push(`- \`${staleDoc.docPath}\` references changed ${matches.join(", ")}.`);
  }
  return lines.join("\n");
}

function buildRecommendedUpdatesSection(staleDocs) {
  const lines = ["## Recommended updates", ""];
  if (staleDocs.length === 0) {
    lines.push("No update recommendations available.");
    return lines.join("\n");
  }
  for (const staleDoc of staleDocs) {
    const changedItems = [
      ...staleDoc.matchedPaths.map((item) => `\`${item}\``),
      ...staleDoc.matchedSymbols.map((item) => `\`${item}\``),
    ].join(", ");
    lines.push(`- \`${staleDoc.docPath}\`: Review references to ${changedItems} and update the surrounding explanation if behavior, location, or API naming changed.`);
  }
  return lines.join("\n");
}

function parseMarkdownSections(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [{ headingPath: "(document body)", bodyLines: [] }];
  const stack = [];
  let current = sections[0];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = normalizeText(headingMatch[2]);
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      stack.push({ level, title });
      current = { headingPath: stack.map((item) => item.title).join(" > "), bodyLines: [] };
      sections.push(current);
      continue;
    }
    current.bodyLines.push(line);
  }

  return sections.map((section) => ({
    headingPath: section.headingPath,
    body: section.bodyLines.join("\n"),
  }));
}

function buildPatchHintRecords(runContext, staleDocs) {
  const docCandidates = getDocCandidates(runContext);
  const records = [];
  for (const staleDoc of staleDocs) {
    if (staleDoc.matchedSymbols.length === 0) continue;
    for (const section of parseMarkdownSections(docCandidates[staleDoc.docPath])) {
      const matchedSymbols = staleDoc.matchedSymbols.filter((symbol) => section.body.includes(symbol));
      if (matchedSymbols.length === 0) continue;
      records.push({
        docPath: staleDoc.docPath,
        headingPath: section.headingPath,
        matchedSymbols,
      });
    }
  }
  return records;
}

function buildOptionalPatchHintsSection(runContext, staleDocs) {
  const records = buildPatchHintRecords(runContext, staleDocs);
  const lines = ["## Optional patch hints", ""];
  if (records.length === 0) {
    lines.push("No patch hints available.");
    return lines.join("\n");
  }
  for (const record of records) {
    lines.push("```text");
    lines.push(`doc: ${record.docPath}`);
    lines.push(`heading path: ${record.headingPath}`);
    lines.push(`matched symbols: ${record.matchedSymbols.join(", ")}`);
    lines.push("```");
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function buildConfidenceAndLimitationsSection() {
  return [
    "## Confidence and limitations",
    "",
    "This report is advisory. It uses simple heuristics over diff paths, exported-symbol substrings, and bounded documentation globs; the reviewer is the final gate for documentation decisions. Absence of a stale-doc signal does not prove documentation is current, and this sidecar does not apply patches.",
  ].join("\n");
}

function buildRecap({ runContext }) {
  const safeContext = runContext || {};
  const { staleDocs } = detectStaleDocs(safeContext);
  const sections = [
    buildSummarySection(safeContext),
    buildLikelyStaleDocsSection(staleDocs),
    buildRecommendedUpdatesSection(staleDocs),
    buildOptionalPatchHintsSection(safeContext, staleDocs),
    buildConfidenceAndLimitationsSection(),
  ];
  return `# Docs sync report: ${valueOrNone(safeContext.runId || safeContext.manifest?.run_id)}\n\n${sections.join("\n\n")}\n`;
}

function buildOpencodeAugmentationPrompt({ runContext, baselineRecap }) {
  const diffEvidence = getDiffText(runContext);
  return [
    "DOCS_SYNC_AUGMENTATION_REQUEST",
    "DOCS_SYNC_BASELINE_UNIQUE_SUBSTRING",
    "",
    "You are augmenting an automatically generated relay docs-sync report.",
    "Use the baseline report as the factual source. Do not contradict it, invent findings, claim completion, or apply patches.",
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
    "Refine the prose for clarity. Preserve uncertainty and keep the output advisory.",
  ].join("\n");
}

module.exports = {
  KIND_NAME,
  requiresDocCandidates,
  buildRecap,
  buildOpencodeAugmentationPrompt,
};
