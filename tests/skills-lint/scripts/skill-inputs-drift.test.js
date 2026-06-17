const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILL_PATHS = [
  "skills/relay/SKILL.md",
  "skills/relay-ready/SKILL.md",
  "skills/relay-plan/SKILL.md",
  "skills/relay-dispatch/SKILL.md",
  "skills/relay-review/SKILL.md",
  "skills/relay-merge/SKILL.md",
  "skills/relay-fleet/SKILL.md",
];

function readTargetSkillFiles() {
  return SKILL_PATHS.map((relativePath) => ({
    relativePath,
    content: fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8"),
  }));
}

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

test("target dev-relay skills contain exactly one Inputs section immediately after frontmatter", () => {
  readTargetSkillFiles().forEach(({ relativePath, content }) => {
    const headings = content.match(/^## Inputs$/gm) || [];
    assert.equal(headings.length, 1, `${relativePath} must contain exactly one ## Inputs heading`);

    const lines = splitLines(content);
    const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line === "---");
    assert.ok(frontmatterEnd > 0, `${relativePath} must contain YAML frontmatter`);
    assert.equal(lines[frontmatterEnd + 1], "## Inputs", `${relativePath} must put ## Inputs immediately after frontmatter`);
  });
});

test("RELAY_SKILL_ROOT script references resolve to files", () => {
  const pattern = /\$\{RELAY_SKILL_ROOT:-skills\}\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;

  readTargetSkillFiles().forEach(({ relativePath, content }) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const repoRelativePath = path.join("skills", match[1], "scripts", match[2]);
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, repoRelativePath)),
        `${relativePath} references missing script ${match[0]} -> ${repoRelativePath}`,
      );
    }
  });
});
