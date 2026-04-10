const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readManifest } = require("../../relay-dispatch/scripts/relay-manifest");
const {
  acceptProposal,
  answerQuestion,
  clarify,
  editProposal,
  getRequestPath,
  propose,
  readRequestEvents,
  persistRequestContract,
  readRequestArtifact,
  structure,
} = require("./relay-request");

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

function createReadiness(overrides = {}) {
  return {
    clarity: "high",
    granularity: "single_task",
    dependency: "internal",
    verifiability: "high",
    risk: "medium",
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
  assert.equal(requestArtifact.data.leaf_id, "leaf-01");
  assert.equal(requestArtifact.data.next_action, "relay_plan");
  assert.equal(requestArtifact.data.readiness, undefined);
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
  assert.equal(result.nextAction, "relay_plan");
  assert.equal(result.readiness, null);
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

test("persistRequestContract stores readiness dimensions in request frontmatter when provided", () => {
  const { repoRoot } = setupRepo();
  const readiness = createReadiness({ risk: "low" });

  const result = persistRequestContract(repoRoot, createContract({ readiness }));
  const requestArtifact = readRequestArtifact(result.requestPath);

  assert.deepEqual(requestArtifact.data.readiness, readiness);
  assert.deepEqual(result.readiness, readiness);
});

test("persistRequestContract stores readiness dimensions from handoff.readiness", () => {
  const { repoRoot } = setupRepo();
  const readiness = createReadiness({ clarity: "medium" });

  const result = persistRequestContract(repoRoot, createContract({
    handoff: {
      ...createContract().handoff,
      readiness,
    },
  }));
  const requestArtifact = readRequestArtifact(result.requestPath);

  assert.deepEqual(requestArtifact.data.readiness, readiness);
  assert.deepEqual(result.readiness, readiness);
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

test("preflight helpers bootstrap a non-ready request artifact before relay-ready persistence", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409050505000";
  const readiness = createReadiness({ dependency: "external" });

  const proposal = propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: createContract().request_text,
    readiness,
    proposal_summary: "Keep the work as a single auth redirect leaf.",
    proposal_text: "A. Update the guard\nB. Add redirect tests\nC. Free text",
    response_options: ["A", "B", "C + free text"],
  });
  assert.equal(proposal.event, "proposal_presented");
  assert.equal(proposal.leaf_id, null);

  const question = clarify(repoRoot, requestId, {
    question_text: "Should guest deep links still route to /login?",
    response_options: ["A. Yes", "B. No", "C. Other"],
  });
  assert.equal(question.event, "question_asked");
  assert.equal(question.leaf_id, null);

  const structured = structure(repoRoot, requestId, {
    proposal_summary: "Restructure the intake around one guard change plus tests.",
    proposal_kind: "structure",
    structure_kind: "decompose",
  });
  assert.equal(structured.event, "proposal_presented");
  assert.equal(structured.leaf_id, null);

  const requestArtifact = readRequestArtifact(getRequestPath(repoRoot, requestId));
  assert.equal(requestArtifact.data.state, "intake");
  assert.equal(requestArtifact.data.leaf_id, undefined);
  assert.equal(requestArtifact.data.next_action, "await_proposal_response");
  assert.equal(requestArtifact.data.paths.handoff, undefined);
  assert.deepEqual(requestArtifact.data.readiness, readiness);
  assert.equal(
    fs.readFileSync(requestArtifact.data.paths.raw_request, "utf-8"),
    `${createContract().request_text}\n`
  );

  const preflightEvents = readRequestEvents(repoRoot, requestId);
  assert.deepEqual(
    preflightEvents.map((event) => event.event),
    ["request_persisted", "proposal_presented", "question_asked", "proposal_presented"]
  );

  const intake = persistRequestContract(repoRoot, createContract(), { requestId });
  const promotedArtifact = readRequestArtifact(intake.requestPath);

  assert.equal(promotedArtifact.data.state, "relay_ready");
  assert.equal(promotedArtifact.data.leaf_id, "leaf-01");
  assert.equal(promotedArtifact.data.next_action, "relay_plan");
  assert.equal(promotedArtifact.data.paths.handoff, intake.handoffPath);
  assert.deepEqual(promotedArtifact.data.readiness, readiness);
  assert.deepEqual(intake.readiness, readiness);

  const events = readRequestEvents(repoRoot, requestId);
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "request_persisted",
      "proposal_presented",
      "question_asked",
      "proposal_presented",
      "relay_ready_handoff_persisted",
    ]
  );
});

test("preflight actions append typed events and update next_action without a second state machine", () => {
  const { repoRoot } = setupRepo();
  const intake = persistRequestContract(repoRoot, createContract());

  const proposal = propose(repoRoot, intake.requestId, {
    proposal_summary: "Keep the work as a single auth redirect leaf.",
    proposal_text: "A. Update the guard\nB. Add redirect tests\nC. Free text",
    response_options: ["A", "B", "C + free text"],
  });
  assert.equal(proposal.event, "proposal_presented");
  assert.equal(proposal.request_id, intake.requestId);
  assert.equal(proposal.leaf_id, intake.leafId);
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "await_proposal_response");

  const question = clarify(repoRoot, intake.requestId, {
    question_text: "Should guest deep links still route to /login?",
    response_options: ["A. Yes", "B. No", "C. Other"],
  });
  assert.equal(question.event, "question_asked");
  assert.deepEqual(question.response_options, ["A. Yes", "B. No", "C. Other"]);
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "await_answer");

  const structured = structure(repoRoot, intake.requestId, {
    proposal_summary: "Restructure the handoff around one guard change plus tests.",
    proposal_kind: "structure",
    structure_kind: "decompose",
  });
  assert.equal(structured.event, "proposal_presented");
  assert.equal(structured.structure_kind, "decompose");
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "await_proposal_response");

  const structuredEdit = structure(repoRoot, intake.requestId, {
    proposal_summary: "Keep one leaf but tighten the handoff wording.",
    edit_summary: "Fold the test wording into the main proposal summary.",
    edits_existing_proposal: true,
    structure_kind: "restructure",
  });
  assert.equal(structuredEdit.event, "proposal_edited");
  assert.equal(structuredEdit.edit_summary, "Fold the test wording into the main proposal summary.");
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "await_proposal_response");

  const events = readRequestEvents(repoRoot, intake.requestId);
  assert.deepEqual(
    events.slice(-4).map((event) => event.event),
    ["proposal_presented", "question_asked", "proposal_presented", "proposal_edited"]
  );
});

test("interaction event helpers persist portable fields for answers, edits, and acceptance", () => {
  const { repoRoot } = setupRepo();
  const intake = persistRequestContract(repoRoot, createContract());

  const answered = answerQuestion(repoRoot, intake.requestId, {
    question_text: "Should guest deep links still route to /login?",
    answer_text: "A. Yes, keep the guest login route as-is.",
    answer_choice: "A",
  });
  assert.equal(answered.event, "question_answered");
  assert.equal(answered.question_text, "Should guest deep links still route to /login?");
  assert.equal(answered.answer_text, "A. Yes, keep the guest login route as-is.");
  assert.equal(answered.answer_choice, "A");
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "review_answer");

  const edited = editProposal(repoRoot, intake.requestId, {
    proposal_summary: "Keep one relay leaf for the redirect loop fix.",
    edit_summary: "Add the cookie-session assumption to the proposal text.",
    proposal_text: "Scope the work to the redirect guard and add tests.",
  });
  assert.equal(edited.event, "proposal_edited");
  assert.equal(edited.edit_summary, "Add the cookie-session assumption to the proposal text.");
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "review_proposal_edits");

  const accepted = acceptProposal(repoRoot, intake.requestId, {
    proposal_summary: "Keep one relay leaf for the redirect loop fix.",
    acceptance_note: "Ship the single-leaf handoff.",
    accepted_with_edits: true,
  });
  assert.equal(accepted.event, "proposal_accepted");
  assert.equal(accepted.acceptance_note, "Ship the single-leaf handoff.");
  assert.equal(accepted.accepted_with_edits, true);
  assert.equal(readRequestArtifact(intake.requestPath).data.next_action, "relay_plan");

  const events = readRequestEvents(repoRoot, intake.requestId);
  assert.deepEqual(
    events.slice(-3).map((event) => event.event),
    ["question_answered", "proposal_edited", "proposal_accepted"]
  );
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
