const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(
  ROOT,
  "skills",
  "relay-dispatch",
  "scripts",
  "dispatch.js"
);
const RUBRIC = path.join(
  ROOT,
  "tests",
  "relay-plan",
  "fixtures",
  "evaluation",
  "structured-zero-earned.yaml"
);

function fixture(name) {
  return path.join(
    ROOT,
    "tests",
    "relay-plan",
    "fixtures",
    "risk-assurance",
    `${name}-prompt.md`
  );
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-risk-preview-"));
  execFileSync("git", ["init", "-b", "main", repoRoot], { stdio: "ignore" });
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Relay Test"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "relay@example.com"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n", "utf8");
  execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
  execFileSync("git", ["-C", repoRoot, "commit", "-m", "fixture"], {
    stdio: "ignore",
  });
  return repoRoot;
}

function preview(name, extra = []) {
  const repoRoot = setupRepo();
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-risk-home-"));
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    repoRoot,
    "--branch",
    `risk-${name}-preview`,
    "--prompt-file",
    fixture(name),
    "--rubric-file",
    RUBRIC,
    ...extra,
    "--dry-run",
    "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });
  return JSON.parse(stdout);
}

function previewPrompt(name, prompt, extra = []) {
  const repoRoot = setupRepo();
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-risk-home-"));
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    repoRoot,
    "--branch",
    `risk-${name}-preview`,
    "--prompt",
    prompt,
    "--rubric-file",
    RUBRIC,
    ...extra,
    "--dry-run",
    "--json",
  ], {
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });
  return JSON.parse(stdout);
}

test("real dispatch surface selects compact without weakening durable runtime boundaries", () => {
  const result = preview("compact");

  assert.equal(result.reviewAssurance, "compact");
  assert.equal(result.publishPolicy, "immediate");
  assert.equal(result.sandbox, "workspace-write");
  assert.equal(result.networkAccess, "disabled");
  assert.equal(result.register, false);
  assert.equal(fs.existsSync(result.manifestPath), false);
  assert.equal(fs.existsSync(result.worktree), false);
});

test("real dispatch surface accepts an explicit compact tier at the derived floor", () => {
  const result = preview("compact", ["--review-assurance", "compact"]);

  assert.equal(result.reviewAssurance, "compact");
  assert.equal(result.publishPolicy, "immediate");
});

test("real dispatch surface rejects compact without a task-derived risk floor", () => {
  const defaultResult = previewPrompt(
    "missing-risk-default",
    "Update a repository file according to the issue."
  );
  assert.equal(defaultResult.reviewAssurance, "standard");

  assert.throws(
    () => previewPrompt(
      "missing-risk-compact",
      "Update a repository file according to the issue.",
      ["--review-assurance", "compact"]
    ),
    (error) => {
      assert.match(
        `${String(error.stdout)}\n${String(error.stderr)}`,
        /compact.*complete risk-aware task_profile|task-derived risk floor/i
      );
      return true;
    }
  );
});

test("real dispatch surface selects hardened on the existing delayed-publication path", () => {
  const result = preview("hardened");

  assert.equal(result.reviewAssurance, "hardened");
  assert.equal(result.publishPolicy, "after-internal-review");
  assert.equal(result.sandbox, "workspace-write");
  assert.equal(result.networkAccess, "disabled");
  assert.equal(fs.existsSync(result.manifestPath), false);
});

test("real dispatch surface refuses immediate publication below a high-risk path", () => {
  assert.throws(
    () => preview("hardened", [
      "--publish-policy",
      "immediate",
    ]),
    (error) => {
      assert.match(
        `${String(error.stdout)}\n${String(error.stderr)}`,
        /high-risk.*after-internal-review/i
      );
      return true;
    }
  );
});

test("real dispatch surface rejects an explicit tier below the task-derived floor", () => {
  assert.throws(
    () => preview("hardened", [
      "--review-assurance",
      "standard",
      "--publish-policy",
      "after-internal-review",
    ]),
    (error) => {
      assert.match(
        `${String(error.stdout)}\n${String(error.stderr)}`,
        /below.*hardened.*risk floor/i
      );
      return true;
    }
  );
});
