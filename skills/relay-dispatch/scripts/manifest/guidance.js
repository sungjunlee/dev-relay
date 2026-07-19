const path = require("path");

const { nowIso } = require("./paths");
const { writeTextFileWithoutFollowingSymlinks } = require("./rubric");
const { normalizeReviewAssurance } = require("./review-assurance");
const { deriveRiskAssurance } = require("./risk-assurance");

const GUIDANCE_METADATA_FILENAME = "guidance-metadata.json";
const DISPATCH_PROMPT_FILENAME = "dispatch-prompt.md";

const SCALAR_FIELDS = new Set([
  "size", "change_type", "execution_mode", "review_assurance",
  "planning_profile", "route_decision", "authority", "reversibility",
  "blast_radius",
]);
const ARRAY_FIELDS = new Set([
  "domains", "risk_tags", "guidance_packs", "derivation_inputs",
  "trust_boundaries",
]);

function stripYamlScalar(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "[]") return [];
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function parseTaskProfileYaml(blockText) {
  const lines = String(blockText || "").replace(/\r\n/g, "\n").split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === "task_profile:");
  if (startIndex === -1) return null;

  const profile = {};
  let currentArrayKey = null;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const keyValue = /^ {2}([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (keyValue) {
      const key = keyValue[1];
      const rawValue = keyValue[2] || "";
      currentArrayKey = null;
      if (ARRAY_FIELDS.has(key)) {
        profile[key] = [];
        if (rawValue.trim()) {
          const parsed = stripYamlScalar(rawValue);
          profile[key] = Array.isArray(parsed) ? uniqueStrings(parsed) : uniqueStrings([parsed]);
        } else {
          currentArrayKey = key;
        }
      } else if (SCALAR_FIELDS.has(key)) {
        profile[key] = String(stripYamlScalar(rawValue) || "").trim();
      }
      continue;
    }

    const listItem = /^ {4}-\s*(.*)$/.exec(line);
    if (listItem && currentArrayKey) {
      profile[currentArrayKey].push(String(stripYamlScalar(listItem[1]) || "").trim());
    }
  }

  for (const key of ARRAY_FIELDS) {
    if (profile[key]) profile[key] = uniqueStrings(profile[key]);
  }
  return profile;
}

function extractTaskProfileBlock(promptText) {
  const text = String(promptText || "").replace(/\r\n/g, "\n");
  const sectionMatch = /^## Task Profile\s*$/m.exec(text);
  if (!sectionMatch) return null;

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextHeadingMatch = /^##\s+/m.exec(text.slice(sectionStart));
  const sectionText = nextHeadingMatch
    ? text.slice(sectionStart, sectionStart + nextHeadingMatch.index)
    : text.slice(sectionStart);
  const fencePattern = /```(?:yaml|yml)?\s*\n([\s\S]*?)```/g;
  for (const match of sectionText.matchAll(fencePattern)) {
    if (/^task_profile:\s*$/m.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

function buildTaskProfileSummary(profile) {
  const riskDecision = deriveRiskAssurance(profile);
  const summary = {
    size: profile.size || null,
    change_type: profile.change_type || null,
    domains: uniqueStrings(profile.domains),
    risk_tags: uniqueStrings(profile.risk_tags),
    execution_mode: profile.execution_mode || null,
    ...(profile.derivation_inputs?.length
      ? { derivation_inputs: uniqueStrings(profile.derivation_inputs) }
      : {}),
  };
  if (profile.planning_profile) {
    summary.planning_profile = profile.planning_profile;
  }
  if (profile.route_decision) {
    summary.route_decision = profile.route_decision;
  }
  if (profile.review_assurance) {
    summary.review_assurance = normalizeReviewAssurance(profile.review_assurance);
  }
  if (riskDecision) {
    Object.assign(summary, {
      authority: riskDecision.authority,
      reversibility: riskDecision.reversibility,
      blast_radius: riskDecision.blast_radius,
      trust_boundaries: riskDecision.trust_boundaries,
      risk_level: riskDecision.risk_level,
      minimum_review_assurance: riskDecision.minimum_review_assurance,
      review_assurance: riskDecision.review_assurance,
      assurance_reasons: riskDecision.reasons,
      max_review_rounds: riskDecision.max_review_rounds,
      publish_policy: riskDecision.publish_policy,
      review_timing: riskDecision.review_timing,
      adversarial_review: riskDecision.adversarial_review,
    });
  }
  return summary;
}

function extractTaskProfileSummaryFromPrompt(promptText) {
  const block = extractTaskProfileBlock(promptText);
  if (!block) return null;
  const profile = parseTaskProfileYaml(block);
  if (!profile) return null;
  return buildTaskProfileSummary(profile);
}

function extractReviewAssuranceFromPrompt(promptText) {
  const block = extractTaskProfileBlock(promptText);
  if (!block) return null;
  const profile = parseTaskProfileYaml(block);
  if (!profile) return null;
  return buildTaskProfileSummary(profile).review_assurance || null;
}

function extractGuidanceFromPrompt(promptText) {
  const block = extractTaskProfileBlock(promptText);
  if (!block) return null;
  const profile = parseTaskProfileYaml(block);
  const guidancePacks = uniqueStrings(profile?.guidance_packs);
  if (guidancePacks.length === 0) return null;

  return {
    guidance_packs: guidancePacks,
    task_profile_summary: buildTaskProfileSummary(profile),
    source: "prompt",
  };
}

function readExistingGuidance(manifest) {
  const existing = manifest?.advisory?.guidance;
  const guidancePacks = uniqueStrings(existing?.guidance_packs);
  if (guidancePacks.length === 0 && !existing?.task_profile_summary) return null;
  return {
    guidance_packs: guidancePacks,
    task_profile_summary: existing.task_profile_summary || null,
    source: "manifest-preserved",
  };
}

function buildGuidanceMetadata({
  promptText,
  manifest,
  promptSource,
  rubricPath,
}) {
  const promptProfile = extractTaskProfileSummaryFromPrompt(promptText);
  const extracted = extractGuidanceFromPrompt(promptText);
  const selected = extracted || readExistingGuidance(manifest);
  if (!selected && !promptProfile) return null;

  return {
    version: 1,
    captured_at: nowIso(),
    source: promptProfile ? "prompt" : selected.source,
    prompt_source: promptSource || null,
    guidance_packs: selected?.guidance_packs || [],
    task_profile_summary: promptProfile || selected.task_profile_summary,
    dispatch_prompt_path: DISPATCH_PROMPT_FILENAME,
    rubric_path: rubricPath || null,
  };
}

function manifestGuidanceRecord(metadata) {
  return {
    guidance_packs: metadata.guidance_packs,
    task_profile_summary: metadata.task_profile_summary,
    artifact_path: GUIDANCE_METADATA_FILENAME,
    source: metadata.source,
    updated_at: metadata.captured_at,
  };
}

function persistGuidanceMetadata({ runDir, manifest, metadata }) {
  if (!metadata) return manifest;
  const artifactPath = path.join(runDir, GUIDANCE_METADATA_FILENAME);
  writeTextFileWithoutFollowingSymlinks(
    artifactPath,
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  return {
    ...manifest,
    advisory: {
      ...(manifest.advisory || {}),
      guidance: manifestGuidanceRecord(metadata),
    },
  };
}

module.exports = {
  buildGuidanceMetadata,
  DISPATCH_PROMPT_FILENAME,
  extractGuidanceFromPrompt,
  extractTaskProfileSummaryFromPrompt,
  extractReviewAssuranceFromPrompt,
  GUIDANCE_METADATA_FILENAME,
  persistGuidanceMetadata,
};
