const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureRunLayout } = require("../../relay-dispatch/scripts/relay-manifest");
const {
  createEnforcementFixture,
  DEFAULT_ENFORCEMENT_RUBRIC,
} = require("../../relay-dispatch/scripts/test-support");
const {
  loadProjectConventions,
  parseRemoteHost,
  resolveIssueNumber,
} = require("./review-runner/context");
const {
  loadRubricFromRunDir,
} = require("../../relay-dispatch/scripts/manifest/rubric");
const { buildPrompt } = require("./review-runner/prompt");

function createRunFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-context-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-189-20260418010101010";
  const { runDir } = ensureRunLayout(repoRoot, runId);
  return { repoRoot, runDir, runId };
}

function withFakeGh(fixture, callback) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-gh-repo-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-gh-bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fixture = JSON.parse(process.env.RELAY_REVIEW_FAKE_GH_FIXTURE || "{}");
const args = process.argv.slice(2);

if (fixture.failOnCall) {
  process.stderr.write("gh should not have been called");
  process.exit(91);
}

if (args[0] === "pr" && args[1] === "view") {
  const jsonIndex = args.indexOf("--json");
  const fields = jsonIndex === -1 ? "" : args[jsonIndex + 1];
  if (fields === "closingIssuesReferences,body,headRefName") {
    process.stdout.write(JSON.stringify({
      closingIssuesReferences: fixture.closingIssuesReferences || [],
      body: fixture.body || "",
      headRefName: fixture.headRefName || "",
    }));
    process.exit(0);
  }
}

process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);

  const originalPath = process.env.PATH;
  const originalFixture = process.env.RELAY_REVIEW_FAKE_GH_FIXTURE;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.RELAY_REVIEW_FAKE_GH_FIXTURE = JSON.stringify(fixture);
  try {
    return callback(repoRoot);
  } finally {
    process.env.PATH = originalPath;
    if (originalFixture === undefined) {
      delete process.env.RELAY_REVIEW_FAKE_GH_FIXTURE;
    } else {
      process.env.RELAY_REVIEW_FAKE_GH_FIXTURE = originalFixture;
    }
  }
}

test("context/resolveIssueNumber prefers manifest issue before GitHub fallbacks", () => {
  withFakeGh({ failOnCall: true }, (repoRoot) => {
    const issueNumber = resolveIssueNumber(repoRoot, 123, "issue-42", {
      issue: { number: 77 },
    });

    assert.equal(issueNumber, 77);
  });
});

test("context/resolveIssueNumber skips inference when explicit Done Criteria file is present", () => {
  withFakeGh({ failOnCall: true }, (repoRoot) => {
    assert.equal(
      resolveIssueNumber(repoRoot, 123, "issue-42", {}, { doneCriteriaFile: "/tmp/done-criteria.md" }),
      null
    );
  });
});

test("context/resolveIssueNumber skips inference when manifest Done Criteria anchor is present", () => {
  withFakeGh({ failOnCall: true }, (repoRoot) => {
    assert.equal(
      resolveIssueNumber(repoRoot, 123, "issue-42", {
        anchor: { done_criteria_path: "/tmp/frozen-done-criteria.md" },
      }),
      null
    );
  });
});

test("context/resolveIssueNumber accepts explicit PR body closing keywords", async (t) => {
  const cases = [
    ["fixes", "Fixes #51", 51],
    ["closes", "Closes #52", 52],
    ["resolves", "Resolves #53", 53],
    ["fix", "Fix #54", 54],
    ["close", "Close #55", 55],
    ["resolve", "Resolve #56", 56],
  ];

  for (const [label, body, expected] of cases) {
    await t.test(label, () => {
      withFakeGh({
        body,
        closingIssuesReferences: [{ number: 99 }],
        headRefName: "issue-12",
      }, (repoRoot) => {
        assert.equal(resolveIssueNumber(repoRoot, 123, null, {}), expected);
      });
    });
  }
});

test("context/resolveIssueNumber ignores Refs, Related, and incidental issue prose", () => {
  withFakeGh({
    body: "Refs #31\nRelated to #32\nSprint 3, #33 should stay incidental.",
    closingIssuesReferences: [],
    headRefName: "feature/issue-44-review-anchor",
  }, (repoRoot) => {
    assert.equal(resolveIssueNumber(repoRoot, 123, null, {}), 44);
  });
});

test("context/resolveIssueNumber treats closingIssuesReferences as the weakest fallback", () => {
  withFakeGh({
    body: "",
    closingIssuesReferences: [{ number: 99 }],
    headRefName: "feature/issue-44-review-anchor",
  }, (repoRoot) => {
    assert.equal(resolveIssueNumber(repoRoot, 123, null, {}), 44);
  });

  withFakeGh({
    body: "",
    closingIssuesReferences: [{ number: 99 }],
    headRefName: "feature/no-issue-anchor",
  }, (repoRoot) => {
    assert.equal(resolveIssueNumber(repoRoot, 123, null, {}), 99);
  });
});

test("context/resolveIssueNumber rejects multiple inferred closing refs without a stronger anchor", () => {
  withFakeGh({
    body: "Refs #31\nRelated to #32",
    closingIssuesReferences: [{ number: 99 }, { number: 100 }],
    headRefName: "feature/no-issue-anchor",
  }, (repoRoot) => {
    assert.throws(
      () => resolveIssueNumber(repoRoot, 123, null, {}),
      /Ambiguous GitHub closing issue references for PR #123: #99, #100.*manifest\.issue\.number.*anchor\.done_criteria_path/s
    );
  });
});

test("context/loadRubricFromRunDir preserves the rubric state matrix", async (t) => {
  const cases = [
    { label: "loaded", fixture: { state: "loaded" }, expectedState: "loaded", expectedStatus: "satisfied", warning: null },
    { label: "not_set", fixture: { state: "not_set" }, expectedState: "not_set", expectedStatus: "missing_path", warning: /\[rubric path not set\]/i },
    { label: "missing", fixture: { state: "missing" }, expectedState: "missing", expectedStatus: "missing", warning: /\[rubric missing\]/i },
    { label: "outside_run_dir", fixture: { state: "outside_run_dir" }, expectedState: "outside_run_dir", expectedStatus: "outside_run_dir", warning: /\[rubric path outside run dir\]/i },
    { label: "empty", fixture: { state: "empty" }, expectedState: "empty", expectedStatus: "empty", warning: /\[rubric empty\]/i },
    { label: "invalid", fixture: { state: "invalid" }, expectedState: "invalid", expectedStatus: "not_file", warning: /\[rubric invalid\]/i },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const { repoRoot, runDir, runId } = createRunFixture();
      const fixture = createEnforcementFixture({
        repoRoot,
        runId,
        ...entry.fixture,
      });
      const result = loadRubricFromRunDir(runDir, {
        run_id: runId,
        anchor: fixture.anchor,
      });

      assert.equal(result.state, entry.expectedState);
      assert.equal(result.status, entry.expectedStatus);
      if (entry.expectedState === "loaded") {
        assert.equal(result.content, DEFAULT_ENFORCEMENT_RUBRIC);
        assert.equal(result.warning, null);
      } else {
        assert.match(result.warning, entry.warning);
      }
    });
  }
});

test("context/loadRubricFromRunDir applies the legacy-grandfather retirement matrix", async (t) => {
  const cases = [
    { label: "undefined", value: undefined, expectedState: "loaded", expectedStatus: "satisfied" },
    { label: "false", value: false, expectedState: "invalid", expectedStatus: "legacy_grandfather_field" },
    { label: "true", value: true, expectedState: "invalid", expectedStatus: "legacy_grandfather_field" },
    {
      label: "object",
      value: {
        from_migration: "rubric-mandatory.yaml",
        applied_at: "2026-04-17T08:00:05.000Z",
        actor: "review-runner-context-test",
      },
      expectedState: "invalid",
      expectedStatus: "legacy_grandfather_field",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const { repoRoot, runDir, runId } = createRunFixture();
      const fixture = createEnforcementFixture({
        repoRoot,
        runId,
        state: "loaded",
        anchorOverrides: entry.value === undefined
          ? {}
          : { rubric_grandfathered: entry.value },
      });
      const result = loadRubricFromRunDir(runDir, {
        run_id: runId,
        anchor: fixture.anchor,
      });

      assert.equal(result.state, entry.expectedState);
      assert.equal(result.status, entry.expectedStatus);
      if (entry.expectedState === "loaded") {
        assert.equal(result.warning, null);
      } else {
        assert.match(result.warning, /anchor\.rubric_grandfathered is no longer supported/);
        assert.match(result.warning, /close-run\.js/);
      }
    });
  }
});

test("context/loadRubricFromRunDir classifies a symlinked rubric as invalid", () => {
  const { runDir, runId } = createRunFixture();
  const siblingTarget = path.join(runDir, "rubric-copy.yaml");
  fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: sibling\n", "utf-8");
  fs.symlinkSync(siblingTarget, path.join(runDir, "rubric.yaml"));

  const result = loadRubricFromRunDir(runDir, {
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml" },
  });

  assert.equal(result.state, "invalid");
  assert.equal(result.status, "symlink_escape");
  assert.match(result.warning, /\[rubric invalid\]/i);
  assert.match(result.warning, /must not be a symlink/i);
});

test("context/loadRubricFromRunDir classifies a malformed rubric path as invalid", () => {
  const { runDir, runId } = createRunFixture();
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: malformed\n", "utf-8");

  const result = loadRubricFromRunDir(runDir, {
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml/child" },
  });

  assert.equal(result.state, "invalid");
  assert.equal(result.status, "unreadable");
  assert.match(result.warning, /\[rubric invalid\]/i);
});

test("context/loadProjectConventions returns empty when .gitignore is missing and omits the prompt section", () => {
  const { repoRoot } = createRunFixture();
  assert.equal(loadProjectConventions(repoRoot), "");
  const prompt = buildPrompt({
    round: 1, prNumber: 246, branch: "issue-246", issueNumber: 246, doneCriteria: "# Done Criteria\n", doneCriteriaSource: "github-issue",
    diffText: "diff --git a/a.js b/a.js\n", reviewRepoPath: repoRoot, runDir: null, rubricLoad: { warning: null, content: null },
  });
  assert.doesNotMatch(prompt, /## Project Conventions/);
});

test("context/loadProjectConventions truncates .gitignore at 2KB with marker", () => {
  const { repoRoot } = createRunFixture();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "a".repeat(2050), "utf-8");
  assert.equal(loadProjectConventions(repoRoot), `${"a".repeat(2048)}\n# ...truncated at 2KB`);
});

test("context/loadProjectConventions ignores symlinked .gitignore escaping the repo root", () => {
  const { repoRoot } = createRunFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-outside-"));
  fs.writeFileSync(path.join(outside, "escaped.gitignore"), "*.g.dart\n", "utf-8");
  fs.symlinkSync(path.join(outside, "escaped.gitignore"), path.join(repoRoot, ".gitignore"));
  assert.equal(loadProjectConventions(repoRoot), "");
});

test("context/loadProjectConventions content is injected into buildPrompt", () => {
  const { repoRoot } = createRunFixture();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "*.g.dart\nbuild/\n", "utf-8");
  const prompt = buildPrompt({
    round: 1, prNumber: 246, branch: "issue-246", issueNumber: 246, doneCriteria: "# Done Criteria\n", doneCriteriaSource: "github-issue",
    diffText: "diff --git a/a.js b/a.js\n", reviewRepoPath: repoRoot, runDir: null, rubricLoad: { warning: null, content: null },
  });
  assert.match(prompt, /## Project Conventions/);
  assert.match(prompt, /Do not flag violations of these as issues/);
  assert.match(prompt, /\*\.g\.dart\nbuild\//);
});

test("context/parseRemoteHost preserves the origin parsing matrix", async (t) => {
  const cases = [
    ["https origin", "https://github.example.com/acme/repo.git", "github.example.com"],
    ["ssh scp origin", "git@github.example.com:acme/repo.git", "github.example.com"],
    ["ssh without user", "github.example.com:acme/repo.git", "github.example.com"],
    ["ssh URL origin", "ssh://git@github.example.com/acme/repo.git", "github.example.com"],
    ["windows local path", "C:/Users/sjlee/repo", null],
    ["malformed hostname", "https://bad host/acme/repo.git", null],
  ];

  for (const [label, input, expected] of cases) {
    await t.test(label, () => {
      assert.equal(parseRemoteHost(input), expected);
    });
  }
});
