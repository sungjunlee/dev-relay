const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readManifest } = require("../../relay-dispatch/scripts/relay-manifest");
const { readRequestEvents, persistRequestContract, readRequestArtifact } = require("./relay-request");

const PERSIST_SCRIPT = path.join(__dirname, "persist-request.js");
const DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const REVIEW_RUNNER_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-intake-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Intake Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-intake@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  process.env.RELAY_HOME = relayHome;
  return { repoRoot, relayHome };
}

function createContract(overrides = {}) {
  return {
    source: { kind: "raw_text" },
    request_text: "Fix the login redirect loop for authenticated users.",
    handoff: {
      leaf_id: "leaf-01",
      title: "Fix login redirect loop",
      goal: "Stop authenticated users from bouncing back to /login",
      in_scope: ["Update the redirect guard", "Cover both auth states"],
      out_of_scope: ["Redesigning the login page"],
      assumptions: ["Session state remains cookie-based"],
      done_criteria_markdown: "# Done Criteria\n\n- Authenticated users stay off /login\n- Guests still reach /login\n",
      escalation_conditions: ["Auth state source is unclear"],
    },
    ...overrides,
  };
}

function writeFakeCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(cwd + "/intake.txt", "ok\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "intake.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake intake commit"], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
}

test("persistRequestContract writes request artifact, relay-ready handoff, done criteria snapshot, and events", () => {
  const { repoRoot } = setupRepo();

  const result = persistRequestContract(repoRoot, createContract());

  assert.ok(fs.existsSync(result.requestPath));
  assert.ok(fs.existsSync(result.rawRequestPath));
  assert.ok(fs.existsSync(result.handoffPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));

  const requestArtifact = readRequestArtifact(result.requestPath);
  assert.equal(requestArtifact.data.request_id, result.requestId);
  assert.equal(requestArtifact.data.state, "relay_ready");
  assert.equal(requestArtifact.data.source.kind, "raw_text");
  assert.equal(requestArtifact.data.paths.handoff, result.handoffPath);
  assert.match(requestArtifact.body, /Relay Intake Request/);
  assert.match(requestArtifact.body, /leaf-01/);
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/relay-ready/leaf-01\\.md`));
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/done-criteria/leaf-01\\.md`));

  const handoffArtifact = readRequestArtifact(result.handoffPath);
  assert.equal(handoffArtifact.data.request_id, result.requestId);
  assert.equal(handoffArtifact.data.leaf_id, "leaf-01");
  assert.equal(handoffArtifact.data.done_criteria_path, result.doneCriteriaPath);
  assert.match(handoffArtifact.body, /In Scope/);
  assert.match(handoffArtifact.body, /Update the redirect guard/);

  const doneCriteria = fs.readFileSync(result.doneCriteriaPath, "utf-8");
  assert.match(doneCriteria, /Authenticated users stay off \/login/);

  const events = readRequestEvents(repoRoot, result.requestId);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "request_persisted");
  assert.equal(events[1].event, "relay_ready_handoff_persisted");
  assert.equal(events[1].leaf_id, "leaf-01");
});

test("persist-request CLI persists the single-leaf request bundle", () => {
  const { repoRoot } = setupRepo();
  const contractPath = path.join(repoRoot, "contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify(createContract(), null, 2)}\n`, "utf-8");

  const stdout = execFileSync("node", [
    PERSIST_SCRIPT,
    "--repo", repoRoot,
    "--contract-file", contractPath,
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.ok(result.requestId);
  assert.equal(result.leafId, "leaf-01");
  assert.ok(fs.existsSync(result.requestPath));
  assert.ok(fs.existsSync(result.handoffPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));
});

test("persistRequestContract rejects multi-leaf handoff input with an explicit #129 TODO", () => {
  const { repoRoot } = setupRepo();
  const contract = createContract({
    handoff: undefined,
    handoffs: [
      createContract().handoff,
      { ...createContract().handoff, leaf_id: "leaf-02", title: "Second leaf" },
    ],
  });

  assert.throws(
    () => persistRequestContract(repoRoot, contract),
    /TODO\(#129\): multi-leaf relay-intake handoff is not implemented yet/
  );
});

test("persistRequestContract rejects request_id collisions before overwriting frozen artifacts", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409040404000";
  const first = persistRequestContract(repoRoot, createContract(), { requestId });
  const originalDoneCriteria = fs.readFileSync(first.doneCriteriaPath, "utf-8");

  assert.throws(
    () => persistRequestContract(repoRoot, createContract({
      request_text: "A different raw request that must not replace the original.",
      handoff: {
        ...createContract().handoff,
        done_criteria_markdown: "# Done Criteria\n\n- Replacement snapshot that must never land\n",
      },
    }), { requestId }),
    /already exists; refusing to overwrite existing request artifact/
  );

  assert.equal(fs.readFileSync(first.doneCriteriaPath, "utf-8"), originalDoneCriteria);
  assert.equal(readRequestEvents(repoRoot, requestId).length, 2);
});

test("raw request can flow through intake persistence, dispatch linkage, and review prepare-only", () => {
  const { repoRoot, relayHome } = setupRepo();
  const intake = persistRequestContract(repoRoot, createContract());
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    PATH: `${binDir}:${process.env.PATH}`,
  };

  const dispatchStdout = execFileSync("node", [
    DISPATCH_SCRIPT,
    repoRoot,
    "-b", "issue-127-raw-intake",
    "--prompt-file", intake.handoffPath,
    "--request-id", intake.requestId,
    "--leaf-id", intake.leafId,
    "--done-criteria-file", intake.doneCriteriaPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  const dispatchResult = JSON.parse(dispatchStdout);
  assert.equal(dispatchResult.runState, "review_pending");

  const manifest = readManifest(dispatchResult.manifestPath).data;
  const dispatchPrompt = fs.readFileSync(path.join(dispatchResult.runDir, "dispatch-prompt.md"), "utf-8");
  assert.equal(manifest.source.request_id, intake.requestId);
  assert.equal(manifest.source.leaf_id, intake.leafId);
  assert.equal(manifest.anchor.done_criteria_path, intake.doneCriteriaPath);
  assert.equal(manifest.anchor.done_criteria_source, "request_snapshot");
  assert.match(dispatchPrompt, /Fix login redirect loop/);

  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(diffPath, "diff --git a/intake.txt b/intake.txt\n+ok\n", "utf-8");

  const reviewStdout = execFileSync("node", [
    REVIEW_RUNNER_SCRIPT,
    "--repo", repoRoot,
    "--run-id", dispatchResult.runId,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  const reviewResult = JSON.parse(reviewStdout);
  const preparedDoneCriteria = fs.readFileSync(reviewResult.doneCriteriaPath, "utf-8");
  const promptText = fs.readFileSync(reviewResult.promptPath, "utf-8");

  assert.match(preparedDoneCriteria, /Authenticated users stay off \/login/);
  assert.match(promptText, /source="request_snapshot"/);
});
