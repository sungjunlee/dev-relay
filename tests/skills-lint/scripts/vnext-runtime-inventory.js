"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RELAY_SKILLS = [
  "relay",
  "relay-config",
  "relay-dispatch",
  "relay-fleet",
  "relay-merge",
  "relay-plan",
  "relay-ready",
  "relay-review",
];
const DISPOSITIONS = new Set(["retain", "migrate", "remove", "historical-reader-only"]);
const ROLES = new Set([
  "cli-entry",
  "manifest:create",
  "manifest:read",
  "manifest:write",
  "run-record:create",
  "run-record:read",
  "run-record:write",
  "event:append",
  "event:read",
  "evidence:read",
  "evidence:write",
  "done-criteria:read",
  "done-criteria:write",
  "host:create",
  "host:observe",
  "host:read",
  "host:write",
]);
// Reviewed semantic roles are deliberately separate from lexical detection.
// They cover indirect readers/writers (facades, delegated gates, and paths passed
// through manifest fields) that cannot be proven by keywords in one source file.
const REVIEWED_SEMANTIC_ROLE_SEEDS = Object.freeze({
  "skills/relay-dispatch/scripts/dispatch.js": [
    "done-criteria:read",
    "done-criteria:write",
    "evidence:write",
  ],
  "skills/relay-dispatch/scripts/execution-evidence.js": [
    "evidence:read",
    "evidence:write",
  ],
  "skills/relay-dispatch/scripts/manifest/inflight-runs.js": ["event:read"],
  "skills/relay-dispatch/scripts/manifest/rubric.js": ["done-criteria:read"],
  "skills/relay-dispatch/scripts/rebrand-evidence.js": [
    "evidence:read",
    "evidence:write",
  ],
  "skills/relay-dispatch/scripts/reconcile-run.js": [
    "evidence:read",
    "evidence:write",
  ],
  "skills/relay-dispatch/scripts/recover-commit.js": [
    "evidence:read",
    "evidence:write",
  ],
  "skills/relay-merge/scripts/gate-check.js": [
    "done-criteria:read",
    "manifest:read",
    "run-record:read",
  ],
  "skills/relay-merge/scripts/review-gate.js": [
    "done-criteria:read",
    "event:read",
    "evidence:read",
  ],
  "skills/relay-merge/scripts/sprint-close-report.js": ["done-criteria:read"],
  "skills/relay-plan/scripts/persist-done-criteria.js": ["done-criteria:write"],
  "skills/relay-ready/scripts/probe-readiness.js": ["done-criteria:read"],
  "skills/relay-ready/scripts/relay-request.js": ["done-criteria:write"],
  "skills/relay-review/scripts/review-runner.js": [
    "done-criteria:read",
    "evidence:read",
  ],
  "skills/relay-review/scripts/review-runner/context.js": ["done-criteria:read"],
  "skills/relay-review/scripts/review-runner/execution-evidence.js": [
    "done-criteria:read",
    "evidence:read",
  ],
  "skills/relay-review/scripts/review-runner/preflight.js": ["evidence:read"],
  "skills/relay-review/scripts/review-runner/redispatch.js": ["event:read"],
  "skills/relay-review/scripts/review-runner/round-analysis.js": ["done-criteria:read"],
  "skills/relay-review/scripts/review-runner/round-artifacts.js": [
    "done-criteria:read",
    "done-criteria:write",
  ],
});

function repoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function compareText(left, right) {
  return left.localeCompare(right);
}

function sortEdges(edges) {
  return [...edges].sort((left, right) => {
    return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind);
  });
}

function walkJsFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkJsFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
    });
}

function listRelevantScripts(repoRoot) {
  return RELAY_SKILLS.flatMap((skill) => walkJsFiles(path.join(repoRoot, "skills", skill, "scripts")))
    .map((filePath) => repoPath(repoRoot, filePath))
    .sort(compareText);
}

function skillName(relativePath) {
  const match = /^skills\/([^/]+)\/scripts\//.exec(relativePath);
  return match ? match[1] : null;
}

function isRelevantScript(relativePath) {
  const skill = skillName(relativePath);
  return Boolean(skill && RELAY_SKILLS.includes(skill) && relativePath.endsWith(".js"));
}

function resolveLocalRequire(repoRoot, sourceRelativePath, request) {
  if (!request.startsWith(".")) return null;
  const absoluteBase = path.resolve(repoRoot, path.dirname(sourceRelativePath), request);
  const candidates = [absoluteBase, `${absoluteBase}.js`, path.join(absoluteBase, "index.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const relative = repoPath(repoRoot, candidate);
      return isRelevantScript(relative) ? relative : null;
    }
  }
  return null;
}

function uniqueEdges(edges) {
  const seen = new Set();
  return sortEdges(edges.filter((edge) => {
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function resolveDirnameScriptExpression(repoRoot, source, expression) {
  if (!/^\s*__dirname\s*,/.test(expression)) return null;
  const tokens = expression.split(",").map((token) => token.trim());
  if (tokens.shift() !== "__dirname") return null;
  const components = [];
  for (const token of tokens) {
    const match = /^(["'])([^"']+)\1$/.exec(token);
    if (!match) return null;
    components.push(match[2]);
  }
  const target = repoPath(repoRoot, path.resolve(repoRoot, path.dirname(source), ...components));
  return isRelevantScript(target) ? target : null;
}

function scanPathBuiltInvocations({ content, repoRoot, source }) {
  const edges = [];
  const expressionPattern = /\bpath\.(?:join|resolve)\s*\((__dirname\s*,[\s\S]*?)\)/g;
  let match;
  while ((match = expressionPattern.exec(content)) !== null) {
    const target = resolveDirnameScriptExpression(repoRoot, source, match[1]);
    if (target) edges.push({ from: source, to: target, kind: "dynamic-invocation" });
  }
  if (/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*process\.execPath\s*,\s*\[\s*__filename\b/.test(content)) {
    edges.push({ from: source, to: source, kind: "dynamic-invocation" });
  }
  return edges;
}

function scanRegisteredReviewerInvocations(repoRoot, scripts) {
  const source = "skills/relay-review/scripts/review-runner/reviewer-invoke.js";
  const registry = "skills/relay-dispatch/scripts/agent-adapters/index.js";
  if (!scripts.includes(source) || !scripts.includes(registry)) return [];
  const registryContent = fs.readFileSync(path.join(repoRoot, registry), "utf8");
  const names = new Set();
  const reviewerPattern = /\bprimaryReviewScript:\s*["']([^"']+\.js)["']/g;
  let match;
  while ((match = reviewerPattern.exec(registryContent)) !== null) names.add(match[1]);
  return [...names].sort(compareText).map((name) => ({
    from: source,
    to: `skills/relay-review/scripts/${name}`,
    kind: "dynamic-invocation",
  }));
}

function scanRuntimeEdges(repoRoot) {
  const staticImports = [];
  const dynamicInvocations = [];
  const scripts = listRelevantScripts(repoRoot);
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  const runtimeScriptLiteralPattern = /["'](skills\/(?:relay|relay-config|relay-dispatch|relay-fleet|relay-merge|relay-plan|relay-ready|relay-review)\/scripts\/[A-Za-z0-9_./-]+\.js)["']/g;

  for (const source of scripts) {
    const content = fs.readFileSync(path.join(repoRoot, source), "utf8");
    requirePattern.lastIndex = 0;
    let match;
    while ((match = requirePattern.exec(content)) !== null) {
      const target = resolveLocalRequire(repoRoot, source, match[1]);
      if (!target || skillName(source) === skillName(target)) continue;
      staticImports.push({ from: source, to: target, kind: "static-import" });
    }

    runtimeScriptLiteralPattern.lastIndex = 0;
    while ((match = runtimeScriptLiteralPattern.exec(content)) !== null) {
      const target = match[1];
      if (!isRelevantScript(target)) continue;
      dynamicInvocations.push({ from: source, to: target, kind: "dynamic-invocation" });
    }
    dynamicInvocations.push(...scanPathBuiltInvocations({ content, repoRoot, source }));
  }
  dynamicInvocations.push(...scanRegisteredReviewerInvocations(repoRoot, scripts));

  return {
    staticImports: uniqueEdges(staticImports),
    dynamicInvocations: uniqueEdges(dynamicInvocations),
  };
}

function addRole(roleMap, script, role) {
  if (!roleMap.has(script)) roleMap.set(script, new Set());
  roleMap.get(script).add(role);
}

function addManifestRole(roleMap, script, action) {
  addRole(roleMap, script, `manifest:${action}`);
  addRole(roleMap, script, `run-record:${action}`);
}

function scanRequiredRoles(repoRoot) {
  const roleMap = new Map();
  for (const script of listRelevantScripts(repoRoot)) {
    roleMap.set(script, new Set());
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");

    if (/\bprocess\.argv\b|\brequire\.main\s*===\s*module\b/.test(content)) {
      addRole(roleMap, script, "cli-entry");
    }

    const directStore = /(?:manifest\/store|relay-manifest)(?:["'])/.test(content)
      || script.endsWith("/manifest/store.js")
      || script.endsWith("/relay-manifest.js");
    if (directStore) {
      const hasCreate = /\b(?:createManifest|ensureRunLayout|initializeManifest)\b/.test(content);
      const hasWrite = /\b(?:writeManifest|writeManifestUnlocked|mutateManifest|withManifestTransaction|updateManifestState|forceTransitionState|stampPrNumber)\b/.test(content);
      const hasRead = /\b(?:readManifest|listManifest|resolveManifest|findInflightRuns|getManifest|loadManifest|getActorName)\b/.test(content);
      if (hasCreate) addManifestRole(roleMap, script, "create");
      if (hasWrite) addManifestRole(roleMap, script, "write");
      if (hasRead || (!hasCreate && !hasWrite)) addManifestRole(roleMap, script, "read");
    }

    const directEvents = /relay-events(?:["'])/.test(content) || script.endsWith("/relay-events.js");
    if (directEvents) {
      const appends = /\b(?:appendRunEvent|appendEventLine|appendStateRecovery)\b/.test(content);
      const reads = /\b(?:readRunEvents|EVENTS|getEventsPath)\b/.test(content);
      if (appends) addRole(roleMap, script, "event:append");
      if (reads || !appends) addRole(roleMap, script, "event:read");
    }

    const directEvidence = /(?:execution-evidence(?:\.json)?|executionEvidence)/i.test(content);
    if (directEvidence) {
      const writes = script === "skills/relay-dispatch/scripts/execution-evidence.js"
        || /\b(?:writeExecutionEvidence|rebrandEvidence|collectExecutorVerificationEvidence)\b/.test(content);
      const reads = /\b(?:readFileSync|parse|load|hash|compute|getExecutionEvidence)\b/.test(content);
      if (writes) addRole(roleMap, script, "evidence:write");
      if (reads || !writes) addRole(roleMap, script, "evidence:read");
    }

    const directDoneCriteria = /(?:done-criteria|doneCriteria|done_criteria)/.test(content);
    if (directDoneCriteria) {
      const writes = /\b(?:writeFileSync|copyFileSync|renameSync|persist|save|write)\b/.test(content);
      const reads = /\b(?:readFileSync|load|resolve|read)\b/.test(content);
      if (writes) addRole(roleMap, script, "done-criteria:write");
      if (reads || !writes) addRole(roleMap, script, "done-criteria:read");
    }

    const directHost = /run-runtime-state(?:["'])/.test(content) || script.endsWith("/run-runtime-state.js");
    if (directHost) {
      const writes = /\b(?:writeRunLease|writeAdvisoryLaneLease|reap|terminate|kill|removeRunLease|claim)\b/.test(content);
      const reads = /\b(?:getRunLeaseStatus|readRunLease|list|load|isProcessAlive|isGroupAlive)\b/.test(content);
      if (writes) addRole(roleMap, script, "host:write");
      if (reads || !writes) addRole(roleMap, script, "host:read");
      if (reads) addRole(roleMap, script, "host:observe");
    }
    if (/\bdetached\s*:\s*true\b/.test(content)) addRole(roleMap, script, "host:create");
  }
  return new Map([...roleMap].map(([script, roles]) => [script, [...roles].sort(compareText)]));
}

function inventoryArtifacts(inventory) {
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.artifactGroups)) {
    throw new Error("inventory must have schemaVersion 1 and artifactGroups");
  }
  const artifacts = [];
  for (const group of inventory.artifactGroups) {
    if (!group || !DISPOSITIONS.has(group.disposition) || !Array.isArray(group.artifacts) || group.artifacts.length === 0) {
      throw new Error("each artifact group needs a supported disposition and non-empty artifacts");
    }
    for (const item of group.artifacts) {
      if (
        !item
        || typeof item.path !== "string"
        || !isRelevantScript(item.path)
        || !item.roles
        || !Array.isArray(item.roles.detected)
        || !Array.isArray(item.roles.reviewedSemantic)
      ) {
        throw new Error(`invalid runtime inventory artifact: ${JSON.stringify(item)}`);
      }
      const declaredRoles = [...item.roles.detected, ...item.roles.reviewedSemantic];
      const duplicateDetected = findDuplicates(item.roles.detected, (role) => role);
      const duplicateSemantic = findDuplicates(item.roles.reviewedSemantic, (role) => role);
      if (
        duplicateDetected.length
        || duplicateSemantic.length
        || declaredRoles.some((role) => !ROLES.has(role))
      ) {
        throw new Error(`invalid or duplicate runtime roles for ${item.path}`);
      }
      artifacts.push({
        path: item.path,
        disposition: group.disposition,
        roles: {
          detected: [...item.roles.detected].sort(compareText),
          reviewedSemantic: [...item.roles.reviewedSemantic].sort(compareText),
        },
      });
    }
  }
  return artifacts.sort((left, right) => compareText(left.path, right.path));
}

function edgeKey(edge) {
  return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
}

function inventoryEdges(inventory, field, kind) {
  if (!Array.isArray(inventory[field])) throw new Error(`inventory must have ${field}`);
  return inventory[field].map((edge) => {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new Error(`invalid ${field} edge`);
    }
    return { from: edge.from, to: edge.to, kind };
  });
}

function findDuplicates(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

function compareExact(label, actual, declared) {
  const actualKeys = new Set(actual.map(edgeKey));
  const declaredKeys = new Set(declared.map(edgeKey));
  const missing = declared.filter((edge) => !actualKeys.has(edgeKey(edge)));
  const unknown = actual.filter((edge) => !declaredKeys.has(edgeKey(edge)));
  if (missing.length || unknown.length) {
    const lines = [];
    missing.forEach((edge) => lines.push(`missing ${label}: ${edge.from} -> ${edge.to}`));
    unknown.forEach((edge) => lines.push(`unaccounted ${label}: ${edge.from} -> ${edge.to}`));
    throw new Error(lines.join("\n"));
  }
}

function validateInventory({ repoRoot, inventory }) {
  const artifacts = inventoryArtifacts(inventory);
  const duplicateArtifacts = findDuplicates(artifacts, (artifact) => artifact.path);
  if (duplicateArtifacts.length) {
    throw new Error(`duplicate runtime inventory item: ${duplicateArtifacts.map((item) => item.path).join(", ")}`);
  }

  const actualScripts = listRelevantScripts(repoRoot);
  const declaredPaths = new Set(artifacts.map((artifact) => artifact.path));
  const unknownScripts = actualScripts.filter((script) => !declaredPaths.has(script));
  const missingScripts = artifacts.map((artifact) => artifact.path).filter((script) => !actualScripts.includes(script));
  if (unknownScripts.length || missingScripts.length) {
    const lines = [];
    unknownScripts.forEach((script) => lines.push(`unknown runtime script: ${script}`));
    missingScripts.forEach((script) => lines.push(`missing runtime inventory item: ${script}`));
    throw new Error(lines.join("\n"));
  }

  const requiredRoles = scanRequiredRoles(repoRoot);
  for (const seededPath of Object.keys(REVIEWED_SEMANTIC_ROLE_SEEDS)) {
    if (fs.existsSync(path.join(repoRoot, seededPath)) && !declaredPaths.has(seededPath)) {
      throw new Error(`reviewed semantic role seed references missing runtime artifact: ${seededPath}`);
    }
  }
  for (const artifact of artifacts) {
    const required = requiredRoles.get(artifact.path) || [];
    const detected = new Set(artifact.roles.detected);
    const missingDetected = required.filter((role) => !detected.has(role));
    if (missingDetected.length) {
      throw new Error(`missing detected runtime role for ${artifact.path}: ${missingDetected.join(", ")}`);
    }
    const semanticRequired = REVIEWED_SEMANTIC_ROLE_SEEDS[artifact.path] || [];
    const semantic = new Set(artifact.roles.reviewedSemantic);
    const missingSemantic = semanticRequired.filter((role) => !semantic.has(role));
    if (missingSemantic.length) {
      throw new Error(`missing reviewed semantic runtime role for ${artifact.path}: ${missingSemantic.join(", ")}`);
    }
    const unreviewedSemantic = artifact.roles.reviewedSemantic.filter((role) => !semanticRequired.includes(role));
    if (unreviewedSemantic.length) {
      throw new Error(`unreviewed semantic runtime role for ${artifact.path}: ${unreviewedSemantic.join(", ")}`);
    }
  }

  const scanned = scanRuntimeEdges(repoRoot);
  const declaredStatic = inventoryEdges(inventory, "crossSkillStaticImports", "static-import");
  const declaredDynamic = inventoryEdges(inventory, "dynamicInvocationEdges", "dynamic-invocation");
  const duplicateEdges = [
    ...findDuplicates(declaredStatic, edgeKey),
    ...findDuplicates(declaredDynamic, edgeKey),
  ];
  if (duplicateEdges.length) {
    throw new Error(`duplicate runtime inventory edge: ${duplicateEdges.map(edgeKey).join(", ")}`);
  }

  for (const edge of [...declaredStatic, ...declaredDynamic]) {
    if (!declaredPaths.has(edge.from) || !declaredPaths.has(edge.to)) {
      throw new Error(`inventory edge references unclassified script: ${edge.from} -> ${edge.to}`);
    }
  }
  compareExact("cross-skill static import", scanned.staticImports, declaredStatic);
  compareExact("dynamic invocation", scanned.dynamicInvocations, declaredDynamic);

  return {
    artifacts,
    dynamicInvocations: scanned.dynamicInvocations,
    requiredRoles,
    reviewedSemanticRoles: REVIEWED_SEMANTIC_ROLE_SEEDS,
    staticImports: scanned.staticImports,
  };
}

function stableReport(result) {
  const dispositions = {};
  for (const artifact of result.artifacts) {
    dispositions[artifact.disposition] = (dispositions[artifact.disposition] || 0) + 1;
  }
  return `${JSON.stringify({
    artifacts: result.artifacts,
    counts: {
      artifacts: result.artifacts.length,
      dynamicInvocations: result.dynamicInvocations.length,
      staticImports: result.staticImports.length,
      dispositions,
    },
    dynamicInvocations: result.dynamicInvocations,
    staticImports: result.staticImports,
  }, null, 2)}\n`;
}

function readInventory(inventoryPath) {
  return JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
}

if (require.main === module) {
  const repoRoot = path.resolve(process.argv[2] || process.cwd());
  const inventoryPath = path.join(repoRoot, "docs", "contracts", "relay-runtime-inventory.v1.json");
  process.stdout.write(stableReport(validateInventory({ repoRoot, inventory: readInventory(inventoryPath) })));
}

module.exports = {
  RELAY_SKILLS,
  REVIEWED_SEMANTIC_ROLE_SEEDS,
  inventoryArtifacts,
  listRelevantScripts,
  readInventory,
  scanRequiredRoles,
  scanRuntimeEdges,
  stableReport,
  validateInventory,
};
