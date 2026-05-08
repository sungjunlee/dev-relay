const KIND_NAME = "context-recap";

function valueOrNone(value) {
  if (value === undefined || value === null || value === "") return "none";
  return String(value);
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase();
}

function latestByRound(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return [...items].sort((left, right) => Number(left.round || 0) - Number(right.round || 0)).at(-1);
}

function getVerdicts(runContext) {
  return Array.isArray(runContext.verdicts)
    ? [...runContext.verdicts].sort((left, right) => Number(left.round || 0) - Number(right.round || 0))
    : [];
}

function getBranch(manifest) {
  return manifest?.git?.working_branch || manifest?.branch || "unknown";
}

function getExecutor(manifest) {
  return manifest?.roles?.executor || manifest?.roles?.worker || "unknown";
}

function getIssueTitle(issue) {
  return normalizeText(issue?.title || issue?.summary || issue?.message || "");
}

function getIssueBody(issue) {
  return normalizeText(issue?.body || "");
}

function getIssueFindingSources(issue) {
  return [getIssueTitle(issue), getIssueBody(issue)].filter(Boolean);
}

function getMissingItems(verdict) {
  return Array.isArray(verdict?.scope_drift?.missing) ? verdict.scope_drift.missing : [];
}

function buildSummarySection(runContext) {
  const manifest = runContext.manifest || {};
  const verdicts = getVerdicts(runContext);
  const lines = [
    "## Run summary",
    "",
    `- run_id: ${valueOrNone(runContext.runId || manifest.run_id)}`,
    `- current state: ${valueOrNone(manifest.state)}`,
    `- branch: ${valueOrNone(getBranch(manifest))}`,
    `- executor: ${valueOrNone(getExecutor(manifest))}`,
    `- total round count: ${verdicts.length}`,
  ];
  if (runContext.prNumber !== undefined && runContext.prNumber !== null) {
    lines.push(`- PR number: ${runContext.prNumber}`);
  }
  return lines.join("\n");
}

function buildRoundHistorySection(runContext) {
  const verdicts = getVerdicts(runContext);
  const lines = ["## Round history", ""];
  if (verdicts.length === 0) {
    lines.push("No review rounds found.");
    return lines.join("\n");
  }

  for (const verdict of verdicts) {
    lines.push(`### Round ${valueOrNone(verdict.round)}: ${valueOrNone(verdict.verdict)}`);
    const titles = Array.isArray(verdict.issues)
      ? verdict.issues.map(getIssueTitle).filter(Boolean)
      : [];
    if (titles.length === 0) {
      lines.push("- No issue titles recorded.");
    } else {
      for (const title of titles) lines.push(`- ${title}`);
    }
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function titlesMatch(left, right) {
  const normalizedLeft = normalizeComparable(left);
  const normalizedRight = normalizeComparable(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function findMatchingFindingSource(left, right) {
  for (const leftSource of left.sources) {
    for (const rightSource of right.sources) {
      if (titlesMatch(leftSource, rightSource)) return leftSource;
    }
  }
  return "";
}

function buildRepeatedFindingsSection(runContext) {
  const findings = [];
  const seenKeys = new Set();
  const issueRecords = [];
  for (const verdict of getVerdicts(runContext)) {
    for (const issue of Array.isArray(verdict.issues) ? verdict.issues : []) {
      const sources = getIssueFindingSources(issue);
      if (sources.length > 0) issueRecords.push({ round: Number(verdict.round || 0), sources });
    }
  }

  for (const issue of issueRecords) {
    let repeatedSource = "";
    const matchingRounds = new Set();
    for (const candidate of issueRecords) {
      if (candidate.round === issue.round) continue;
      const matchingSource = findMatchingFindingSource(issue, candidate);
      if (!matchingSource) continue;
      if (!repeatedSource) repeatedSource = matchingSource;
      matchingRounds.add(candidate.round);
    }
    if (matchingRounds.size === 0) continue;
    matchingRounds.add(issue.round);
    const rounds = [...matchingRounds].sort((left, right) => left - right);
    const key = normalizeComparable(repeatedSource);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    findings.push(`- ${repeatedSource} (rounds ${rounds.join(", ")})`);
  }

  return [
    "## Repeated reviewer findings",
    "",
    findings.length ? findings.join("\n") : "No repeated findings.",
  ].join("\n");
}

function buildUnresolvedRequirementsSection(runContext) {
  const latestVerdict = latestByRound(getVerdicts(runContext));
  const unresolved = getMissingItems(latestVerdict)
    .filter((item) => item?.status === "partial" || item?.status === "changed")
    .map((item) => {
      const criteria = normalizeText(item.criteria || item.title || item.requirement || "Unnamed requirement");
      return `- ${criteria} (${valueOrNone(item.status)})`;
    });

  return [
    "## Unresolved requirements",
    "",
    unresolved.length ? unresolved.join("\n") : "All Done Criteria items are verified or untouched.",
  ].join("\n");
}

function getLatestDoneCriteria(runContext) {
  const latest = latestByRound(runContext.doneCriteriaSnapshots);
  if (latest) return latest.text || "";
  return runContext.latestDoneCriteria || runContext.doneCriteria || "";
}

function getLatestDiff(runContext) {
  const latest = latestByRound(runContext.diffs);
  if (latest) return latest.text || "";
  return runContext.lastDiff || "";
}

function extractDoneCriteriaLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s+\[[ xX]\]\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function collectCriteriaMentions(verdicts) {
  const mentions = [];
  for (const verdict of verdicts) {
    for (const item of getMissingItems(verdict)) {
      const criteria = normalizeComparable(item?.criteria);
      if (criteria) mentions.push(criteria);
    }
  }
  return mentions;
}

function detectOrphanDoneCriteria(runContext) {
  const lines = extractDoneCriteriaLines(getLatestDoneCriteria(runContext));
  if (lines.length === 0) return [];
  const criteriaMentions = collectCriteriaMentions(getVerdicts(runContext));
  return lines.filter((line) => {
    const normalizedLine = normalizeComparable(line);
    return !criteriaMentions.some((criteria) => criteria.includes(normalizedLine));
  });
}

function extractDiffPaths(diffText) {
  const paths = new Set();
  for (const line of String(diffText || "").replace(/\r\n/g, "\n").split("\n")) {
    let match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      paths.add(match[1]);
      paths.add(match[2]);
      continue;
    }
    match = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);
    if (match) paths.add(match[1]);
    match = line.match(/^(?:rename from|rename to) (.+)$/);
    if (match) paths.add(match[1]);
  }
  return [...paths].filter((candidate) => candidate !== "/dev/null");
}

function isForbiddenZonePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const forbiddenSkillNames = [
    "relay-dispatch",
    "relay-ready",
    "relay-plan",
    "relay-review",
    "relay-merge",
    "relay",
  ];
  return normalized.startsWith("backlog/")
    || normalized.includes(".cache/")
    || /^docs\/issue-[^/]*\.md$/.test(normalized)
    || /^docs\/[^/]*-2026-[^/]*\.md$/.test(normalized)
    || /^docs\/[^/]*-2025-[^/]*\.md$/.test(normalized)
    || normalized.startsWith(".github/workflows/")
    || forbiddenSkillNames.some((name) => normalized.startsWith(`skills/${name}/`))
    || forbiddenSkillNames.some((name) => normalized.startsWith(`tests/${name}/`));
}

function detectForbiddenZoneTouches(runContext) {
  return extractDiffPaths(getLatestDiff(runContext)).filter(isForbiddenZonePath);
}

function buildLikelyMissesSection(runContext) {
  const misses = [];
  for (const line of detectOrphanDoneCriteria(runContext)) {
    misses.push(`- Orphan Done Criteria line not reflected in verdict drift: ${line}`);
  }
  for (const filePath of detectForbiddenZoneTouches(runContext)) {
    misses.push(`- Forbidden-zone path appears in latest diff: ${filePath}`);
  }

  return [
    "## Likely misses",
    "",
    misses.length ? misses.join("\n") : "No likely misses detected.",
  ].join("\n");
}

function buildRecap({ runContext }) {
  const safeContext = runContext || {};
  const sections = [
    buildSummarySection(safeContext),
    buildRoundHistorySection(safeContext),
    buildRepeatedFindingsSection(safeContext),
    buildUnresolvedRequirementsSection(safeContext),
    buildLikelyMissesSection(safeContext),
  ];
  return `# Recap: ${valueOrNone(safeContext.runId || safeContext.manifest?.run_id)}\n\n${sections.join("\n\n")}\n`;
}

function buildOpencodeAugmentationPrompt({ runContext, baselineRecap }) {
  return [
    "CONTEXT_RECAP_AUGMENTATION_REQUEST",
    "",
    "You are augmenting an automatically generated relay run recap.",
    "Use the baseline recap as the factual source. Do not contradict it, invent findings, or claim completion.",
    "",
    "Run metadata:",
    `- run_id: ${valueOrNone(runContext?.runId || runContext?.manifest?.run_id)}`,
    `- state: ${valueOrNone(runContext?.manifest?.state)}`,
    `- executor: ${valueOrNone(getExecutor(runContext?.manifest || {}))}`,
    "",
    "BASELINE RECAP:",
    "",
    String(baselineRecap || ""),
    "",
    "Rewrite only for concise orchestration context. Preserve uncertainty and unresolved work.",
  ].join("\n");
}

module.exports = {
  KIND_NAME,
  buildRecap,
  buildOpencodeAugmentationPrompt,
};
