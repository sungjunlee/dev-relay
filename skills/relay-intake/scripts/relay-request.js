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

function normalizePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
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

function collectContractHandoffs(contract) {
  if (Array.isArray(contract.handoffs)) {
    if (!contract.handoffs.length) {
      throw new Error("handoffs must include at least one leaf");
    }
    return contract.handoffs;
  }
  if (contract.handoff !== undefined) {
    return [contract.handoff];
  }
  throw new Error("handoff is required");
}

function normalizeLeafHandoff(handoff, fieldName, defaultOrder) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const requiredStrings = ["leaf_id", "title", "goal", "done_criteria_markdown"];
  for (const field of requiredStrings) {
    if (typeof handoff[field] !== "string" || !handoff[field].trim()) {
      throw new Error(`${fieldName}.${field} is required`);
    }
  }

  const order = handoff.order === undefined
    ? defaultOrder
    : normalizePositiveInteger(handoff.order, `${fieldName}.order`);
  if (order === undefined) {
    throw new Error(`${fieldName}.order is required`);
  }

  return {
    leafId: handoff.leaf_id.trim(),
    title: handoff.title.trim(),
    goal: handoff.goal.trim(),
    order,
    dependsOn: normalizeOptionalStringArray(handoff.depends_on, `${fieldName}.depends_on`) || [],
    inScope: normalizeStringArray(handoff.in_scope || [], `${fieldName}.in_scope`),
    outOfScope: normalizeStringArray(handoff.out_of_scope || [], `${fieldName}.out_of_scope`),
    assumptions: normalizeStringArray(handoff.assumptions || [], `${fieldName}.assumptions`),
    doneCriteriaMarkdown: handoff.done_criteria_markdown.trim(),
    escalationConditions: normalizeStringArray(
      handoff.escalation_conditions || [],
      `${fieldName}.escalation_conditions`
    ),
    readiness: normalizeReadiness(handoff.readiness),
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveContractReadiness(contractReadiness, handoffs) {
  const leafReadiness = handoffs
    .map((handoff) => handoff.readiness)
    .filter(Boolean);
  const [firstLeafReadiness] = leafReadiness;

  for (const readiness of leafReadiness.slice(1)) {
    if (!sameValue(readiness, firstLeafReadiness)) {
      throw new Error("readiness must not conflict across handoffs");
    }
  }
  if (contractReadiness && firstLeafReadiness && !sameValue(contractReadiness, firstLeafReadiness)) {
    throw new Error("readiness must not conflict between contract.readiness and handoff.readiness");
  }
  return contractReadiness || firstLeafReadiness;
}

function assertUniqueLeafIds(handoffs) {
  const seen = new Set();
  for (const handoff of handoffs) {
    if (seen.has(handoff.leafId)) {
      throw new Error(`leaf_id '${handoff.leafId}' must be unique within a request`);
    }
    seen.add(handoff.leafId);
  }
}

function assertUniqueLeafOrder(handoffs) {
  const seen = new Map();
  for (const handoff of handoffs) {
    if (seen.has(handoff.order)) {
      throw new Error(`order '${handoff.order}' must be unique within a request`);
    }
    seen.set(handoff.order, handoff.leafId);
  }
}

function assertValidDependencies(handoffs) {
  const orderByLeafId = new Map(handoffs.map((handoff) => [handoff.leafId, handoff.order]));
  for (const handoff of handoffs) {
    const seen = new Set();
    for (const dependency of handoff.dependsOn) {
      if (dependency === handoff.leafId) {
        throw new Error(`leaf '${handoff.leafId}' cannot depend on itself`);
      }
      if (seen.has(dependency)) {
        throw new Error(`leaf '${handoff.leafId}' must not repeat depends_on '${dependency}'`);
      }
      if (!orderByLeafId.has(dependency)) {
        throw new Error(`leaf '${handoff.leafId}' depends_on unknown leaf '${dependency}'`);
      }
      if (orderByLeafId.get(dependency) >= handoff.order) {
        throw new Error(`leaf '${handoff.leafId}' depends_on '${dependency}' but order does not respect that dependency`);
      }
      seen.add(dependency);
    }
  }
}

function sortHandoffsByOrder(handoffs) {
  return [...handoffs].sort((left, right) => left.order - right.order);
}

function buildDecomposition(handoffs) {
  return {
    leaf_order: handoffs.map((handoff) => handoff.leafId),
    dependencies: Object.fromEntries(
      handoffs
        .filter((handoff) => handoff.dependsOn.length)
        .map((handoff) => [handoff.leafId, handoff.dependsOn])
    ),
  };
}

function stripLeafReadiness(handoff) {
  const { readiness, ...rest } = handoff;
  return rest;
}

function normalizeRequestContract(contract) {
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

  const rawHandoffs = collectContractHandoffs(contract);
  const contractReadiness = normalizeReadiness(contract.readiness);
  const defaultOrder = rawHandoffs.length === 1 ? 1 : undefined;
  const handoffs = rawHandoffs.map((handoff, index) => normalizeLeafHandoff(
    handoff,
    Array.isArray(contract.handoffs) ? `handoffs[${index}]` : "handoff",
    defaultOrder
  ));
  const orderedHandoffs = sortHandoffsByOrder(handoffs);

  assertUniqueLeafIds(orderedHandoffs);
  assertUniqueLeafOrder(orderedHandoffs);
  assertValidDependencies(orderedHandoffs);

  return {
    source: {
      kind: contract.source.kind.trim(),
    },
    requestText: contract.request_text.trim(),
    readiness: resolveContractReadiness(contractReadiness, orderedHandoffs),
    handoffs: orderedHandoffs.map(stripLeafReadiness),
    leafCount: orderedHandoffs.length,
    decomposition: buildDecomposition(orderedHandoffs),
  };
}

function normalizeSingleLeafContract(contract) {
  const normalized = normalizeRequestContract(contract);
  if (normalized.leafCount !== 1) {
    throw new Error(`contract must resolve to exactly one handoff; received ${normalized.leafCount}`);
  }
  return {
    source: normalized.source,
    requestText: normalized.requestText,
    readiness: normalized.readiness,
    handoff: normalized.handoffs[0],
  };
}

function formatBulletList(items) {
  if (!items.length) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

function buildRequestBody({
  sourceKind,
  requestText,
  relayReadyLeaves = [],
  doneCriteriaSnapshots = [],
}) {
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
    formatBulletList(relayReadyLeaves),
    "",
    "## Frozen Done Criteria",
    formatBulletList(doneCriteriaSnapshots),
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

function shouldParseStructuredValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("{");
}

function parseStructuredValue(value, fieldName) {
  if (!shouldParseStructuredValue(value)) return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid serialized ${fieldName}: ${error.message}`);
  }
}

function serializeStructuredFields(data) {
  const next = { ...data };
  if (next.paths && typeof next.paths === "object" && !Array.isArray(next.paths)) {
    next.paths = {
      ...next.paths,
      ...(Array.isArray(next.paths.handoffs)
        ? { handoffs: JSON.stringify(next.paths.handoffs) }
        : {}),
      ...(Array.isArray(next.paths.done_criteria)
        ? { done_criteria: JSON.stringify(next.paths.done_criteria) }
        : {}),
    };
  }
  if (next.decomposition && typeof next.decomposition === "object" && !Array.isArray(next.decomposition)) {
    next.decomposition = {
      ...next.decomposition,
      ...(Array.isArray(next.decomposition.leaf_order)
        ? { leaf_order: JSON.stringify(next.decomposition.leaf_order) }
        : {}),
      ...(next.decomposition.dependencies
        ? { dependencies: JSON.stringify(next.decomposition.dependencies) }
        : {}),
    };
  }
  if (Array.isArray(next.depends_on)) {
    next.depends_on = JSON.stringify(next.depends_on);
  }
  return next;
}

function hydrateStructuredFields(data) {
  const next = { ...data };
  if (next.paths && typeof next.paths === "object" && !Array.isArray(next.paths)) {
    next.paths = {
      ...next.paths,
      handoffs: parseStructuredValue(next.paths.handoffs, "paths.handoffs"),
      done_criteria: parseStructuredValue(next.paths.done_criteria, "paths.done_criteria"),
    };
  }
  if (next.decomposition && typeof next.decomposition === "object" && !Array.isArray(next.decomposition)) {
    next.decomposition = {
      ...next.decomposition,
      leaf_order: parseStructuredValue(next.decomposition.leaf_order, "decomposition.leaf_order"),
      dependencies: parseStructuredValue(next.decomposition.dependencies, "decomposition.dependencies"),
    };
  }
  next.depends_on = parseStructuredValue(next.depends_on, "depends_on");
  return next;
}

function writeRequestManifest(manifestPath, data, body) {
  writeManifest(manifestPath, serializeStructuredFields(data), body);
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

function isRelayReadyRequestArtifact(artifact) {
  return (
    artifact.data?.state === "relay_ready" ||
    Boolean(artifact.data?.paths?.handoff) ||
    Array.isArray(artifact.data?.paths?.handoffs) ||
    artifact.data?.leaf_count > 0
  );
}

function assertPreflightMutable(requestId, requestRecord) {
  if (!isRelayReadyRequestArtifact(requestRecord.artifact)) {
    return;
  }

  throw new Error(
    `request_id '${requestId}' is already relay_ready; preflight intake interactions cannot mutate a frozen handoff`
  );
}

function resolveRequestLeafId(artifact, leafId) {
  if (leafId) return leafId;
  if (artifact.data?.leaf_id) return artifact.data.leaf_id;

  const handoffPaths = artifact.data?.paths?.handoff
    ? [artifact.data.paths.handoff]
    : artifact.data?.paths?.handoffs;
  if (!Array.isArray(handoffPaths) || !handoffPaths.length) {
    return null;
  }
  if (handoffPaths.length !== 1 || !fs.existsSync(handoffPaths[0])) {
    throw new Error("leaf_id is required");
  }

  return normalizeRequiredString(readRequestArtifact(handoffPaths[0]).data?.leaf_id, "leaf_id");
}

function updateRequestArtifact(repoRoot, requestId, patch, requestRecord = getRequestRecord(repoRoot, requestId)) {
  writeRequestManifest(requestRecord.requestPath, {
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
  const artifact = parseFrontmatter(text);
  return {
    ...artifact,
    data: hydrateStructuredFields(artifact.data),
  };
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

function appendInteractionEvent(repoRoot, requestId, eventData, nextAction, bootstrapData = {}) {
  const requestRecord = ensurePreflightRequestArtifact(repoRoot, requestId, bootstrapData, nextAction);
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

function normalizeRequestBootstrapData(data = {}) {
  const source = data.source;
  if (source !== undefined && (!source || typeof source !== "object" || Array.isArray(source))) {
    throw new Error("source must be an object");
  }

  const sourceKind = normalizeOptionalString(
    data.source_kind ?? source?.kind,
    "source_kind"
  );
  const requestText = normalizeOptionalString(data.request_text, "request_text");
  const readiness = normalizeReadiness(data.readiness);
  const hasBootstrapIdentity = sourceKind !== undefined || requestText !== undefined;

  if (hasBootstrapIdentity && (sourceKind === undefined || requestText === undefined)) {
    throw new Error("source_kind and request_text are required together to bootstrap a request artifact");
  }

  return { sourceKind, requestText, readiness };
}

function readRawRequestText(rawRequestPath) {
  return fs.readFileSync(rawRequestPath, "utf-8").replace(/\r?\n$/, "");
}

function validateBootstrapData(repoRoot, requestId, requestRecord, bootstrapData) {
  if (!bootstrapData.sourceKind && !bootstrapData.requestText && bootstrapData.readiness === undefined) {
    return;
  }

  const existingSourceKind = requestRecord.artifact.data?.source?.kind;
  if (bootstrapData.sourceKind && existingSourceKind && bootstrapData.sourceKind !== existingSourceKind) {
    throw new Error(
      `request_id '${requestId}' already exists with source.kind '${existingSourceKind}'`
    );
  }

  const rawRequestPath = requestRecord.artifact.data?.paths?.raw_request
    || path.join(getRequestDir(repoRoot, requestId), "raw-request.md");
  if (bootstrapData.requestText && fs.existsSync(rawRequestPath)) {
    const existingRequestText = readRawRequestText(rawRequestPath);
    if (existingRequestText !== bootstrapData.requestText) {
      throw new Error(`request_id '${requestId}' already exists with a different raw request`);
    }
  }
}

function applyBootstrapDataPatch(repoRoot, requestId, requestRecord, bootstrapData) {
  if (bootstrapData.readiness === undefined) {
    return requestRecord;
  }

  const existingReadiness = requestRecord.artifact.data?.readiness;
  if (JSON.stringify(existingReadiness) === JSON.stringify(bootstrapData.readiness)) {
    return requestRecord;
  }

  return {
    requestPath: requestRecord.requestPath,
    artifact: updateRequestArtifact(repoRoot, requestId, {
      readiness: bootstrapData.readiness,
    }, requestRecord),
  };
}

function buildRequestArtifactData({
  requestId,
  state,
  leafId,
  leafArtifacts = [],
  nextAction,
  sourceKind,
  readiness,
  rawRequestPath,
  createdAt,
  updatedAt,
}) {
  const isSingleLeaf = leafArtifacts.length === 1;
  const decomposition = leafArtifacts.length > 1
    ? {
      leaf_order: leafArtifacts.map((leaf) => leaf.leafId),
      dependencies: Object.fromEntries(
        leafArtifacts
          .filter((leaf) => leaf.dependsOn.length)
          .map((leaf) => [leaf.leafId, leaf.dependsOn])
      ),
    }
    : undefined;

  return pickDefinedEntries({
    request_id: requestId,
    state,
    leaf_id: leafId,
    next_action: nextAction,
    source: {
      kind: sourceKind,
    },
    ...(readiness ? { readiness } : {}),
    leaf_count: leafArtifacts.length,
    paths: pickDefinedEntries({
      raw_request: rawRequestPath,
      ...(isSingleLeaf
        ? {
          handoff: leafArtifacts[0].handoffPath,
          done_criteria: leafArtifacts[0].doneCriteriaPath,
        }
        : {}),
      ...(leafArtifacts.length > 1
        ? {
          handoffs: leafArtifacts.map((leaf) => leaf.handoffPath),
          done_criteria: leafArtifacts.map((leaf) => leaf.doneCriteriaPath),
        }
        : {}),
    }),
    decomposition,
    timestamps: {
      created_at: createdAt,
      updated_at: updatedAt,
    },
  });
}

function buildLeafArtifacts(layout, requestArtifactDir, handoffs) {
  return handoffs.map((handoff) => {
    const fileName = `${handoff.leafId}.md`;
    const handoffPath = path.join(layout.relayReadyDir, fileName);
    const doneCriteriaPath = path.join(layout.doneCriteriaDir, fileName);
    return {
      ...handoff,
      handoffPath,
      doneCriteriaPath,
      handoffRelativePath: path.relative(requestArtifactDir, handoffPath),
      doneCriteriaRelativePath: path.relative(requestArtifactDir, doneCriteriaPath),
    };
  });
}

function buildPersistResult({
  requestId,
  requestPath,
  requestDir,
  rawRequestPath,
  leafArtifacts,
  nextAction,
  readiness,
  sourceKind,
}) {
  const result = {
    requestId,
    requestPath,
    requestDir,
    rawRequestPath,
    leafIds: leafArtifacts.map((leaf) => leaf.leafId),
    handoffPaths: leafArtifacts.map((leaf) => leaf.handoffPath),
    doneCriteriaPaths: leafArtifacts.map((leaf) => leaf.doneCriteriaPath),
    leafCount: leafArtifacts.length,
    nextAction,
    readiness: readiness || null,
    sourceKind,
  };

  if (leafArtifacts.length === 1) {
    result.leafId = leafArtifacts[0].leafId;
    result.handoffPath = leafArtifacts[0].handoffPath;
    result.doneCriteriaPath = leafArtifacts[0].doneCriteriaPath;
    result.title = leafArtifacts[0].title;
  }
  return result;
}

function bootstrapRequestArtifact(repoRoot, requestId, data = {}, nextAction) {
  if (!requestId) {
    throw new Error("request_id is required");
  }

  const layout = ensureRequestLayout(repoRoot, requestId);
  const bootstrapData = normalizeRequestBootstrapData(data);
  if (fs.existsSync(layout.requestPath)) {
    const requestRecord = getRequestRecord(repoRoot, requestId);
    validateBootstrapData(repoRoot, requestId, requestRecord, bootstrapData);
    return applyBootstrapDataPatch(repoRoot, requestId, requestRecord, bootstrapData);
  }

  if (!bootstrapData.sourceKind || !bootstrapData.requestText) {
    throw new Error(
      `request artifact not found: ${layout.requestPath}; source_kind and request_text are required to bootstrap it`
    );
  }

  const createdAt = nowIso();
  assertRequestArtifactsAbsent(requestId, [
    ["request artifact", layout.requestPath],
    ["request event log", layout.eventsPath],
    ["raw request artifact", layout.rawRequestPath],
  ]);

  fs.writeFileSync(layout.rawRequestPath, `${bootstrapData.requestText}\n`, "utf-8");
  writeRequestManifest(layout.requestPath, buildRequestArtifactData({
    requestId,
    state: "intake",
    nextAction,
    sourceKind: bootstrapData.sourceKind,
    readiness: bootstrapData.readiness,
    rawRequestPath: layout.rawRequestPath,
    leafArtifacts: [],
    createdAt,
    updatedAt: createdAt,
  }), buildRequestBody({
    sourceKind: bootstrapData.sourceKind,
    requestText: bootstrapData.requestText,
  }));

  appendRequestEvent(repoRoot, requestId, {
    event: "request_persisted",
    source_kind: bootstrapData.sourceKind,
  });

  return getRequestRecord(repoRoot, requestId);
}

function ensureRequestArtifact(repoRoot, requestId, data = {}, nextAction) {
  return bootstrapRequestArtifact(repoRoot, requestId, data, nextAction);
}

function ensurePreflightRequestArtifact(repoRoot, requestId, data = {}, nextAction) {
  const requestPath = getRequestPath(repoRoot, requestId);
  if (!fs.existsSync(requestPath)) {
    return bootstrapRequestArtifact(repoRoot, requestId, data, nextAction);
  }

  const requestRecord = getRequestRecord(repoRoot, requestId);
  assertPreflightMutable(requestId, requestRecord);
  const bootstrapData = normalizeRequestBootstrapData(data);
  validateBootstrapData(repoRoot, requestId, requestRecord, bootstrapData);
  return applyBootstrapDataPatch(repoRoot, requestId, requestRecord, bootstrapData);
}

function propose(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.propose);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_presented",
    ...normalizeProposalFields(data),
  }, nextAction, data);
}

function clarify(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.clarify);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "question_asked",
    ...normalizeQuestionFields(data),
  }, nextAction, data);
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
  }, nextAction, data);
}

function answerQuestion(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.answerQuestion);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "question_answered",
    ...normalizeQuestionAnswerFields(data),
  }, nextAction, data);
}

function acceptProposal(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.acceptProposal);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_accepted",
    ...normalizeProposalAcceptanceFields(data),
  }, nextAction, data);
}

function editProposal(repoRoot, requestId, data = {}) {
  const nextAction = normalizeNextAction(data.next_action, DEFAULT_NEXT_ACTIONS.editProposal);
  return appendInteractionEvent(repoRoot, requestId, {
    event: "proposal_edited",
    ...normalizeProposalEditFields(data),
  }, nextAction, data);
}

function persistRequestContract(repoRoot, contract, options = {}) {
  const normalized = normalizeRequestContract(contract);
  const requestId = options.requestId || createRequestId();
  if (fs.existsSync(getRequestPath(repoRoot, requestId))) {
    const existingRequest = getRequestRecord(repoRoot, requestId);
    if (isRelayReadyRequestArtifact(existingRequest.artifact)) {
      throw new Error(
        `request_id '${requestId}' already exists; refusing to overwrite existing request artifact: ${existingRequest.requestPath}`
      );
    }
  }
  const requestRecord = bootstrapRequestArtifact(repoRoot, requestId, {
    source_kind: normalized.source.kind,
    request_text: normalized.requestText,
    readiness: normalized.readiness,
  }, DEFAULT_NEXT_ACTIONS.persist);
  const requestArtifactPath = requestRecord.requestPath;
  const requestArtifactDir = path.dirname(requestArtifactPath);
  const layout = ensureRequestLayout(repoRoot, requestId);
  const leafArtifacts = buildLeafArtifacts(layout, requestArtifactDir, normalized.handoffs);
  const requestReadiness = normalized.readiness || requestRecord.artifact.data?.readiness;
  const rawRequestPath = requestRecord.artifact.data?.paths?.raw_request;
  const createdAt = requestRecord.artifact.data?.timestamps?.created_at || nowIso();
  const updatedAt = nowIso();

  assertRequestArtifactsAbsent(requestId, leafArtifacts.flatMap((leaf) => [
    ["relay-ready handoff", leaf.handoffPath],
    ["done criteria snapshot", leaf.doneCriteriaPath],
  ]));

  for (const leaf of leafArtifacts) {
    fs.writeFileSync(leaf.doneCriteriaPath, `${leaf.doneCriteriaMarkdown}\n`, "utf-8");
    writeRequestManifest(leaf.handoffPath, {
      request_id: requestId,
      leaf_id: leaf.leafId,
      title: leaf.title,
      goal: leaf.goal,
      order: leaf.order,
      depends_on: leaf.dependsOn,
      done_criteria_path: leaf.doneCriteriaPath,
    }, buildHandoffBody(leaf));
  }

  writeRequestManifest(requestArtifactPath, buildRequestArtifactData({
    requestId,
    state: "relay_ready",
    leafId: leafArtifacts.length === 1 ? leafArtifacts[0].leafId : undefined,
    leafArtifacts,
    nextAction: DEFAULT_NEXT_ACTIONS.persist,
    sourceKind: normalized.source.kind,
    readiness: requestReadiness,
    rawRequestPath,
    createdAt,
    updatedAt,
  }), buildRequestBody({
    sourceKind: normalized.source.kind,
    requestText: normalized.requestText,
    relayReadyLeaves: leafArtifacts.map(
      (leaf) => `${leaf.leafId} [order ${leaf.order}] ${leaf.title}: ${leaf.handoffRelativePath}${
        leaf.dependsOn.length ? ` (depends_on: ${leaf.dependsOn.join(", ")})` : ""
      }`
    ),
    doneCriteriaSnapshots: leafArtifacts.map(
      (leaf) => `${leaf.leafId}: ${leaf.doneCriteriaRelativePath}`
    ),
  }));

  for (const leaf of leafArtifacts) {
    appendRequestEvent(repoRoot, requestId, {
      event: "relay_ready_handoff_persisted",
      source_kind: normalized.source.kind,
      leaf_id: leaf.leafId,
      handoff_path: leaf.handoffPath,
      done_criteria_path: leaf.doneCriteriaPath,
    });
  }

  return buildPersistResult({
    requestId,
    requestPath: requestArtifactPath,
    requestDir: getRequestDir(repoRoot, requestId),
    rawRequestPath,
    leafArtifacts,
    nextAction: DEFAULT_NEXT_ACTIONS.persist,
    readiness: requestReadiness,
    sourceKind: normalized.source.kind,
  });
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
