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
  getRequestsDir,
  getRequestPath,
  normalizeSingleLeafContract,
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

function createMultiLeafContract(overrides = {}) {
  const baseHandoff = createContract().handoff;
  return {
    source: { kind: "raw_text" },
    request_text: "Fix the login redirect loop and backfill auth redirect coverage.",
    handoffs: [
      {
        ...baseHandoff,
        leaf_id: "leaf-02",
        title: "Backfill auth redirect coverage",
        goal: "Add regression coverage for authenticated and guest redirects",
        order: 2,
        depends_on: ["leaf-01"],
        in_scope: ["Add redirect regression coverage", "Cover guest and authenticated states"],
        out_of_scope: ["Changing auth providers"],
        assumptions: ["The existing auth test harness can simulate both states"],
        done_criteria_markdown: "# Done Criteria\n\n- Redirect regressions are covered for guests and authenticated users\n",
        escalation_conditions: ["The auth test harness cannot simulate both states"],
      },
      {
        ...baseHandoff,
        leaf_id: "leaf-01",
        title: "Fix login redirect loop",
        goal: "Stop authenticated users from bouncing back to /login",
        order: 1,
        depends_on: [],
        done_criteria_markdown: "# Done Criteria\n\n- Authenticated users stay off /login\n- Guests still reach /login\n",
      },
    ],
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

function chooseRelayRoute({
  sourceKind,
  leafCount,
  hasStableReviewAnchor,
  requiresClarification = false,
  requiresDecomposition = false,
}) {
  return sourceKind !== "raw_text"
    && leafCount === 1
    && hasStableReviewAnchor
    && !requiresClarification
    && !requiresDecomposition
    ? "bypass_intake"
    : "invoke_intake";
}

function invokeRelayFrontDoor(repoRoot, {
  contract,
  hasStableReviewAnchor,
  requiresClarification = false,
  requiresDecomposition = false,
  requestId,
}) {
  const leafCount = Array.isArray(contract.handoffs)
    ? contract.handoffs.length
    : (contract.handoff ? 1 : 0);
  const route = chooseRelayRoute({
    sourceKind: contract.source?.kind || "raw_text",
    leafCount,
    hasStableReviewAnchor,
    requiresClarification,
    requiresDecomposition,
  });
  const downstreamChain = route === "invoke_intake"
    ? ["relay-intake", "relay-plan", "relay-dispatch"]
    : ["relay-plan", "relay-dispatch"];

  if (route === "bypass_intake") {
    const normalized = normalizeSingleLeafContract(contract);
    return {
      route,
      downstreamChain,
      sourceKind: normalized.source.kind,
      readiness: normalized.readiness || null,
      leafId: normalized.handoff.leafId,
      title: normalized.handoff.title,
      reviewAnchorSource: normalized.source.kind,
    };
  }

  return {
    route,
    downstreamChain,
    ...persistRequestContract(repoRoot, contract, requestId ? { requestId } : {}),
  };
}

function proposeDelegateFallback(repoRoot, requestId, {
  requestText,
  hostCapabilities = {},
}) {
  if (hostCapabilities.gstack || hostCapabilities.superpowers) {
    throw new Error("delegate fallback only applies when gstack/superpowers are unavailable");
  }

  return {
    fallback: "portable_plain_text",
    ...structure(repoRoot, requestId, {
      source_kind: "raw_text",
      request_text: requestText,
      proposal_summary: "Delegate the shared middleware change and keep the local tests here.",
      proposal_kind: "structure",
      proposal_text: "A. Delegate middleware ownership\nB. Keep the work local\nC. Other + free text",
      response_options: ["A. Delegate", "B. Keep local", "C. Other + free text"],
      structure_kind: "delegate",
      reason: "gstack/superpowers are unavailable, so fall back to the portable plain-text protocol.",
    }),
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

function readRequest(repoRoot, requestId) {
  return readRequestArtifact(getRequestPath(repoRoot, requestId));
}

function readEventNames(repoRoot, requestId) {
  return readRequestEvents(repoRoot, requestId).map((event) => event.event);
}

test("persistRequestContract writes request artifact, relay-ready handoff, done criteria snapshot, and events", () => {
  const { repoRoot } = setupRepo();

  const result = persistRequestContract(repoRoot, createContract());

  assert.ok(fs.existsSync(result.requestPath));
  assert.ok(fs.existsSync(result.rawRequestPath));
  assert.ok(fs.existsSync(result.handoffPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));
  assert.equal(result.leafCount, 1);
  assert.deepEqual(result.leafIds, ["leaf-01"]);
  assert.deepEqual(result.handoffPaths, [result.handoffPath]);
  assert.deepEqual(result.doneCriteriaPaths, [result.doneCriteriaPath]);

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
  assert.equal(handoffArtifact.data.order, 1);
  assert.deepEqual(handoffArtifact.data.depends_on, []);
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

test("persist-request CLI returns multi-leaf paths in execution order", () => {
  const { repoRoot } = setupRepo();
  const contractPath = path.join(repoRoot, "multi-contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify(createMultiLeafContract(), null, 2)}\n`, "utf-8");

  const stdout = execFileSync("node", [
    PERSIST_SCRIPT,
    "--repo", repoRoot,
    "--contract-file", contractPath,
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.leafCount, 2);
  assert.deepEqual(result.leafIds, ["leaf-01", "leaf-02"]);
  assert.equal(result.handoffPath, undefined);
  assert.equal(result.doneCriteriaPath, undefined);
  assert.equal(result.handoffPaths.length, 2);
  assert.equal(result.doneCriteriaPaths.length, 2);
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

test("persistRequestContract persists multi-leaf handoffs with ordering, dependencies, and per-leaf artifacts", () => {
  const { repoRoot } = setupRepo();
  const result = persistRequestContract(repoRoot, createMultiLeafContract());

  assert.equal(result.leafCount, 2);
  assert.equal(result.leafId, undefined);
  assert.equal(result.handoffPath, undefined);
  assert.equal(result.doneCriteriaPath, undefined);
  assert.deepEqual(result.leafIds, ["leaf-01", "leaf-02"]);
  assert.equal(result.handoffPaths.length, 2);
  assert.equal(result.doneCriteriaPaths.length, 2);
  for (const artifactPath of [...result.handoffPaths, ...result.doneCriteriaPaths]) {
    assert.ok(fs.existsSync(artifactPath));
  }

  const requestArtifact = readRequestArtifact(result.requestPath);
  assert.equal(requestArtifact.data.request_id, result.requestId);
  assert.equal(requestArtifact.data.state, "relay_ready");
  assert.equal(requestArtifact.data.leaf_id, undefined);
  assert.equal(requestArtifact.data.leaf_count, 2);
  assert.deepEqual(requestArtifact.data.paths.handoffs, result.handoffPaths);
  assert.deepEqual(requestArtifact.data.paths.done_criteria, result.doneCriteriaPaths);
  assert.equal(requestArtifact.data.paths.handoff, undefined);
  assert.deepEqual(requestArtifact.data.decomposition.leaf_order, ["leaf-01", "leaf-02"]);
  assert.deepEqual(requestArtifact.data.decomposition.dependencies, {
    "leaf-02": ["leaf-01"],
  });
  assert.match(requestArtifact.body, /leaf-01 \[order 1\] Fix login redirect loop/);
  assert.match(requestArtifact.body, /leaf-02 \[order 2\] Backfill auth redirect coverage/);
  assert.match(requestArtifact.body, /depends_on: leaf-01/);
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/relay-ready/leaf-01\\.md`));
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/relay-ready/leaf-02\\.md`));
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/done-criteria/leaf-01\\.md`));
  assert.match(requestArtifact.body, new RegExp(`${result.requestId}/done-criteria/leaf-02\\.md`));

  const firstHandoff = readRequestArtifact(result.handoffPaths[0]);
  assert.equal(firstHandoff.data.leaf_id, "leaf-01");
  assert.equal(firstHandoff.data.order, 1);
  assert.deepEqual(firstHandoff.data.depends_on, []);
  assert.equal(firstHandoff.data.done_criteria_path, result.doneCriteriaPaths[0]);

  const secondHandoff = readRequestArtifact(result.handoffPaths[1]);
  assert.equal(secondHandoff.data.leaf_id, "leaf-02");
  assert.equal(secondHandoff.data.order, 2);
  assert.deepEqual(secondHandoff.data.depends_on, ["leaf-01"]);
  assert.equal(secondHandoff.data.done_criteria_path, result.doneCriteriaPaths[1]);

  const firstDoneCriteria = fs.readFileSync(result.doneCriteriaPaths[0], "utf-8");
  const secondDoneCriteria = fs.readFileSync(result.doneCriteriaPaths[1], "utf-8");
  assert.match(firstDoneCriteria, /Authenticated users stay off \/login/);
  assert.match(secondDoneCriteria, /Redirect regressions are covered/);

  const events = readRequestEvents(repoRoot, result.requestId);
  assert.equal(events.length, 3);
  assert.equal(events[0].event, "request_persisted");
  assert.deepEqual(
    events.slice(1).map((event) => event.leaf_id),
    ["leaf-01", "leaf-02"]
  );
});

test("scenario: directly relayable raw request persists immediately without preflight interactions", () => {
  const { repoRoot } = setupRepo();
  const readiness = createReadiness({ risk: "low" });

  const result = persistRequestContract(repoRoot, createContract({ readiness }));
  const requestArtifact = readRequestArtifact(result.requestPath);

  assert.equal(result.leafCount, 1);
  assert.equal(requestArtifact.data.state, "relay_ready");
  assert.equal(requestArtifact.data.next_action, "relay_plan");
  assert.equal(requestArtifact.data.source.kind, "raw_text");
  assert.deepEqual(requestArtifact.data.readiness, readiness);
  assert.deepEqual(
    readEventNames(repoRoot, result.requestId),
    ["request_persisted", "relay_ready_handoff_persisted"]
  );
});

test("scenario: ambiguous request flows through proposal, clarification, answer, acceptance, and final persistence", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409101010000";
  const requestText = "Fix the auth routing bug around login redirects.";

  propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: requestText,
    proposal_summary: "Shape this into one redirect-focused leaf after clarifying guest behavior.",
    proposal_text: "A. Keep guest deep links on /login\nB. Redirect guests elsewhere\nC. Other + free text",
    response_options: ["A. Keep /login", "B. Redirect elsewhere", "C. Other + free text"],
    reason: "The request is ambiguous about guest deep-link behavior.",
  });
  clarify(repoRoot, requestId, {
    question_text: "Should guest deep links still land on /login?",
    response_options: ["A. Yes", "B. No", "C. Other + free text"],
    reason: "Need one stable review anchor before freezing the handoff.",
  });

  const answered = answerQuestion(repoRoot, requestId, {
    question_text: "Should guest deep links still land on /login?",
    answer_text: "A. Yes, keep guest deep links on /login.",
    answer_choice: "A",
    reason: "Clarified by the requester.",
  });
  assert.equal(answered.event, "question_answered");
  assert.equal(readRequest(repoRoot, requestId).data.next_action, "review_answer");

  const accepted = acceptProposal(repoRoot, requestId, {
    proposal_summary: "Single redirect leaf that keeps guest deep links on /login.",
    acceptance_note: "Proceed with one relay-sized fix.",
    reason: "Clarification resolved the scope.",
  });
  assert.equal(accepted.event, "proposal_accepted");
  assert.equal(readRequest(repoRoot, requestId).data.next_action, "relay_plan");

  const result = persistRequestContract(repoRoot, createContract({
    request_text: requestText,
  }), { requestId });
  const requestArtifact = readRequestArtifact(result.requestPath);

  assert.equal(requestArtifact.data.state, "relay_ready");
  assert.equal(requestArtifact.data.next_action, "relay_plan");
  assert.deepEqual(
    readEventNames(repoRoot, requestId),
    [
      "request_persisted",
      "proposal_presented",
      "question_asked",
      "question_answered",
      "proposal_accepted",
      "relay_ready_handoff_persisted",
    ]
  );
});

test("scenario: oversized request is proposed, decomposed, and accepted before relay-ready persistence", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409111111000";
  const requestText = "Fix auth redirects, add regression coverage, and document the routing rules.";

  propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: requestText,
    proposal_summary: "This is too broad for one relay run; start by proposing a smaller shape.",
    proposal_text: "A. Keep one leaf\nB. Split into multiple leaves\nC. Other + free text",
    response_options: ["A. One leaf", "B. Multiple leaves", "C. Other + free text"],
  });

  const structured = structure(repoRoot, requestId, {
    proposal_summary: "Split the work into a guard fix leaf and a regression coverage leaf.",
    proposal_kind: "structure",
    proposal_text: "Leaf 1 fixes the redirect guard. Leaf 2 adds regression coverage.",
    response_options: ["A. Accept split", "B. Keep one leaf", "C. Other + free text"],
    structure_kind: "decompose",
    reason: "The request is oversized for one relay-sized handoff.",
  });
  assert.equal(structured.event, "proposal_presented");
  assert.equal(structured.structure_kind, "decompose");
  assert.equal(readRequest(repoRoot, requestId).data.next_action, "await_proposal_response");

  const accepted = acceptProposal(repoRoot, requestId, {
    proposal_summary: "Split the oversized request into two ordered relay-ready leaves.",
    acceptance_note: "Use the decomposed shape.",
  });
  assert.equal(accepted.event, "proposal_accepted");

  const requestArtifact = readRequest(repoRoot, requestId);
  assert.equal(requestArtifact.data.state, "intake");
  assert.equal(requestArtifact.data.leaf_count, 0);
  assert.equal(requestArtifact.data.next_action, "relay_plan");
  assert.deepEqual(
    readEventNames(repoRoot, requestId),
    ["request_persisted", "proposal_presented", "proposal_presented", "proposal_accepted"]
  );
});

test("scenario: larger request decomposes into ordered child handoffs", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409121212000";
  const requestText = createMultiLeafContract().request_text;

  structure(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: requestText,
    proposal_summary: "Split the request into an implementation leaf followed by a coverage leaf.",
    proposal_kind: "structure",
    structure_kind: "decompose",
  });
  acceptProposal(repoRoot, requestId, {
    proposal_summary: "Persist two ordered relay-ready leaves.",
    acceptance_note: "Guard fix first, then regression coverage.",
  });

  const result = persistRequestContract(repoRoot, createMultiLeafContract(), { requestId });
  const requestArtifact = readRequestArtifact(result.requestPath);
  const firstLeaf = readRequestArtifact(result.handoffPaths[0]);
  const secondLeaf = readRequestArtifact(result.handoffPaths[1]);

  assert.equal(result.leafCount, 2);
  assert.deepEqual(result.leafIds, ["leaf-01", "leaf-02"]);
  assert.deepEqual(requestArtifact.data.decomposition.leaf_order, ["leaf-01", "leaf-02"]);
  assert.deepEqual(requestArtifact.data.decomposition.dependencies, { "leaf-02": ["leaf-01"] });
  assert.equal(firstLeaf.data.order, 1);
  assert.deepEqual(firstLeaf.data.depends_on, []);
  assert.equal(secondLeaf.data.order, 2);
  assert.deepEqual(secondLeaf.data.depends_on, ["leaf-01"]);
  assert.deepEqual(
    readEventNames(repoRoot, requestId),
    [
      "request_persisted",
      "proposal_presented",
      "proposal_accepted",
      "relay_ready_handoff_persisted",
      "relay_ready_handoff_persisted",
    ]
  );
});

test("scenario: non-issue request freezes done criteria from the handoff rather than GitHub", () => {
  const { repoRoot } = setupRepo();
  const doneCriteriaMarkdown = "# Done Criteria\n\n- Duplicate invite emails stop after resend\n- The resend actor is logged in the audit trail\n";
  const result = persistRequestContract(repoRoot, createContract({
    request_text: "Fix duplicate invite sends when admins resend an invite.",
    handoff: {
      ...createContract().handoff,
      leaf_id: "leaf-invite-01",
      title: "Fix duplicate invite resend notifications",
      goal: "Stop duplicate invite emails when an admin resends an invite",
      in_scope: ["Deduplicate resend notifications", "Log the acting admin"],
      out_of_scope: ["Redesigning the invite email"],
      assumptions: ["The audit log already has an invite resend event type"],
      done_criteria_markdown: doneCriteriaMarkdown,
      escalation_conditions: ["Invite resend ownership is split across services"],
    },
  }));
  const requestArtifact = readRequestArtifact(result.requestPath);
  const handoffArtifact = readRequestArtifact(result.handoffPath);

  assert.equal(requestArtifact.data.source.kind, "raw_text");
  assert.equal(handoffArtifact.data.done_criteria_path, result.doneCriteriaPath);
  assert.equal(fs.readFileSync(result.doneCriteriaPath, "utf-8").trim(), doneCriteriaMarkdown.trim());
  assert.deepEqual(
    readEventNames(repoRoot, result.requestId),
    ["request_persisted", "relay_ready_handoff_persisted"]
  );
});

test("scenario: portable A/B/C plain-text interaction works without host-specific UI widgets", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409131313000";
  const requestText = "Triage the auth redirect work for the next relay run.";
  const proposalChoices = [
    "A. Keep one leaf",
    "B. Split into two leaves",
    "C. Other + free text",
  ];
  const questionChoices = [
    "A. Fix the guard first",
    "B. Add coverage first",
    "C. Other + free text",
  ];

  propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: requestText,
    proposal_summary: "Offer a plain-text proposal even when the host has no widget support.",
    proposal_text: proposalChoices.join("\n"),
    response_options: proposalChoices,
  });
  clarify(repoRoot, requestId, {
    question_text: "Which leaf should land first?",
    response_options: questionChoices,
  });

  const answered = answerQuestion(repoRoot, requestId, {
    question_text: "Which leaf should land first?",
    answer_text: "C. Other: fix the guard first, then add coverage.",
    answer_choice: "C",
  });
  const events = readRequestEvents(repoRoot, requestId);

  assert.deepEqual(events[1].response_options, proposalChoices);
  assert.deepEqual(events[2].response_options, questionChoices);
  assert.equal(answered.answer_choice, "C");
  assert.equal(readRequest(repoRoot, requestId).data.next_action, "review_answer");
});

test("scenario: delegate fallback uses the portable plain-text path when gstack/superpowers are unavailable", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409141414000";
  const requestText = "Coordinate the shared auth middleware fix with the platform team.";
  const hostCapabilities = {
    gstack: false,
    superpowers: false,
  };

  const delegated = proposeDelegateFallback(repoRoot, requestId, {
    requestText,
    hostCapabilities,
  });
  assert.equal(delegated.fallback, "portable_plain_text");
  assert.equal(delegated.event, "proposal_presented");
  assert.equal(delegated.structure_kind, "delegate");

  const accepted = acceptProposal(repoRoot, requestId, {
    proposal_summary: "Use the delegate fallback and continue with the portable handoff.",
    acceptance_note: "Delegate the shared middleware work.",
  });
  assert.equal(accepted.event, "proposal_accepted");
  assert.equal(readRequest(repoRoot, requestId).data.next_action, "relay_plan");

  const events = readRequestEvents(repoRoot, requestId);
  assert.equal(events[1].structure_kind, "delegate");
  assert.deepEqual(events[1].response_options, ["A. Delegate", "B. Keep local", "C. Other + free text"]);
  assert.match(events[1].reason, /gstack\/superpowers are unavailable/);
  assert.deepEqual(
    readEventNames(repoRoot, requestId),
    ["request_persisted", "proposal_presented", "proposal_accepted"]
  );
});

test("scenario: /relay keeps issue-first users on the fast path without intake overhead", () => {
  const { repoRoot } = setupRepo();
  const readiness = createReadiness({ risk: "low" });
  const result = invokeRelayFrontDoor(repoRoot, {
    hasStableReviewAnchor: true,
    contract: createContract({
      source: { kind: "github_issue" },
      request_text: "Issue #132: Fix the login redirect loop for authenticated users.",
      readiness,
    }),
  });

  assert.equal(result.route, "bypass_intake");
  assert.deepEqual(result.downstreamChain, ["relay-plan", "relay-dispatch"]);
  assert.equal(result.sourceKind, "github_issue");
  assert.equal(result.reviewAnchorSource, "github_issue");
  assert.equal(result.leafId, "leaf-01");
  assert.deepEqual(result.readiness, readiness);
  assert.equal(result.requestId, undefined);
  assert.equal(result.requestPath, undefined);
  assert.equal(result.doneCriteriaPath, undefined);
  assert.equal(fs.existsSync(getRequestsDir(repoRoot)), false);
});

test("persistRequestContract rejects duplicate leaf IDs within a multi-leaf request", () => {
  const { repoRoot } = setupRepo();
  const contract = createMultiLeafContract({
    handoffs: [
      { ...createMultiLeafContract().handoffs[0], leaf_id: "leaf-01" },
      createMultiLeafContract().handoffs[1],
    ],
  });

  assert.throws(
    () => persistRequestContract(repoRoot, contract),
    /leaf_id 'leaf-01' must be unique within a request/
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
  const initialReadiness = createReadiness({
    clarity: "low",
    granularity: "unclear",
    dependency: "external",
    verifiability: "low",
    risk: "high",
  });
  const reassessedReadiness = createReadiness({ dependency: "internal" });

  const proposal = propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: createContract().request_text,
    readiness: initialReadiness,
    proposal_summary: "Keep the work as a single auth redirect leaf.",
    proposal_text: "A. Update the guard\nB. Add redirect tests\nC. Free text",
    response_options: ["A", "B", "C + free text"],
  });
  assert.equal(proposal.event, "proposal_presented");
  assert.equal(proposal.leaf_id, null);

  const question = clarify(repoRoot, requestId, {
    readiness: reassessedReadiness,
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
  assert.deepEqual(requestArtifact.data.readiness, reassessedReadiness);
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
  assert.deepEqual(promotedArtifact.data.readiness, reassessedReadiness);
  assert.deepEqual(intake.readiness, reassessedReadiness);

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
  const requestId = "req-20260409060606000";
  const reassessedReadiness = createReadiness({ granularity: "multi_task" });

  const proposal = propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: createContract().request_text,
    proposal_summary: "Keep the work as a single auth redirect leaf.",
    proposal_text: "A. Update the guard\nB. Add redirect tests\nC. Free text",
    response_options: ["A", "B", "C + free text"],
  });
  assert.equal(proposal.event, "proposal_presented");
  assert.equal(proposal.request_id, requestId);
  assert.equal(proposal.leaf_id, null);
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "await_proposal_response");

  const question = clarify(repoRoot, requestId, {
    readiness: reassessedReadiness,
    question_text: "Should guest deep links still route to /login?",
    response_options: ["A. Yes", "B. No", "C. Other"],
  });
  assert.equal(question.event, "question_asked");
  assert.deepEqual(question.response_options, ["A. Yes", "B. No", "C. Other"]);
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "await_answer");
  assert.deepEqual(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.readiness, reassessedReadiness);

  const structured = structure(repoRoot, requestId, {
    proposal_summary: "Restructure the handoff around one guard change plus tests.",
    proposal_kind: "structure",
    structure_kind: "decompose",
  });
  assert.equal(structured.event, "proposal_presented");
  assert.equal(structured.structure_kind, "decompose");
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "await_proposal_response");

  const structuredEdit = structure(repoRoot, requestId, {
    proposal_summary: "Keep one leaf but tighten the handoff wording.",
    edit_summary: "Fold the test wording into the main proposal summary.",
    edits_existing_proposal: true,
    structure_kind: "restructure",
  });
  assert.equal(structuredEdit.event, "proposal_edited");
  assert.equal(structuredEdit.edit_summary, "Fold the test wording into the main proposal summary.");
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "await_proposal_response");

  const events = readRequestEvents(repoRoot, requestId);
  assert.deepEqual(
    events.map((event) => event.event),
    ["request_persisted", "proposal_presented", "question_asked", "proposal_presented", "proposal_edited"]
  );
});

test("interaction event helpers persist portable fields for answers, edits, and acceptance", () => {
  const { repoRoot } = setupRepo();
  const requestId = "req-20260409070707000";
  propose(repoRoot, requestId, {
    source_kind: "raw_text",
    request_text: createContract().request_text,
    proposal_summary: "Keep one relay leaf for the redirect loop fix.",
  });

  const answered = answerQuestion(repoRoot, requestId, {
    question_text: "Should guest deep links still route to /login?",
    answer_text: "A. Yes, keep the guest login route as-is.",
    answer_choice: "A",
  });
  assert.equal(answered.event, "question_answered");
  assert.equal(answered.question_text, "Should guest deep links still route to /login?");
  assert.equal(answered.answer_text, "A. Yes, keep the guest login route as-is.");
  assert.equal(answered.answer_choice, "A");
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "review_answer");

  const edited = editProposal(repoRoot, requestId, {
    proposal_summary: "Keep one relay leaf for the redirect loop fix.",
    edit_summary: "Add the cookie-session assumption to the proposal text.",
    proposal_text: "Scope the work to the redirect guard and add tests.",
  });
  assert.equal(edited.event, "proposal_edited");
  assert.equal(edited.edit_summary, "Add the cookie-session assumption to the proposal text.");
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "review_proposal_edits");

  const accepted = acceptProposal(repoRoot, requestId, {
    proposal_summary: "Keep one relay leaf for the redirect loop fix.",
    acceptance_note: "Ship the single-leaf handoff.",
    accepted_with_edits: true,
  });
  assert.equal(accepted.event, "proposal_accepted");
  assert.equal(accepted.acceptance_note, "Ship the single-leaf handoff.");
  assert.equal(accepted.accepted_with_edits, true);
  assert.equal(readRequestArtifact(getRequestPath(repoRoot, requestId)).data.next_action, "relay_plan");

  const events = readRequestEvents(repoRoot, requestId);
  assert.deepEqual(
    events.slice(-3).map((event) => event.event),
    ["question_answered", "proposal_edited", "proposal_accepted"]
  );
});

test("preflight helpers reject mutations after relay-ready persistence", () => {
  const { repoRoot } = setupRepo();
  const readiness = createReadiness({ risk: "low" });
  const intake = persistRequestContract(repoRoot, createContract({ readiness }));
  const initialArtifact = readRequestArtifact(intake.requestPath);
  const initialEvents = readRequestEvents(repoRoot, intake.requestId);

  assert.throws(
    () => propose(repoRoot, intake.requestId, {
      proposal_summary: "Try to reshape the frozen handoff.",
    }),
    /already relay_ready; preflight intake interactions cannot mutate a frozen handoff/
  );
  assert.throws(
    () => clarify(repoRoot, intake.requestId, {
      readiness: createReadiness({ risk: "high" }),
      question_text: "Should this still be editable after the handoff exists?",
    }),
    /already relay_ready; preflight intake interactions cannot mutate a frozen handoff/
  );
  assert.throws(
    () => structure(repoRoot, intake.requestId, {
      proposal_summary: "Restructure the frozen request.",
    }),
    /already relay_ready; preflight intake interactions cannot mutate a frozen handoff/
  );

  const currentArtifact = readRequestArtifact(intake.requestPath);
  assert.equal(currentArtifact.data.next_action, initialArtifact.data.next_action);
  assert.deepEqual(currentArtifact.data.readiness, initialArtifact.data.readiness);
  assert.deepEqual(readRequestEvents(repoRoot, intake.requestId), initialEvents);
});

test("scenario: /relay auto-routes raw text through intake, then continues to dispatch and review linkage", () => {
  const { repoRoot, relayHome } = setupRepo();
  const intake = invokeRelayFrontDoor(repoRoot, {
    contract: createContract(),
    hasStableReviewAnchor: false,
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    PATH: `${binDir}:${process.env.PATH}`,
  };
  const rubricPath = path.join(repoRoot, "rubric.yaml");
  fs.writeFileSync(rubricPath, "rubric:\n  factors:\n    - name: intake relay handoff\n      target: exit 0\n", "utf-8");

  const dispatchStdout = execFileSync("node", [
    DISPATCH_SCRIPT,
    repoRoot,
    "-b", "issue-127-raw-intake",
    "--prompt-file", intake.handoffPath,
    "--rubric-file", rubricPath,
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
  assert.equal(intake.route, "invoke_intake");
  assert.deepEqual(intake.downstreamChain, ["relay-intake", "relay-plan", "relay-dispatch"]);
  assert.deepEqual(
    readEventNames(repoRoot, intake.requestId),
    ["request_persisted", "relay_ready_handoff_persisted"]
  );
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
