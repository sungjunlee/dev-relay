const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TARGET_SKILLS = [
  "relay",
  "relay-ready",
  "relay-plan",
  "relay-dispatch",
  "relay-review",
  "relay-merge",
  "relay-fleet",
  "relay-sidecar",
];

function readTargetSkillFiles() {
  return TARGET_SKILLS.map((skill) => {
    const skillPath = path.join(REPO_ROOT, "skills", skill, "SKILL.md");
    return {
      skill,
      label: path.relative(REPO_ROOT, skillPath),
      content: fs.readFileSync(skillPath, "utf-8"),
    };
  });
}

function countMatches(content, pattern) {
  return Array.from(content.matchAll(pattern)).length;
}

test("target relay skills each contain exactly one Inputs section", () => {
  readTargetSkillFiles().forEach((skillFile) => {
    assert.equal(
      countMatches(skillFile.content, /^## Inputs$/gm),
      1,
      `${skillFile.label} must contain exactly one ## Inputs heading`,
    );
  });
});

test("RELAY_ROOT script references resolve to existing files", () => {
  const references = [];
  const relayRootScriptPattern = /\$RELAY_ROOT\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;

  readTargetSkillFiles().forEach((skillFile) => {
    let match;
    while ((match = relayRootScriptPattern.exec(skillFile.content)) !== null) {
      references.push({
        label: skillFile.label,
        source: match[0],
        repoRelativePath: path.join("skills", match[1], "scripts", match[2]),
      });
    }
  });

  assert.ok(references.length > 0, "expected at least one $RELAY_ROOT script reference");

  references.forEach((reference) => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, reference.repoRelativePath)),
      `${reference.label} references missing script ${reference.source} -> ${reference.repoRelativePath}`,
    );
  });
});

test("target relay skills each contain exactly one CLAUDE_SKILL_DIR fallback", () => {
  readTargetSkillFiles().forEach((skillFile) => {
    assert.equal(
      countMatches(skillFile.content, /\$\{CLAUDE_SKILL_DIR\}/g),
      1,
      `${skillFile.label} must contain exactly one \${CLAUDE_SKILL_DIR} occurrence`,
    );
  });
});
