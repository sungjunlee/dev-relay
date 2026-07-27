const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureRunLayout } = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const {
  createEnforcementFixture,
  DEFAULT_ENFORCEMENT_RUBRIC,
} = require("../../relay-dispatch/scripts/test-support");
const {
  GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES,
  loadDiff,
  loadPrReviewSignals,
  loadProjectConventions,
  loadRetainedWorktreeDiff,
  parseRemoteHost,
  resolveIssueNumber,
} = require("../../../skills/relay-review/scripts/review-runner/context");
const {
  DEFAULT_EXEC_MAX_BUFFER_BYTES,
} = require("../../../skills/relay-dispatch/scripts/exec");
const {
  loadRubricFromRunDir,
} = require("../../../skills/relay-dispatch/scripts/manifest/rubric");
const { buildPrompt } = require("../../../skills/relay-review/scripts/review-runner/prompt");
const {
  writeRoundArtifacts,
} = require("../../../skills/relay-review/scripts/review-runner/round-artifacts");
const { withFakeGh } = require("../fixtures/fake-gh");

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

function buildLargePatch(filePath, minimumBytes) {
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${filePath}`,
  ];
  const line = `+${"x".repeat(79)}\n`;
  const lineCount = Math.ceil((minimumBytes - header.join("\n").length - 64) / line.length);
  return [
    ...header,
    `@@ -0,0 +1,${lineCount} @@`,
    line.repeat(lineCount).trimEnd(),
  ].join("\n");
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function writeOverflowStub(dir, name, gitAware = false) {
  const stubPath = path.join(dir, name);
  fs.writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env node",
      gitAware
        ? 'if (process.argv.includes("merge-base")) process.stdout.write("a".repeat(40));'
        : "",
      gitAware
        ? 'else process.stdout.write("x".repeat(' + (DEFAULT_EXEC_MAX_BUFFER_BYTES + 1024) + "));"
        : 'process.stdout.write("x".repeat(' + (DEFAULT_EXEC_MAX_BUFFER_BYTES + 1024) + "));",
    ].filter(Boolean).join("\n"),
    "utf-8"
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function initLargeDiffRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-large-diff-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", "issue-1091"], { cwd: repoRoot, stdio: "pipe" });
  const largeText = `${"generated review diff payload\n".repeat(
    Math.ceil((GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES + 4096) / 30)
  )}`;
  fs.writeFileSync(path.join(repoRoot, "large.txt"), largeText, "utf-8");
  execFileSync("git", ["add", "large.txt"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "large change"], { cwd: repoRoot, stdio: "pipe" });
  return repoRoot;
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

test("context/loadPrReviewSignals includes inline review threads", () => {
  withFakeGh({
    statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }],
    reviews: [{ author: { login: "reviewer" }, state: "COMMENTED", body: "see inline" }],
    comments: [{ author: { login: "bot" }, body: "top level" }],
    reviewThreads: [{
      path: "skills/relay-review/scripts/review-runner.js",
      line: 42,
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [{
          author: { login: "reviewer" },
          body: "blocking inline feedback",
        }],
      },
    }],
  }, (repoRoot) => {
    const signals = loadPrReviewSignals(repoRoot, 123);

    assert.equal(signals.status, "loaded");
    assert.deepEqual(signals.checks, ["- test: SUCCESS"]);
    assert.match(signals.reviewThreads[0], /unresolved skills\/relay-review\/scripts\/review-runner\.js:42 reviewer/);
    assert.match(signals.reviewThreads[0], /blocking inline feedback/);
  });
});

test("context/loadPrReviewSignals paginates inline review threads", () => {
  withFakeGh({
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    reviewThreadPages: [
      {
        nodes: [{
          path: "first.js",
          line: 1,
          isResolved: false,
          comments: { nodes: [{ author: { login: "reviewer" }, body: "first page" }] },
        }],
      },
      {
        nodes: [{
          path: "second.js",
          line: 2,
          isResolved: false,
          comments: { nodes: [{ author: { login: "reviewer" }, body: "second page" }] },
        }],
      },
    ],
  }, (repoRoot) => {
    const signals = loadPrReviewSignals(repoRoot, 123);

    assert.equal(signals.status, "loaded");
    assert.equal(signals.reviewThreads.length, 2);
    assert.match(signals.reviewThreads[0], /first\.js:1/);
    assert.match(signals.reviewThreads[1], /second\.js:2/);
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

test("context/loadRetainedWorktreeDiff builds an internal diff from retained worktree", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-internal-diff-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", "issue-42"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\nchanged\n", "utf-8");
  execFileSync("git", ["commit", "-am", "change"], { cwd: repoRoot, stdio: "pipe" });

  const diff = loadRetainedWorktreeDiff(repoRoot, { git: { base_branch: "main" } });
  assert.match(diff, /\+changed/);
});

test("context/generated diff threshold stays strictly below the shared read ceiling", () => {
  assert.ok(DEFAULT_EXEC_MAX_BUFFER_BYTES > GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES);
});

test("context/loadDiff persists a degraded internal git diff as the round diff artifact", () => {
  const repoRoot = initLargeDiffRepo();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-large-round-"));
  const doneCriteriaFile = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(doneCriteriaFile, "# Done Criteria\n\n- Review the large change.\n", "utf-8");

  const artifacts = writeRoundArtifacts({
    branch: "issue-1091",
    data: {
      git: { base_branch: "main" },
      run_id: "issue-1091-large-diff",
    },
    diffFile: null,
    doneCriteriaFile,
    internalReview: true,
    issueNumber: 1091,
    prNumber: null,
    reviewRepoPath: repoRoot,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.match(artifacts.diffText, /generated diff degraded: observed \d+ bytes/);
  assert.match(artifacts.diffText, new RegExp(`threshold ${GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES} bytes`));
  assert.match(artifacts.diffText, /# --stat summary \(full patches omitted\)/);
  assert.match(artifacts.diffText, /large\.txt/);
  assert.match(artifacts.diffText, /# Files with omitted patches\n- large\.txt/);
  assert.doesNotMatch(artifacts.diffText, /generated review diff payload/);
  assert.equal(
    fs.readFileSync(artifacts.diffPath, "utf-8"),
    `${artifacts.diffText}\n`
  );
});

test("context/loadDiff degrades an oversized gh pr diff", () => {
  const largePatch = buildLargePatch(
    "public-large.txt",
    GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES + 1
  );
  assert.ok(Buffer.byteLength(largePatch, "utf-8") > GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES);

  withFakeGh({ diff: largePatch }, (repoRoot) => {
    const diff = loadDiff(repoRoot, 1091, null);
    assert.match(diff, /generated diff degraded: observed \d+ bytes/);
    assert.match(diff, /source gh pr diff #1091/);
    assert.match(diff, /public-large\.txt/);
    assert.match(diff, /# Files with omitted patches\n- public-large\.txt/);
    assert.doesNotMatch(diff, new RegExp(`\\+${"x".repeat(79)}`));
  });
});

test("context/loadDiff passes a generated diff just under the threshold byte-identical", () => {
  const expected = "x".repeat(GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES - 1);
  withFakeGh({ diff: expected }, (repoRoot) => {
    assert.equal(loadDiff(repoRoot, 1091, null), expected);
  });
});

test("context/loadDiff leaves an oversized --diff-file unguarded", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-diff-file-"));
  const diffPath = path.join(repoRoot, "curated.patch");
  const expected = "z".repeat(GENERATED_DIFF_DEGRADE_THRESHOLD_BYTES + 1);
  fs.writeFileSync(diffPath, expected, "utf-8");

  assert.equal(
    loadDiff(repoRoot, null, diffPath, {
      internalReview: true,
      manifestData: {},
      reviewRepoPath: null,
    }),
    expected
  );
});

test("context/loadDiff replaces generated ENOBUFS errors with actionable size context", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-overflow-"));
  const ghStub = writeOverflowStub(dir, "gh-overflow.js");
  const gitStub = writeOverflowStub(dir, "git-overflow.js", true);
  const expectedMessage = new RegExp(
    `observed_size>=\\d+ bytes, maxBuffer_limit=${DEFAULT_EXEC_MAX_BUFFER_BYTES} bytes\\..*--diff-file`
  );

  await t.test("gh pr diff", () => {
    assert.throws(
      () => withEnv("RELAY_GH_BIN", ghStub, () => loadDiff(dir, 1091, null)),
      (error) => expectedMessage.test(error.message) && !/^Error: spawnSync gh ENOBUFS$/.test(error.message)
    );
  });

  await t.test("internal git diff", () => {
    assert.throws(
      () => withEnv("RELAY_GIT_BIN", gitStub, () => loadDiff(dir, null, null, {
        internalReview: true,
        manifestData: { git: { base_branch: "main" } },
        reviewRepoPath: dir,
      })),
      (error) => expectedMessage.test(error.message) && !/^Error: spawnSync git ENOBUFS$/.test(error.message)
    );
  });
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
