const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const INSTALL_GRAPH_REFERENCE = path.join(REPO_ROOT, "references", "install-graph.md");
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

function stageInstalledSkills() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installed-skills-"));
  const installedRoot = path.join(tempRoot, "skills");
  fs.cpSync(SKILLS_DIR, installedRoot, { recursive: true });
  return installedRoot;
}

function writeSmokeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installed-smoke-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Installed Smoke"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-installed-smoke@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "installed smoke\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function runInstalledNode(installedRoot, relayHome, args, options = {}) {
  return execFileSync(process.execPath, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SKILL_ROOT: installedRoot,
      ...(options.env || {}),
    },
  });
}

function writeFakeGh() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installed-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("-q") && args[args.indexOf("-q") + 1] === ".body") {
    process.stdout.write("Closes #698\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ body: "Closes #698\\n" }));
  process.exit(0);
}
process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function writeReviewManifest({ repoRoot, relayHome }) {
  const runId = "issue-698-installed-smoke-20260621000000000";
  const branch = "issue-698-installed-smoke-review";
  const worktreePath = path.join(relayHome, "worktrees", "installed-smoke", path.basename(repoRoot));
  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" }).trim();
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Preserve installed sibling resolution\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/README.md b/README.md\n+installed smoke\n", "utf-8");

  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  try {
    const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch: "main",
      issueNumber: 698,
      worktreePath,
      orchestrator: "codex",
      executor: "codex",
      reviewer: "codex",
      doneCriteriaPath,
      doneCriteriaSource: "test-fixture",
    });
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    manifest = {
      ...manifest,
      git: {
        ...(manifest.git || {}),
        pr_number: 698,
        head_sha: headSha,
      },
      anchor: {
        ...(manifest.anchor || {}),
        rubric_source: "test-fixture",
        rubric_path: "rubric.yaml",
      },
    };
    fs.writeFileSync(path.join(runDir, manifest.anchor.rubric_path), "criteria:\n  - id: smoke\n    description: smoke\n    weight: 1\n", "utf-8");
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
    writeManifest(manifestPath, manifest);
    return { manifestPath, doneCriteriaPath, diffPath };
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
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

test("install graph documents the installed RELAY_SKILL_ROOT value", () => {
  const reference = fs.readFileSync(INSTALL_GRAPH_REFERENCE, "utf-8");
  assert.match(reference, /RELAY_SKILL_ROOT/);
  assert.match(reference, /installed sibling directory/);
  assert.match(reference, /contains `relay`, `relay-config`, `relay-dispatch`, `relay-review`/);
});

test("installed skill layout smoke resolves RELAY_SKILL_ROOT sibling scripts", () => {
  const installedRoot = stageInstalledSkills();
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installed-home-"));
  const repoRoot = writeSmokeRepo();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-installed-fixtures-"));
  const promptPath = path.join(fixtureDir, "prompt.md");
  const rubricPath = path.join(fixtureDir, "rubric.yaml");
  fs.writeFileSync(promptPath, "Make the installed smoke change.\n", "utf-8");
  fs.writeFileSync(rubricPath, "criteria:\n  - id: smoke\n    description: smoke\n    weight: 1\n", "utf-8");

  const configOutput = JSON.parse(runInstalledNode(installedRoot, relayHome, [
    path.join(installedRoot, "relay-config", "scripts", "relay-config.js"),
    "show",
    "--json",
  ], { cwd: repoRoot }));
  assert.equal(configOutput.ok, true);

  const dispatchOutput = JSON.parse(runInstalledNode(installedRoot, relayHome, [
    path.join(installedRoot, "relay-dispatch", "scripts", "dispatch.js"),
    repoRoot,
    "-b", "issue-698-installed-smoke",
    "--prompt-file", promptPath,
    "--rubric-file", rubricPath,
    "--dry-run",
    "--json",
  ]));
  assert.equal(dispatchOutput.mode, "new");
  assert.equal(dispatchOutput.dispatchSkipped, false);

  const { manifestPath, doneCriteriaPath, diffPath } = writeReviewManifest({ repoRoot, relayHome });
  const ghPath = writeFakeGh();
  const reviewOutput = JSON.parse(runInstalledNode(installedRoot, relayHome, [
    path.join(installedRoot, "relay-review", "scripts", "review-runner.js"),
    "--repo", repoRoot,
    "--manifest", manifestPath,
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { env: { RELAY_GH_BIN: ghPath } }));
  assert.equal(reviewOutput.prepareOnly, true);
  assert.match(reviewOutput.promptPath, /review-round-1-prompt\.md$/);
});
