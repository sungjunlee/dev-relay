const fs = require("fs");
const path = require("path");

const {
  getActorName,
  getRelayHome,
  getRepoSlug,
  parseFrontmatter,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

const READINESS_LEVELS = {
  clarity: new Set(["high", "medium", "low"]),
  granularity: new Set(["single_task", "multi_task", "unclear"]),
  dependency: new Set(["none", "internal", "external"]),
  verifiability: new Set(["high", "medium", "low"]),
  risk: new Set(["low", "medium", "high"]),
};

const DEFAULT_NEXT_ACTIONS = {
  acceptProposal: "relay_plan",
  answerQuestion: "review_answer",
  clarify: "await_answer",
  editProposal: "review_proposal_edits",
  persist: "relay_plan",
  propose: "await_proposal_response",
  structure: "await_proposal_response",
};

function nowIso() {
  return new Date().toISOString();
}

function createRequestId(timestamp = new Date()) {
  const iso = timestamp.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `req-${iso}`;
}

function getRequestsBase() {
  return process.env.RELAY_REQUESTS_BASE || path.join(getRelayHome(), "requests");
}

function getRequestsDir(repoRoot) {
  return path.join(getRequestsBase(), getRepoSlug(repoRoot));
}

function getRequestDir(repoRoot, requestId) {
  return path.join(getRequestsDir(repoRoot), requestId);
}

function getRequestPath(repoRoot, requestId) {
  return path.join(getRequestsDir(repoRoot), `${requestId}.md`);
}

function getRequestEventsPath(repoRoot, requestId) {
  return path.join(getRequestDir(repoRoot, requestId), "events.jsonl");
}

function ensureRequestLayout(repoRoot, requestId) {
  if (!requestId) {
    throw new Error("request_id is required to create relay-intake layout");
  }

  const requestsDir = getRequestsDir(repoRoot);
  const requestDir = getRequestDir(repoRoot, requestId);
  const relayReadyDir = path.join(requestDir, "relay-ready");
  const doneCriteriaDir = path.join(requestDir, "done-criteria");

  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(relayReadyDir, { recursive: true });
  fs.mkdirSync(doneCriteriaDir, { recursive: true });

  return {
    requestsDir,
    requestDir,
    requestPath: getRequestPath(repoRoot, requestId),
    eventsPath: getRequestEventsPath(repoRoot, requestId),
    rawRequestPath: path.join(requestDir, "raw-request.md"),
    relayReadyDir,
    doneCriteriaDir,
  };
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function normalizeOptionalStringArray(value, fieldName) {
  if (value === undefined) return undefined;
  return normalizeStringArray(value, fieldName);
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function normalizeOptionalString(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredString(value, fieldName);
}

function normalizeOptionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeEnum(value, values, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!values.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${[...values].join(", ")}`);
  }
  return normalized;
}

function normalizeReadiness(readiness) {
  if (readiness === undefined) return undefined;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    throw new Error("readiness must be an object");
  }

  return Object.fromEntries(
    Object.entries(READINESS_LEVELS).map(([field, values]) => [
      field,
      normalizeEnum(readiness[field], values, `readiness.${field}`),
    ])
  );
}

function normalizeNextAction(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return normalizeRequiredString(value, "next_action");
}

function normalizeSingleLeafContract(contract) {
  if (!contract || typeof contract !== "object") {
    throw new Error("contract must be an object");
  }

  if (!contract.source || typeof contract.source !== "object") {
    throw new Error("source is required");
  }
  if (typeof contract.source.kind !== "string" || !contract.source.kind.trim()) {
    throw new Error("source.kind is required");
  }
  if (typeof contract.request_text !== "string" || !contract.request_text.trim()) {
    throw new Error("request_text is required");
  }

  let handoff = contract.handoff;
  if (Array.isArray(contract.handoffs)) {
    if (contract.handoffs.length !== 1) {
      throw new Error("TODO(#129): multi-leaf relay-intake handoff is not implemented yet");
    }
    [handoff] = contract.handoffs;
  }

  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    throw new Error("handoff is required");
  }

  const requiredStrings = ["leaf_id", "title", "goal", "done_criteria_markdown"];
  for (const field of requiredStrings) {
    if (typeof handoff[field] !== "string" || !handoff[field].trim()) {
      throw new Error(`handoff.${field} is required`);
    }
  }

  return {
    source: {
      kind: contract.source.kind.trim(),
    },
    requestText: contract.request_text.trim(),
    readiness: normalizeReadiness(contract.readiness),
    handoff: {
      leafId: handoff.leaf_id.trim(),
      title: handoff.title.trim(),
      goal: handoff.goal.trim(),
      inScope: normalizeStringArray(handoff.in_scope || [], "handoff.in_scope"),
      outOfScope: normalizeStringArray(handoff.out_of_scope || [], "handoff.out_of_scope"),
      assumptions: normalizeStringArray(handoff.assumptions || [], "handoff.assumptions"),
      doneCriteriaMarkdown: handoff.done_criteria_markdown.trim(),
      escalationConditions: normalizeStringArray(
        handoff.escalation_conditions || [],
        "handoff.escalation_conditions"
      ),
    },
  };
}

function formatBulletList(items) {
  if (!items.length) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

function buildRequestBody({ sourceKind, requestText, leafId, handoffRelativePath, doneCriteriaRelativePath }) {
  return [
    "# Relay Intake Request",
    "",
    "## Source",
    `Kind: ${sourceKind}`,
    "",
    "## Raw Request",
    requestText,
    "",
    "## Relay-Ready Leaves",
    `- ${leafId}: ${handoffRelativePath}`,
    "",
    "## Frozen Done Criteria",
    `- ${leafId}: ${doneCriteriaRelativePath}`,
    "",
  ].join("\n");
}

function buildHandoffBody(handoff) {
  return [
    "# Relay-Ready Handoff",
    "",
    "## Goal",
    handoff.goal,
    "",
    "## In Scope",
    formatBulletList(handoff.inScope),
    "",
    "## Out of Scope",
    formatBulletList(handoff.outOfScope),
    "",
    "## Assumptions",
    formatBulletList(handoff.assumptions),
    "",
    "## Escalation Conditions",
    formatBulletList(handoff.escalationConditions),
    "",
  ].join("\n");
}

function pickDefinedEntries(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function getRequestRecord(repoRoot, requestId) {
  const requestPath = getRequestPath(repoRoot, requestId);
  if (!fs.existsSync(requestPath)) {
    throw new Error(`request artifact not found: ${requestPath}`);
  }
  return { requestPath, artifact: readRequestArtifact(requestPath) };
}

function resolveRequestLeafId(artifact, leafId) {
  if (leafId) return leafId;
  if (artifact.data?.leaf_id) return artifact.data.leaf_id;

  const handoffPath = artifact.data?.paths?.handoff;
  if (!handoffPath || !fs.existsSync(handoffPath)) {
    throw new Error("leaf_id is required");
  }

  return normalizeRequiredString(readRequestArtifact(handoffPath).data?.leaf_id, "leaf_id");
}

function updateRequestArtifact(repoRoot, requestId, patch, requestRecord = getRequestRecord(repoRoot, requestId)) {
  writeManifest(requestRecord.requestPath, {
    ...requestRecord.artifact.data,
    ...patch,
    timestamps: {
      ...(requestRecord.artifact.data.timestamps || {}),
      updated_at: nowIso(),
    },
  }, requestRecord.artifact.body);
  return readRequestArtifact(requestRecord.requestPath);
}

function appendRequestEvent(repoRoot, requestId, eventData) {
  if (!requestId) {
    throw new Error("request_id is required to append a relay-intake event");
  }
  if (!String(eventData?.event || "").trim()) {
    throw new Error("event is required to append a relay-intake event");
  }

  const { eventsPath } = ensureRequestLayout(repoRoot, requestId);
  const record = {
    ...pickDefinedEntries(eventData),
    ts: eventData.ts || nowIso(),
    event: eventData.event,
    actor: getActorName(repoRoot),
    request_id: requestId,
    leaf_id: eventData.leaf_id || null,
    source_kind: eventData.source_kind || null,
    handoff_path: eventData.handoff_path || null,
    done_criteria_path: eventData.done_criteria_path || null,
    reason: eventData.reason || null,
  };

  fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

function readRequestEvents(repoRoot, requestId) {
  const eventsPath = getRequestEventsPath(repoRoot, requestId);
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readRequestArtifact(requestPath) {
  const text = fs.readFileSync(requestPath, "utf-8");
  return parseFrontmatter(text);
}

function assertRequestArtifactsAbsent(requestId, artifactPaths) {
  for (const [label, artifactPath] of artifactPaths) {
    if (fs.existsSync(artifactPath)) {
      throw new Error(
        `request_id '${requestId}' already exists; refusing to overwrite existing ${label}: ${artifactPath}`
      );
    }
  }
}

function appendInteractionEvent(repoRoot, requestId, eventData, nextAction) {
  const requestRecord = getRequestRecord(repoRoot, requestId);
  const leafId = resolveRequestLeafId(requestRecord.artifact, eventData.leaf_id);
  const record = appendRequestEvent(repoRoot, requestId, { ...eventData, leaf_id: leafId });

  if (nextAction !== undefined) {
    updateRequestArtifact(repoRoot, requestId, { next_action: nextAction }, requestRecord);
  }

  return record;
}

function normalizeProposalFields(data = {}, fieldName = "proposal_summary") {
  return pickDefinedEntries({
    leaf_id: normalizeOptionalString(data.leaf_id, "leaf_id"),
    proposal_summary: normalizeRequiredString(data[fieldName], fieldName),
    proposal_text: normalizeOptionalString(data.proposal_text, "proposal_text"),
    proposal_kind: normalizeOptionalString(data.proposal_kind, "proposal_kind"),
    response_options: normalizeOptionalStringArray(data.response_options, "response_options"),
    reason: normalizeOptionalString(data.reason, "reason"),
  });
}

function normalizeQuestionFields(data = {}) {
  return pickDefinedEntries({
    leaf_id: normalizeOptionalString(data.leaf_id, "leaf_id"),
    question_text: normalizeRequiredString(data.question_text, "question_text"),
    response_options: normalizeOptionalStringArray(data.response_options, "response_options"),
    reason: normalizeOptionalString(data.reason, "reason"),
  });
}

function normalizeQuestionAnswerFields(data = {}) {
  return pickDefinedEntries({
    leaf_id: normalizeOptionalString(data.leaf_id, "leaf_id"),
    question_text: normalizeRequiredString(data.question_text, "question_text"),
    answer_text: normalizeRequiredString(data.answer_text, "answer_text"),
    answer_choice: normalizeOptionalString(data.answer_choice, "answer_choice"),
    reason: normalizeOptionalString(data.reason, "reason"),
  });
}

function normalizeProposalAcceptanceFields(data = {}) {
  return pickDefinedEntries({
    leaf_id: normalizeOptionalString(data.leaf_id, "leaf_id"),
    proposal_summary: normalizeRequiredString(data.proposal_summary, "proposal_summary"),
    acceptance_note: normalizeOptionalString(data.acceptance_note, "acceptance_note"),
    accepted_with_edits: normalizeOptionalBoolean(data.accepted_with_edits, "accepted_with_edits"),
    reason: normalizeOptionalString(data.reason, "reason"),
  });
}

function normalizeProposalEditFields(data = {}) {
  return pickDefinedEntries({
    leaf_id: normalizeOptionalString(data.leaf_id, "leaf_id"),
    proposal_summary: normalizeRequiredString(data.proposal_summary, "proposal_summary"),
    edit_summary: normalizeRequiredString(data.edit_summary, "edit_summary"),
    proposal_text: normalizeOptionalString(data.proposal_text, "proposal_text"),
    reason: normalizeOptionalString(data.reason, "reason"),
  });
}

function propose(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.propose);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_presented",
    ...normalizeProposalFields(data),
  }, nextAction);
}

function clarify(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.clarify);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "question_asked",
    ...normalizeQuestionFields(data),
  }, nextAction);
}

function structure(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.structure);
  const event = data.edits_existing_proposal ? "proposal_edited" : "proposal_presented";
  const details = data.edits_existing_proposal
    ? normalizeProposalEditFields(data)
    : normalizeProposalFields(data);

  return appendInteractionEvent(repoRoot, requestId, {
    event,
    structure_kind: normalizeOptionalString(data.structure_kind, "structure_kind") || "restructure",
    ...details,
  }, nextAction);
}

function answerQuestion(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.answerQuestion);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "question_answered",
    ...normalizeQuestionAnswerFields(data),
  }, nextAction);
}

function acceptProposal(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.acceptProposal);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_accepted",
    ...normalizeProposalAcceptanceFields(data),
  }, nextAction);
}

function editProposal(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.editProposal);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_edited",
    ...normalizeProposalEditFields(data),
  }, nextAction);
}

function persistRequestContract(repoRoot, contract, options = {}) {
  const normalized = normalizeSingleLeafContract(contract);
  const requestId = options.requestId || createRequestId();
  const createdAt = nowIso();
  const layout = ensureRequestLayout(repoRoot, requestId);
  const requestArtifactDir = path.dirname(layout.requestPath);
  const handoffFileName = `${normalized.handoff.leafId}.md`;
  const handoffPath = path.join(layout.relayReadyDir, handoffFileName);
  const doneCriteriaPath = path.join(layout.doneCriteriaDir, handoffFileName);
  const handoffRelativePath = path.relative(requestArtifactDir, handoffPath);
  const doneCriteriaRelativePath = path.relative(requestArtifactDir, doneCriteriaPath);

  assertRequestArtifactsAbsent(requestId, [
    ["request artifact", layout.requestPath],
    ["request event log", layout.eventsPath],
    ["raw request artifact", layout.rawRequestPath],
    ["relay-ready handoff", handoffPath],
    ["done criteria snapshot", doneCriteriaPath],
  ]);

  fs.writeFileSync(layout.rawRequestPath, `${normalized.requestText}\n`, "utf-8");
  fs.writeFileSync(doneCriteriaPath, `${normalized.handoff.doneCriteriaMarkdown}\n`, "utf-8");

  writeManifest(handoffPath, {
    request_id: requestId,
    leaf_id: normalized.handoff.leafId,
    title: normalized.handoff.title,
    goal: normalized.handoff.goal,
    done_criteria_path: doneCriteriaPath,
  }, buildHandoffBody(normalized.handoff));

  writeManifest(layout.requestPath, {
    request_id: requestId,
    state: "relay_ready",
    leaf_id: normalized.handoff.leafId,
    next_action: DEFAULT_NEXT_ACTIONS.persist,
    source: {
      kind: normalized.source.kind,
    },
    ...(normalized.readiness ? { readiness: normalized.readiness } : {}),
    leaf_count: 1,
    paths: {
      raw_request: layout.rawRequestPath,
      handoff: handoffPath,
      done_criteria: doneCriteriaPath,
    },
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  }, buildRequestBody({
    sourceKind: normalized.source.kind,
    requestText: normalized.requestText,
    leafId: normalized.handoff.leafId,
    handoffRelativePath,
    doneCriteriaRelativePath,
  }));

  appendRequestEvent(repoRoot, requestId, {
    event: "request_persisted",
    source_kind: normalized.source.kind,
    leaf_id: normalized.handoff.leafId,
    handoff_path: handoffPath,
    done_criteria_path: doneCriteriaPath,
  });
  appendRequestEvent(repoRoot, requestId, {
    event: "relay_ready_handoff_persisted",
    source_kind: normalized.source.kind,
    leaf_id: normalized.handoff.leafId,
    handoff_path: handoffPath,
    done_criteria_path: doneCriteriaPath,
  });

  return {
    requestId,
    requestPath: layout.requestPath,
    requestDir: layout.requestDir,
    rawRequestPath: layout.rawRequestPath,
    handoffPath,
    doneCriteriaPath,
    leafId: normalized.handoff.leafId,
    nextAction: DEFAULT_NEXT_ACTIONS.persist,
    readiness: normalized.readiness || null,
    title: normalized.handoff.title,
    sourceKind: normalized.source.kind,
  };
}

module.exports = {
  acceptProposal,
  answerQuestion,
  appendRequestEvent,
  clarify,
  createRequestId,
  editProposal,
  ensureRequestLayout,
  getRequestDir,
  getRequestEventsPath,
  getRequestPath,
  getRequestsBase,
  getRequestsDir,
  normalizeSingleLeafContract,
  persistRequestContract,
  propose,
  readRequestArtifact,
  readRequestEvents,
  structure,
};
