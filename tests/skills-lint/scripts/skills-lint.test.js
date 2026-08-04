const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const MAX_SKILL_MD_LINES = 150;
const RELAY_READY_REQUEST_CONTRACT_SCHEMA = path.join(
  REPO_ROOT,
  "skills",
  "relay-ready",
  "scripts",
  "request-contract.schema.json",
);
const OPERATOR_SURFACE_REFERENCE = path.join(REPO_ROOT, "references", "operator-surface.md");
const README_PATH = path.join(REPO_ROOT, "README.md");
const CLAUDE_GUIDE_PATH = path.join(REPO_ROOT, "CLAUDE.md");
const ARCHITECTURE_REFERENCE_PATH = path.join(REPO_ROOT, "references", "architecture.md");
const RELAY_READY_DESIGN_PATH = path.join(REPO_ROOT, "docs", "relay-ready-routing-and-handoff-design.md");
const WORKFLOW_LANES_PATH = path.join(REPO_ROOT, "docs", "workflow-lanes.md");

const SURFACE_TIERS = {
  "public operator surface": ["relay-config", "relay", "relay-merge"],
  "internal phase surface": ["relay-ready", "relay-plan", "relay-dispatch", "relay-review"],
  "optional/advanced surface": ["relay-fleet"],
};

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

function countLines(text) {
  if (text.length === 0) return 0;
  const lines = splitLines(text);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function assertLineCount({ label, content, maxLines = MAX_SKILL_MD_LINES }) {
  const lines = countLines(content);
  assert.ok(lines <= maxLines, `${label} has ${lines} lines; maximum is ${maxLines}`);
}

function extractBashBlocks(content) {
  const blocks = [];
  const lines = splitLines(content);
  let startLine = null;
  let current = [];

  lines.forEach((line, index) => {
    if (startLine === null) {
      if (/^```bash\s*$/.test(line)) {
        startLine = index + 1;
        current = [];
      }
      return;
    }

    if (/^```\s*$/.test(line)) {
      blocks.push({
        startLine,
        content: current.join("\n"),
      });
      startLine = null;
      current = [];
      return;
    }

    current.push(line);
  });

  assert.equal(startLine, null, `unterminated bash fence starting at line ${startLine}`);
  return blocks;
}

function normalizeDocPlaceholdersForBash(content) {
  return content.replace(/<[A-Za-z0-9._-]+>/g, "PLACEHOLDER");
}

function assertBashBlocksParse({ label, content }) {
  const blocks = extractBashBlocks(content);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-lint-bash-"));
  try {
    blocks.forEach((block, index) => {
      const tmpFile = path.join(tmpDir, `block-${index + 1}.sh`);
      fs.writeFileSync(tmpFile, `${normalizeDocPlaceholdersForBash(block.content)}\n`, "utf-8");
      try {
        execFileSync("bash", ["-n", tmpFile], { encoding: "utf-8", stdio: "pipe" });
      } catch (error) {
        const stderr = error.stderr ? String(error.stderr).trim() : "";
        assert.fail(`${label} bash block ${index + 1} starting at line ${block.startLine} failed bash -n${stderr ? `: ${stderr}` : ""}`);
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractCrossSkillScriptPaths(content) {
  const blocks = extractBashBlocks(content);
  const references = [];
  const envPattern = /\$\{CLAUDE_SKILL_DIR\}\/\.\.\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;
  const relayRootPattern = /\$\{RELAY_SKILL_ROOT:-skills\}\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;
  const literalPattern = /(?<![A-Za-z0-9._/-])skills\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;

  blocks.forEach((block) => {
    for (const pattern of [envPattern, relayRootPattern, literalPattern]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(block.content)) !== null) {
        references.push({
          source: match[0],
          repoRelativePath: path.join("skills", match[1], "scripts", match[2]),
          line: block.startLine,
        });
      }
    }
  });

  return references;
}

function assertCrossSkillPathsExist({ label, content, repoRoot = REPO_ROOT }) {
  const references = extractCrossSkillScriptPaths(content);
  references.forEach((reference) => {
    const absolutePath = path.join(repoRoot, reference.repoRelativePath);
    assert.ok(
      fs.existsSync(absolutePath),
      `${label} references missing script ${reference.source} -> ${reference.repoRelativePath} near line ${reference.line}`,
    );
  });
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function parseFrontmatter(content) {
  const lines = splitLines(content);
  assert.equal(lines[0], "---", "SKILL.md must start with YAML frontmatter delimiter");

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  assert.ok(endIndex > 0, "SKILL.md frontmatter must end with YAML delimiter");

  const data = {};
  let currentMapKey = null;
  lines.slice(1, endIndex).forEach((line, offset) => {
    const lineNumber = offset + 2;
    if (line.trim() === "") return;

    const nested = line.match(/^  ([A-Za-z0-9._-]+):(?:\s*(.*))?$/);
    if (nested) {
      assert.ok(currentMapKey, `nested frontmatter key has no parent at line ${lineNumber}`);
      data[currentMapKey][nested[1]] = parseScalar(nested[2] || "");
      return;
    }

    assert.ok(!line.startsWith(" "), `unsupported frontmatter indentation at line ${lineNumber}`);
    const topLevel = line.match(/^([A-Za-z0-9._-]+):(?:\s*(.*))?$/);
    assert.ok(topLevel, `invalid frontmatter line ${lineNumber}: ${line}`);

    if (topLevel[2] === undefined || topLevel[2] === "") {
      data[topLevel[1]] = {};
      currentMapKey = topLevel[1];
    } else {
      data[topLevel[1]] = parseScalar(topLevel[2]);
      currentMapKey = null;
    }
  });

  return data;
}

function assertSkillFrontmatterSchema({ label, content, path: skillPath = label }) {
  const frontmatter = parseFrontmatter(content);
  const skillDir = path.basename(path.dirname(skillPath));
  for (const key of ["name", "description", "compatibility", "metadata"]) {
    assert.ok(Object.hasOwn(frontmatter, key), `${label} frontmatter missing required key: ${key}`);
  }
  assert.equal(typeof frontmatter.name, "string", `${label} frontmatter name must be a string`);
  assert.match(frontmatter.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${label} frontmatter name must be kebab-case`);
  assert.equal(frontmatter.name, path.basename(path.dirname(label)), `${label} frontmatter name must match its directory`);
  assert.equal(typeof frontmatter.description, "string", `${label} frontmatter description must be a string`);
  assert.notEqual(frontmatter.description.trim(), "", `${label} frontmatter description must not be empty`);
  assert.equal(typeof frontmatter.compatibility, "string", `${label} frontmatter compatibility must be a string`);
  assert.notEqual(frontmatter.compatibility.trim(), "", `${label} frontmatter compatibility must not be empty`);
  assert.equal(typeof frontmatter.metadata, "object", `${label} frontmatter metadata must be a map`);
  assert.notEqual(frontmatter.metadata, null, `${label} frontmatter metadata must be a map`);
  assert.ok(
    Object.hasOwn(frontmatter.metadata, "related-skills"),
    `${label} frontmatter metadata missing required key: related-skills`,
  );
  assert.equal(
    typeof frontmatter.metadata["related-skills"],
    "string",
    `${label} frontmatter metadata.related-skills must be a string`,
  );
  assert.notEqual(
    frontmatter.metadata["related-skills"].trim(),
    "",
    `${label} frontmatter metadata.related-skills must not be empty`,
  );
  if ("argument-hint" in frontmatter) {
    assert.ok(
      typeof frontmatter["argument-hint"] === "string" && frontmatter["argument-hint"].trim().length > 0,
      `${label}: argument-hint must be a non-empty string`,
    );
  }
  if (frontmatter.metadata && "keywords" in frontmatter.metadata) {
    assert.ok(
      typeof frontmatter.metadata.keywords === "string" && frontmatter.metadata.keywords.trim().length > 0,
      `${label}: metadata.keywords must be a non-empty string`,
    );
  }
  if ("context" in frontmatter && skillDir !== "relay-review") {
    assert.fail(`${label}: 'context' frontmatter is only allowed on relay-review/SKILL.md`);
  }
  if ("context" in frontmatter) {
    assert.equal(
      frontmatter.context,
      "fork",
      `${label}: 'context' currently must be exactly "fork" (only relay-review uses it)`,
    );
  }
}

function readSkillFiles() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SKILLS_DIR, entry.name, "SKILL.md"))
    .filter((skillPath) => fs.existsSync(skillPath))
    .sort()
    .map((skillPath) => ({
      path: skillPath,
      label: path.relative(REPO_ROOT, skillPath),
      content: fs.readFileSync(skillPath, "utf-8"),
    }));
}

function extractOperatorSurfaceTierSkills(content) {
  const tierNames = new Set(Object.keys(SURFACE_TIERS));
  const entries = [];

  splitLines(content).forEach((line) => {
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!row) return;

    const tier = row[1].trim().toLowerCase();
    if (!tierNames.has(tier)) return;

    const skillsCell = row[2];
    for (const match of skillsCell.matchAll(/`([^`]+)`/g)) {
      entries.push({ tier, skill: match[1] });
    }
  });

  return entries;
}

function assertOperatorSurfacePolicy(content) {
  assert.match(
    content,
    /bundle-installed relay runtime/i,
    "operator surface reference must name the bundle-installed runtime shape",
  );
  assert.match(
    content,
    /SKILL\.md[\s\S]*references\/[\s\S]*scripts/i,
    "operator surface reference must define SKILL.md vs references/ vs scripts placement",
  );

  Object.entries(SURFACE_TIERS).forEach(([tier, skills]) => {
    assert.match(content.toLowerCase(), new RegExp(tier), `operator surface reference must define ${tier}`);
    skills.forEach((skill) => {
      assert.match(content, new RegExp(`\`${skill}\``), `operator surface reference must classify ${skill}`);
    });
  });

  const installedSkills = readSkillFiles().map((skillFile) => path.basename(path.dirname(skillFile.path))).sort();
  const classifiedSkills = extractOperatorSurfaceTierSkills(content);
  const counts = new Map();
  classifiedSkills.forEach(({ skill }) => counts.set(skill, (counts.get(skill) || 0) + 1));
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([skill]) => skill)
    .sort();
  assert.deepEqual(duplicates, [], "operator surface reference must not classify a skill in multiple tiers");
  assert.deepEqual(
    [...counts.keys()].sort(),
    installedSkills,
    "operator surface reference must classify every installed skill exactly once",
  );
}

function assertRelayStopsAtReadyToMerge(content) {
  const frontmatter = parseFrontmatter(content);
  assert.match(
    frontmatter.description,
    /ready_to_merge/i,
    "relay frontmatter description must name the ready_to_merge stop boundary",
  );
  assert.doesNotMatch(
    frontmatter.description,
    /plan,\s*dispatch,\s*review,\s*merge/i,
    "relay frontmatter description must not imply automatic merge by default",
  );
}

function assertRelayReviewAdapterDetailsStayReferenced(content) {
  const adapterSpecificPatterns = [
    /invoke-reviewer-codex\.js/,
    /invoke-reviewer-claude\.js/,
    /--reviewer-model\s+(?:example\/|openai\/|google\/|composer-)/,
    /--advisory-reviewer-model\s+(?:openai\/|google\/)/,
    /RELAY_(?:PI|CURSOR|ANTIGRAVITY)_[A-Z_]+/,
    /agent --mode ask/,
    /agy CLI/,
    /Pi adapter passes/,
  ];

  adapterSpecificPatterns.forEach((pattern) => {
    assert.doesNotMatch(
      content,
      pattern,
      `relay-review/SKILL.md should reference adapter docs instead of carrying provider-specific detail: ${pattern}`,
    );
  });

  assert.match(
    content,
    /\.\.\/relay-dispatch\/references\/agent-adapter-platform\.md/,
    "relay-review/SKILL.md must point provider-specific adapter details to the adapter platform reference",
  );
}

function assertReadmeAdapterPrereqDetailsStayReferenced(content) {
  assert.match(
    content,
    /skills\/relay-dispatch\/references\/agent-adapter-platform\.md/,
    "README must point adapter-specific prerequisites to the adapter platform reference",
  );
  for (const pattern of [
    /RELAY_(?:PI|CURSOR|ANTIGRAVITY)_[A-Z_]+/,
    /Pi CLI \d/i,
    /Antigravity CLI `agy` \d/i,
    /Cursor Agent CLI `agent`/i,
  ]) {
    assert.doesNotMatch(
      content,
      pattern,
      `README should not carry high-churn adapter prerequisite detail: ${pattern}`,
    );
  }
}

function assertProjectDocsPreserveExplicitMergeBoundary(docs) {
  const requiredPatterns = [
    {
      label: "README",
      content: docs.readme,
      pattern: /stops at `ready_to_merge` until you explicitly land it[\s\S]*Use `\/relay-merge` only when you explicitly want to land/i,
    },
    {
      label: "CLAUDE.md",
      content: docs.claudeGuide,
      pattern: /workflows with explicit merge[\s\S]*stopping at `ready_to_merge` unless the user explicitly invokes `relay-merge`/i,
    },
    {
      label: "workflow lane policy",
      content: docs.workflowLanes,
      pattern: /ready_to_merge gate → explicit merge/i,
    },
    {
      label: "architecture readiness flow",
      content: docs.architectureReference,
      pattern: /relay-review\s*\n\s*-> ready_to_merge\s*\n\s*-> relay-merge \(explicit only\)/i,
    },
    {
      label: "relay-ready handoff design",
      content: docs.relayReadyDesign,
      pattern: /plan -> dispatch -> review -> ready_to_merge; merge explicit/i,
    },
  ];

  requiredPatterns.forEach(({ label, content, pattern }) => {
    assert.match(content, pattern, `${label} must preserve the explicit ready_to_merge merge boundary`);
  });

  assert.doesNotMatch(
    docs.claudeGuide,
    /relay-plan\s*->\s*relay-dispatch\s*->\s*relay-review\s*->\s*relay-merge/i,
    "CLAUDE.md must not describe /relay as automatically continuing through relay-merge",
  );
}

function assertNeedsSplitProposalFirstBoundary(docs) {
  assert.match(
    docs.relaySkill,
    /judgment is `needs_split`[\s\S]*proposal-first relay-ready shaping/i,
    "relay skill must route needs_split to proposal-first relay-ready shaping",
  );
  assert.match(
    docs.preflightGuards,
    /`proposal-first`[\s\S]*requires an accepted handoff[\s\S]*explicit\s+operator override, never the default route/i,
    "preflight guard docs must expose the accepted-handoff default and explicit operator override for needs_split",
  );
  assert.match(
    docs.relayReadySkill,
    /accepted relay-ready handoff supersedes[\s\S]{0,80}?acceptance criteria\s+only when[\s\S]{0,300}?source identity[\s\S]{0,200}?matches/i,
    "relay-ready must keep the accepted-handoff source-of-truth rule, scoped to a bundle whose recorded source identity matches this issue",
  );
  assert.match(
    docs.relayReadyDesign,
    /route preflight detects task-shape risk only[\s\S]*semantic leaf boundaries require operator-approved relay-ready handoffs/i,
    "handoff design must separate task-shape detection from semantic leaf approval",
  );
}

test("all skills/SKILL.md files satisfy the lint contract", () => {
  const skillFiles = readSkillFiles();
  assert.ok(skillFiles.length > 0, "expected at least one skills/*/SKILL.md file");

  skillFiles.forEach((skillFile) => {
    assertLineCount(skillFile);
    assertBashBlocksParse(skillFile);
    assertCrossSkillPathsExist(skillFile);
    assertSkillFrontmatterSchema(skillFile);
  });
});

test("relay-ready request contract schema exists and is parseable JSON", () => {
  assert.ok(fs.existsSync(RELAY_READY_REQUEST_CONTRACT_SCHEMA), "relay-ready request contract schema is missing");

  const schema = JSON.parse(fs.readFileSync(RELAY_READY_REQUEST_CONTRACT_SCHEMA, "utf-8"));
  assert.equal(typeof schema.$schema, "string", "request contract schema must declare $schema");
  assert.match(JSON.stringify(schema), /"enum"/, "request contract schema must define enum domains");
  assert.deepEqual(
    schema.$defs.readiness.required,
    ["clarity", "granularity", "dependency", "verifiability", "risk"],
    "readiness must require every field relay-request.js normalizes",
  );
  assert.ok(schema.$defs.RequestArtifact, "request contract schema must document persisted request artifacts");
  assert.equal(
    schema.$defs.RequestArtifact.properties.paths.properties.done_criteria.anyOf.length,
    2,
    "request artifact paths.done_criteria must document single-leaf and multi-leaf shapes",
  );
  assert.ok(schema.$defs.HandoffArtifact, "request contract schema must document persisted handoff artifacts");
  assert.ok(
    schema.$defs.HandoffArtifact.required.includes("done_criteria_path"),
    "handoff artifact schema must require done_criteria_path",
  );
});

test("operator surface policy classifies skill command tiers", () => {
  assert.ok(fs.existsSync(OPERATOR_SURFACE_REFERENCE), "references/operator-surface.md is missing");
  const content = fs.readFileSync(OPERATOR_SURFACE_REFERENCE, "utf-8");
  assertOperatorSurfacePolicy(content);
});

test("operator surface policy rejects missing or duplicate skill coverage", () => {
  const content = fs.readFileSync(OPERATOR_SURFACE_REFERENCE, "utf-8");
  assert.throws(
    () => assertOperatorSurfacePolicy(content.replace("`relay-fleet`", "")),
    /classify relay-fleet|classify every installed skill exactly once/,
  );
  assert.throws(
    () => assertOperatorSurfacePolicy(content.replace("`relay-fleet`", "`relay`, `relay-fleet`")),
    /must not classify a skill in multiple tiers/,
  );
});

test("relay skill description preserves explicit ready_to_merge stop boundary", () => {
  const relaySkill = fs.readFileSync(path.join(SKILLS_DIR, "relay", "SKILL.md"), "utf-8");
  assertRelayStopsAtReadyToMerge(relaySkill);
});

test("needs_split route documents proposal-first relay-ready shaping boundary", () => {
  assertNeedsSplitProposalFirstBoundary({
    relaySkill: fs.readFileSync(path.join(SKILLS_DIR, "relay", "SKILL.md"), "utf-8"),
    relayReadySkill: fs.readFileSync(path.join(SKILLS_DIR, "relay-ready", "SKILL.md"), "utf-8"),
    preflightGuards: fs.readFileSync(path.join(SKILLS_DIR, "relay", "references", "preflight-guards.md"), "utf-8"),
    relayReadyDesign: fs.readFileSync(RELAY_READY_DESIGN_PATH, "utf-8"),
  });
});

test("relay-review spine delegates provider-specific adapter details", () => {
  const relayReviewSkill = fs.readFileSync(path.join(SKILLS_DIR, "relay-review", "SKILL.md"), "utf-8");
  assertRelayReviewAdapterDetailsStayReferenced(relayReviewSkill);
});

test("README delegates adapter prerequisite churn to adapter references", () => {
  const readme = fs.readFileSync(README_PATH, "utf-8");
  assertReadmeAdapterPrereqDetailsStayReferenced(readme);
});

test("project docs preserve explicit relay merge boundary", () => {
  assertProjectDocsPreserveExplicitMergeBoundary({
    readme: fs.readFileSync(README_PATH, "utf-8"),
    claudeGuide: fs.readFileSync(CLAUDE_GUIDE_PATH, "utf-8"),
    architectureReference: fs.readFileSync(ARCHITECTURE_REFERENCE_PATH, "utf-8"),
    relayReadyDesign: fs.readFileSync(RELAY_READY_DESIGN_PATH, "utf-8"),
    workflowLanes: fs.readFileSync(WORKFLOW_LANES_PATH, "utf-8"),
  });
});

test("assertLineCount rejects SKILL.md files over 150 lines", () => {
  const content = Array.from({ length: MAX_SKILL_MD_LINES + 1 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.throws(
    () => assertLineCount({ label: "fixture/SKILL.md", content }),
    /maximum is 150/,
  );
});

test("assertBashBlocksParse rejects invalid fenced bash", () => {
  const content = [
    "---",
    "name: fixture",
    "description: fixture",
    "metadata:",
    "  entry: scripts/example.js",
    "---",
    "```bash",
    "if true; then",
    "  echo missing-fi",
    "```",
    "",
  ].join("\n");

  assert.throws(
    () => assertBashBlocksParse({ label: "fixture/SKILL.md", content }),
    /failed bash -n/,
  );
});

test("assertCrossSkillPathsExist rejects missing cross-skill script references", () => {
  const content = [
    "```bash",
    "node ${CLAUDE_SKILL_DIR}/../relay-dispatch/scripts/does-not-exist.js",
    'node "${RELAY_SKILL_ROOT:-skills}/relay-plan/scripts/also-missing.js"',
    "node skills/relay-review/scripts/also-missing.js",
    "```",
    "",
  ].join("\n");

  assert.throws(
    () => assertCrossSkillPathsExist({ label: "fixture/SKILL.md", content }),
    /references missing script/,
  );
});

test("assertSkillFrontmatterSchema rejects missing or malformed frontmatter", () => {
  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "missing/SKILL.md",
      content: "# Missing frontmatter\n",
    }),
    /must start with YAML frontmatter delimiter/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "missing-compatibility/SKILL.md",
      content: [
        "---",
        "name: missing-compatibility",
        "description: fixture",
        "metadata:",
        "  related-skills: relay",
        "---",
        "",
      ].join("\n"),
    }),
    /missing required key: compatibility/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "missing-related-skills/SKILL.md",
      content: [
        "---",
        "name: missing-related-skills",
        "description: fixture",
        "compatibility: Requires Node.js 18+.",
        "metadata:",
        "  entry: scripts/example.js",
        "---",
        "",
      ].join("\n"),
    }),
    /metadata missing required key: related-skills/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "malformed/SKILL.md",
      content: [
        "---",
        "name fixture",
        "description: fixture",
        "metadata:",
        "  entry: scripts/example.js",
        "---",
        "",
      ].join("\n"),
    }),
    /invalid frontmatter line/,
  );
});

test("assertSkillFrontmatterSchema rejects malformed optional frontmatter fields", () => {
  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "relay-plan/SKILL.md",
      content: [
        "---",
        "name: relay-plan",
        "argument-hint: ",
        "description: fixture",
        "compatibility: Requires Node.js 18+.",
        "metadata:",
        "  related-skills: relay",
        "---",
        "",
      ].join("\n"),
    }),
    /argument-hint must be a non-empty string/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "relay-plan/SKILL.md",
      content: [
        "---",
        "name: relay-plan",
        "description: fixture",
        "compatibility: Requires Node.js 18+.",
        "metadata:",
        "  related-skills: relay",
        "  keywords: ",
        "---",
        "",
      ].join("\n"),
    }),
    /metadata\.keywords must be a non-empty string/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "relay-plan/SKILL.md",
      content: [
        "---",
        "name: relay-plan",
        "description: fixture",
        "compatibility: Requires Node.js 18+.",
        "context: fork",
        "metadata:",
        "  related-skills: relay",
        "---",
        "",
      ].join("\n"),
    }),
    /context' frontmatter is only allowed on relay-review\/SKILL\.md/,
  );

  assert.throws(
    () => assertSkillFrontmatterSchema({
      label: "relay-review/SKILL.md",
      content: [
        "---",
        "name: relay-review",
        "description: fixture",
        "compatibility: Requires Node.js 18+.",
        "context: fresh",
        "metadata:",
        "  related-skills: relay",
        "---",
        "",
      ].join("\n"),
    }),
    /context' currently must be exactly "fork"/,
  );
});
