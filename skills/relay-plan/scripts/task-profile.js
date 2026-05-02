const CHANGE_TYPES = new Set(["bugfix", "feature", "refactor", "docs", "test", "infra", "visual", "prompt"]);
const EXECUTION_MODES = new Set(["quick", "standard", "fresh-context", "batch-wave"]);
const SIZES = new Set(["S", "M", "L", "XL"]);
const TRUST_BOUNDARY_PATTERN = /\b(?:trust[- ]boundary|auth[- ]boundary|trust root|forge|forged|bypass|fail closed|gate-check|validate[- ]?(?:manifest|transition)|state transition|state-machine)\b/;
const STATE_MACHINE_PATTERN = /\b(?:state transition|state-machine|validate[- ]?transition|manifest state)\b/;

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

function normalizeTaskProfile(profile) {
  const change_type = CHANGE_TYPES.has(profile?.change_type) ? profile.change_type : "feature";
  const execution_mode = EXECUTION_MODES.has(profile?.execution_mode) ? profile.execution_mode : "standard";
  return {
    size: normalizeSize(profile?.size),
    change_type,
    domains: asStringArray(profile?.domains),
    risk_tags: asStringArray(profile?.risk_tags),
    execution_mode,
    guidance_packs: asStringArray(profile?.guidance_packs),
    derivation_inputs: asStringArray(profile?.derivation_inputs),
  };
}

function deriveTaskProfile({
  doneCriteria = "",
  probeSignal = "",
  historicalSignal = "",
  taskRisk = {},
  size = "M",
} = {}) {
  const probe = parseJsonish(probeSignal);
  const historical = parseJsonish(historicalSignal);
  const risk = parseJsonish(taskRisk);
  const normalizedSize = normalizeSize(size);
  const intentText = normalizeText(doneCriteria, taskRisk);
  const signalText = normalizeText(doneCriteria, probeSignal, historicalSignal, taskRisk);
  const change_type = inferChangeType(intentText);
  const domains = inferDomains(signalText, probe);
  const risk_tags = inferRiskTags(intentText, risk);
  const execution_mode = inferExecutionMode({ size: normalizedSize, risk_tags, text: signalText });
  const guidance_packs = selectGuidancePacks({
    change_type,
    risk_tags,
    size: normalizedSize,
    historical,
  });

  return {
    size: normalizedSize,
    change_type,
    domains,
    risk_tags,
    execution_mode,
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
    "This is advisory planner metadata for executor working style. It is not a reviewer verdict field, manifest role binding, or merge gate.",
    "",
    "```yaml",
    "task_profile:",
    `  size: ${yamlScalar(profile.size)}`,
    `  change_type: ${yamlScalar(profile.change_type)}`,
    renderYamlArray("domains", profile.domains, 2),
    renderYamlArray("risk_tags", profile.risk_tags, 2),
    `  execution_mode: ${yamlScalar(profile.execution_mode)}`,
    renderYamlArray("guidance_packs", profile.guidance_packs, 2),
  ];
  if (profile.derivation_inputs.length > 0) {
    lines.push(renderYamlArray("derivation_inputs", profile.derivation_inputs, 2));
  }
  lines.push("```");
  return lines.join("\n");
}

function applyTaskProfileToDispatchPrompt({ dispatchPrompt, taskProfile }) {
  const profile = normalizeTaskProfile(taskProfile);
  if (profile.guidance_packs.length === 0) return dispatchPrompt;
  if (String(dispatchPrompt || "").includes("## Task Profile")) return dispatchPrompt;
  const block = renderTaskProfileBlock(profile);
  const prompt = String(dispatchPrompt || "");
  const rubricHeading = "\n## Scoring Rubric";
  if (prompt.includes(rubricHeading)) {
    return prompt.replace(rubricHeading, `\n${block}\n${rubricHeading}`);
  }
  return `${prompt.replace(/\s*$/, "")}\n\n${block}\n`;
}

module.exports = {
  applyTaskProfileToDispatchPrompt,
  deriveTaskProfile,
  renderTaskProfileBlock,
};
