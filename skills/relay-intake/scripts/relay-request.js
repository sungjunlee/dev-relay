const fs = require("fs");
const path = require("path");

const {
  getActorName,
  getRelayHome,
  getRepoSlug,
  parseFrontmatter,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

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

function appendRequestEvent(repoRoot, requestId, eventData) {
  if (!requestId) {
    throw new Error("request_id is required to append a relay-intake event");
  }
  if (!String(eventData?.event || "").trim()) {
    throw new Error("event is required to append a relay-intake event");
  }

  const { eventsPath } = ensureRequestLayout(repoRoot, requestId);
  const record = {
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
    source: {
      kind: normalized.source.kind,
    },
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
    title: normalized.handoff.title,
    sourceKind: normalized.source.kind,
  };
}

module.exports = {
  appendRequestEvent,
  createRequestId,
  ensureRequestLayout,
  getRequestDir,
  getRequestEventsPath,
  getRequestPath,
  getRequestsBase,
  getRequestsDir,
  normalizeSingleLeafContract,
  persistRequestContract,
  readRequestArtifact,
  readRequestEvents,
};
