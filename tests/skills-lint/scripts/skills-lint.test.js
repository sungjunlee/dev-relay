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
  const literalPattern = /(?<![A-Za-z0-9._/-])skills\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;

  blocks.forEach((block) => {
    for (const pattern of [envPattern, literalPattern]) {
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

function assertSkillFrontmatterSchema({ label, content }) {
  const frontmatter = parseFrontmatter(content);
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
