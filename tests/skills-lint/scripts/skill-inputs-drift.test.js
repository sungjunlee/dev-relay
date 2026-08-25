"use strict";

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

function content(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("relay skills with an Inputs section keep one unambiguous section", () => {
  for (const relativePath of SKILL_PATHS) {
    const source = content(relativePath);
    const headings = source.match(/^## Inputs$/gm) || [];
    assert.ok(headings.length <= 1, `${relativePath} may have at most one Inputs section`);
    assert.match(source, /^---\n[\s\S]+?\n---\n/, `${relativePath} must have frontmatter`);
  }
});

test("documented installed sibling script paths resolve", () => {
  const pattern = /\$\{RELAY_SKILL_ROOT:-skills\}\/([A-Za-z0-9._-]+)\/scripts\/([A-Za-z0-9._/-]+)/g;
  for (const relativePath of SKILL_PATHS) {
    const source = content(relativePath);
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const target = path.join(REPO_ROOT, "skills", match[1], "scripts", match[2]);
      assert.ok(fs.existsSync(target), `${relativePath} references missing ${match[0]}`);
    }
  }
});

test("architecture states the Relay installed sibling root contract", () => {
  const source = content("docs/architecture.md");
  assert.match(source, /RELAY_SKILL_ROOT/);
  assert.match(source, /installed sibling root/);
  assert.match(source, /relay-dispatch/);
  assert.match(source, /run-store\.js/);
});

function listSkillMarkdown(dir = path.join(REPO_ROOT, "skills"), acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSkillMarkdown(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

test("installed skill markdown does not require clone-only docs", () => {
  const forbidden = /\.\.\/\.\.\/(?:docs|references)\//;
  for (const filePath of listSkillMarkdown()) {
    const relativePath = path.relative(REPO_ROOT, filePath);
    assert.doesNotMatch(
      fs.readFileSync(filePath, "utf8"),
      forbidden,
      `${relativePath} must not point at clone-only docs/ or root references/`,
    );
  }
});
