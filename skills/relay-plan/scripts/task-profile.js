const fs = require("fs");
const path = require("path");
const { normalizeReviewAssurance } = require("../../relay-dispatch/scripts/manifest/review-assurance");

const CHANGE_TYPES = new Set(["bugfix", "feature", "refactor", "docs", "test", "infra", "visual", "prompt"]);
const EXECUTION_MODES = new Set(["quick", "standard", "fresh-context", "batch-wave"]);
const SIZES = new Set(["S", "M", "L", "XL"]);
const TRUST_BOUNDARY_PATTERN = /\b(?:trust[- ]boundary|auth[- ]boundary|trust root|forge|forged|bypass|fail closed|gate-check|validate[- ]?(?:manifest|transition)|state transition|state-machine)\b/;
const STATE_MACHINE_PATTERN = /\b(?:state transition|state-machine|validate[- ]?transition|manifest state)\b/;
const PRODUCT_FLOW_PATTERN = /\b(?:user|customer|product)[ -]?(?:journey|flow)s?\b|\b(?:onboarding|checkout|sign[- ]?up|login|purchase|activation|booking|subscription|settings|profile|search|invite|upload)[ -]?flows?\b|\b(?:screen-by-screen|end-to-end|e2e)\s+(?:product|user|customer)?\s*(?:flow|journey)s?\b/;
const PRODUCT_SURFACE_PATTERN = /\b(?:user|customer|ui|ux|screen|page|view|modal|form|button|visible|browser|frontend|component|harness)\b/;
const PRODUCT_FLOW_SIGNAL_PATTERN = /\b(?:file input|file upload|upload input|user input|form input|input provider|provider alignment|harness provider|ui provider|real provider|demo provider|synthetic provider|empty state|loading state|error state|success state|final state|visible state|preview state|demo data|synthetic data|demo risk|synthetic risk)\b|\b(?:visible|preview|screen|ui|ux|browser|form|page|view|modal|empty|loading|error|success|final)\s+state transition\b|\bstate transition\s+(?:on|in|through|between|for)\s+(?:the\s+)?(?:screen|ui|browser|page|view|modal|form|empty|loading|error|success|final|preview)\b|\b(?:export|delete|retry)\s+(?:button|action|path|case|state|flow|screen|view|result|file|data|report|download|failure|error)\b|\b(?:button|action|path|case|state|flow|screen|view)\s+(?:to\s+)?(?:export|delete|retry)\b/;
const GUIDANCE_PACK_REFERENCE_PATH = path.join(__dirname, "..", "references", "guidance-packs.md");
const WORKING_GUIDANCE_HEADING = "## Working Guidance";
const WORKING_GUIDANCE_BOUNDARY = "These instructions guide execution style. They do not override Done Criteria, rubric commands, or scope boundaries.";

function parseJsonish(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function stringifySignal(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeText(...parts) {
  return parts.map(stringifySignal).join("\n").toLowerCase();
}

function normalizeSize(size) {
  const normalized = String(size || "M").toUpperCase();
  return SIZES.has(normalized) ? normalized : "M";
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function addMany(values, candidates) {
  for (const candidate of candidates || []) addUnique(values, candidate);
}

function asStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function inferChangeType(text) {
  if (/\b(readme|docs?|documentation|operator guide|reference doc|\.md)\b/.test(text)) return "docs";
  if (/\b(refactor|decompose|split|cleanup|simplify|no behavior change|without behavior changes)\b/.test(text)) return "refactor";
  if (/\b(prompt|rubric|skill\.md|dispatch prompt|reviewer prompt|done criteria)\b/.test(text)) return "prompt";
  if (/\b(test|fixture|coverage|regression)\b/.test(text) && !/\b(add|implement|feature|script|api)\b/.test(text)) return "test";
  if (/\b(ci|workflow|github actions|build|deploy|infra|configuration)\b/.test(text)) return "infra";
  if (/\b(ui|ux|visual|css|layout|screen|component)\b/.test(text)) return "visual";
  if (/\b(fix|bug|regression|broken|failure|fail(ing|s)?|error)\b/.test(text)) return "bugfix";
  return "feature";
}

function inferDomains(text, probe) {
  const domains = [];
  if (/\brelay-plan\b|skills\/relay-plan|tests\/relay-plan/.test(text)) addUnique(domains, "relay-plan");
  if (/\brelay-dispatch\b|skills\/relay-dispatch|manifest|worktree|dispatch\.js/.test(text)) addUnique(domains, "relay-dispatch");
  if (/\brelay-review\b|skills\/relay-review|reviewer|verdict|review schema/.test(text)) addUnique(domains, "relay-review");
  if (/\brelay-merge\b|skills\/relay-merge|merge gate|finalize/.test(text)) addUnique(domains, "relay-merge");
  if (/\bdocs?\b|documentation|readme|\.md\b/.test(text)) addUnique(domains, "docs");
  if (/\bprompt|rubric|skill\.md|working guidance|done criteria/.test(text)) addUnique(domains, "prompt");
  if (/\btests?\b|fixtures?|node --test|regression/.test(text)) addUnique(domains, "tests");
  if (/\bcli|command|flag|argv|stdio/.test(text)) addUnique(domains, "cli");
  if (Array.isArray(probe?.project_tools?.ci) && probe.project_tools.ci.length > 0) addUnique(domains, "ci");
  if (domains.length === 0) addUnique(domains, "code");
  return domains;
}

function inferRiskTags(text, taskRisk) {
  const tags = [];
  addMany(tags, asStringArray(taskRisk?.risk_tags));
  addMany(tags, asStringArray(taskRisk?.riskTags));
  if (TRUST_BOUNDARY_PATTERN.test(text)) {
    addUnique(tags, "trust-boundary");
  }
  if (STATE_MACHINE_PATTERN.test(text)) addUnique(tags, "state-machine");
  if (/\bpublic api|exported|schema|contract|cli flag|command line|user-facing\b/.test(text)) addUnique(tags, "public-api");
  if (/\bbackward|compat|byte-identical|unchanged|stable|existing behavior\b/.test(text)) addUnique(tags, "backward-compatibility");
  if (/\bprompt|rubric|skill\.md|dispatch prompt|reviewer prompt|done criteria|content boundary\b/.test(text)) addUnique(tags, "prompt-contract");
  if (/\bmigration|data loss|destructive|delete|cleanup worktree\b/.test(text)) addUnique(tags, "migration");
  return tags;
}

function historicalQualityNeedsTightening(historical) {
  const tiers = historical?.rubric_insights?.tier_effectiveness || {};
  const contractRounds = Number(tiers.contract?.avg_rounds_to_met);
  const qualityRounds = Number(tiers.quality?.avg_rounds_to_met);
  if (!Number.isFinite(contractRounds) || !Number.isFinite(qualityRounds)) return false;
  return qualityRounds > contractRounds;
}

function inferExecutionMode({ size, risk_tags, text }) {
  if (risk_tags.includes("trust-boundary")) return "fresh-context";
  if (/\bbatch|wave|parallel dispatch|multiple independent\b/.test(text)) return "batch-wave";
  if (size === "S" && risk_tags.length === 0) return "quick";
  return "standard";
}

function inferReviewAssurance({ risk_tags, text, taskRisk }) {
  const explicit = taskRisk?.review_assurance || taskRisk?.reviewAssurance;
  if (explicit) return normalizeReviewAssurance(explicit);
  const hardenedRiskTags = new Set([
    "trust-boundary",
    "state-machine",
    "public-api",
    "backward-compatibility",
    "prompt-contract",
    "migration",
  ]);
  if (risk_tags.some((tag) => hardenedRiskTags.has(tag))) return "hardened";
  if (/\b(?:merge gate|review gate|manifest anchor|recovery path|data loss|force-finalize|execution evidence)\b/.test(text)) {
    return "hardened";
  }
  return "standard";
}

function selectGuidancePacks({ change_type, risk_tags, size, historical }) {
  const packs = [];
  if (change_type === "docs") {
    addUnique(packs, "docs-reader-success");
  } else {
    addUnique(packs, "surgical-change");
    addUnique(packs, "verification-evidence");
  }
  if (change_type !== "docs" && (change_type === "refactor" || (["M", "L", "XL"].includes(size) && historicalQualityNeedsTightening(historical)))) {
    addUnique(packs, "simplify-pass");
  }
  if (risk_tags.includes("trust-boundary")) addUnique(packs, "trust-boundary");
  return packs;
}

function hasProductFlowSignal({ change_type, text }) {
  if (change_type === "docs") return false;
  if (PRODUCT_FLOW_PATTERN.test(text)) return true;
  return PRODUCT_SURFACE_PATTERN.test(text) && PRODUCT_FLOW_SIGNAL_PATTERN.test(text);
}

function normalizeTaskProfile(profile) {
  const change_type = CHANGE_TYPES.has(profile?.change_type) ? profile.change_type : "feature";
  const execution_mode = EXECUTION_MODES.has(profile?.execution_mode) ? profile.execution_mode : "standard";
  const review_assurance = normalizeReviewAssurance(profile?.review_assurance);
  const route_decision = profile?.route_decision || profile?.routeDecision || profile?.planning_profile || null;
  return {
    size: normalizeSize(profile?.size),
    ...(route_decision ? { route_decision: String(route_decision) } : {}),
    change_type,
    domains: asStringArray(profile?.domains),
    risk_tags: asStringArray(profile?.risk_tags),
    execution_mode,
    review_assurance,
    guidance_packs: asStringArray(profile?.guidance_packs),
    derivation_inputs: asStringArray(profile?.derivation_inputs),
  };
}

function deriveTaskProfile({
  doneCriteria = "",
  probeSignal = "",
  historicalSignal = "",
  taskRisk = {},
  size,
} = {}) {
  const probe = parseJsonish(probeSignal);
  const historical = parseJsonish(historicalSignal);
  const risk = parseJsonish(taskRisk);
  const routeDecision = risk.route_decision || risk.routeDecision;
  const normalizedSize = normalizeSize(size || (routeDecision === "ready_light" ? "S" : "M"));
  const intentText = normalizeText(doneCriteria, taskRisk);
  const signalText = normalizeText(doneCriteria, probeSignal, historicalSignal, taskRisk);
  const change_type = inferChangeType(intentText);
  const domains = inferDomains(signalText, probe);
  const risk_tags = inferRiskTags(intentText, risk);
  const execution_mode = inferExecutionMode({ size: normalizedSize, risk_tags, text: signalText });
  const review_assurance = inferReviewAssurance({ risk_tags, text: signalText, taskRisk: risk });
  const guidance_packs = selectGuidancePacks({
    change_type,
    risk_tags,
    size: normalizedSize,
    historical,
  });
  if (hasProductFlowSignal({ change_type, text: signalText })) {
    addUnique(guidance_packs, "user-replay-evidence");
  }

  return {
    size: normalizedSize,
    ...(routeDecision ? { route_decision: String(routeDecision) } : {}),
    change_type,
    domains,
    risk_tags,
    execution_mode,
    review_assurance,
    guidance_packs,
    derivation_inputs: ["done_criteria", "probe_signal", "historical_signal", "task_risk"],
  };
}

function yamlScalar(value) {
  const scalar = String(value);
  if (/^[A-Za-z0-9_.\/-]+$/.test(scalar)) return scalar;
  return JSON.stringify(scalar);
}

function renderYamlArray(key, values, indent) {
  const prefix = " ".repeat(indent);
  if (!values || values.length === 0) return `${prefix}${key}: []`;
  return [`${prefix}${key}:`, ...values.map((value) => `${prefix}  - ${yamlScalar(value)}`)].join("\n");
}

function renderTaskProfileBlock(taskProfile) {
  const profile = normalizeTaskProfile(taskProfile);
  const lines = [
    "## Task Profile",
    "",
    "This is planner metadata for executor working style. The dispatcher may adopt review_assurance into the run manifest policy; other fields are not reviewer verdict fields, role bindings, or merge gates.",
    "",
    "```yaml",
    "task_profile:",
    `  size: ${yamlScalar(profile.size)}`,
    ...(profile.route_decision ? [`  route_decision: ${yamlScalar(profile.route_decision)}`] : []),
    `  change_type: ${yamlScalar(profile.change_type)}`,
    renderYamlArray("domains", profile.domains, 2),
    renderYamlArray("risk_tags", profile.risk_tags, 2),
    `  execution_mode: ${yamlScalar(profile.execution_mode)}`,
    `  review_assurance: ${yamlScalar(profile.review_assurance)}`,
    renderYamlArray("guidance_packs", profile.guidance_packs, 2),
  ];
  if (profile.derivation_inputs.length > 0) {
    lines.push(renderYamlArray("derivation_inputs", profile.derivation_inputs, 2));
  }
  lines.push("```");
  return lines.join("\n");
}

function extractMarkdownSubsection(sectionText, heading) {
  const lines = String(sectionText || "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === `#### ${heading}`);
  if (headingIndex === -1) return "";
  const content = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^####\s+/.test(line)) break;
    if (content.length === 0 && line.trim() === "") continue;
    content.push(line);
  }
  return content.join("\n").trim();
}

function readGuidancePackLibrary() {
  const text = fs.readFileSync(GUIDANCE_PACK_REFERENCE_PATH, "utf-8");
  const sections = new Map();
  const packHeadingPattern = /^### `([^`]+)`\n([\s\S]*?)(?=^### `|(?![\s\S]))/gm;
  for (const match of text.matchAll(packHeadingPattern)) {
    const guidance = extractMarkdownSubsection(match[2], "Guidance");
    if (guidance) sections.set(match[1], guidance);
  }
  return sections;
}

function renderWorkingGuidanceBlock(guidancePacks) {
  const packLibrary = readGuidancePackLibrary();
  const lines = [
    WORKING_GUIDANCE_HEADING,
    "",
    WORKING_GUIDANCE_BOUNDARY,
  ];
  for (const pack of guidancePacks) {
    const guidance = packLibrary.get(pack);
    if (!guidance) continue;
    lines.push("", `### ${pack}`, guidance);
  }
  return lines.length > 3 ? lines.join("\n") : "";
}

function insertBlocksBeforeRubric(prompt, blocks) {
  const block = blocks.filter(Boolean).join("\n\n");
  if (!block) return prompt;
  const rubricHeading = "\n## Scoring Rubric";
  if (prompt.includes(rubricHeading)) {
    return prompt.replace(rubricHeading, `\n${block}\n${rubricHeading}`);
  }
  return `${prompt.replace(/\s*$/, "")}\n\n${block}\n`;
}

function applyTaskProfileToDispatchPrompt({ dispatchPrompt, taskProfile }) {
  const profile = normalizeTaskProfile(taskProfile);
  if (profile.guidance_packs.length === 0) return dispatchPrompt;
  const prompt = String(dispatchPrompt || "");
  const blocks = [];
  if (!prompt.includes("## Task Profile")) {
    blocks.push(renderTaskProfileBlock(profile));
  }
  if (!prompt.includes(WORKING_GUIDANCE_HEADING)) {
    blocks.push(renderWorkingGuidanceBlock(profile.guidance_packs));
  }
  return insertBlocksBeforeRubric(prompt, blocks);
}

module.exports = {
  applyTaskProfileToDispatchPrompt,
  deriveTaskProfile,
  renderTaskProfileBlock,
  renderWorkingGuidanceBlock,
};
