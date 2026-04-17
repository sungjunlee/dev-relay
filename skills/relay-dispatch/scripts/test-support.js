const fs = require("fs");
const path = require("path");

const {
  ensureRunLayout,
  getRelayHome,
  readManifest,
  writeManifest,
} = require("./relay-manifest");
const {
  parseMigrationManifest,
  writeMigrationManifest,
} = require("./relay-migrate-rubric");

const DEFAULT_RUBRIC_PATH = "rubric.yaml";
const DEFAULT_ENFORCEMENT_RUBRIC = [
  "rubric:",
  "  factors:",
  "    - name: Default enforcement rubric",
  "      target: \">= 1/1\"",
].join("\n");

function createGrandfatheredRubricAnchor(overrides = {}) {
  return {
    from_migration: "rubric-mandatory.yaml",
    applied_at: "2026-04-17T08:00:05Z",
    actor: "test",
    reason: "test fixture grandfathered run",
    ...overrides,
  };
}

function registerGrandfatheredRubricMigration(runId, overrides = {}) {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error(`registerGrandfatheredRubricMigration requires a non-empty runId, got ${JSON.stringify(runId)}`);
  }

  const manifestPath = path.join(getRelayHome(), "migrations", "rubric-mandatory.yaml");
  const nextEntry = {
    run_id: runId,
    registered_by: "test-registration",
    registered_at: "2026-04-17T08:00:00Z",
    reason: "test fixture grandfathered run",
    applied_at: "2026-04-17T08:00:05Z",
    ...overrides,
  };

  let document = { version: 1, runs: [] };
  if (fs.existsSync(manifestPath)) {
    document = parseMigrationManifest(fs.readFileSync(manifestPath, "utf-8"), manifestPath);
  }

  document.runs = [
    ...(document.runs || []).filter((entry) => entry.run_id !== runId),
    nextEntry,
  ];
  writeMigrationManifest(manifestPath, document);
  return { manifestPath, entry: nextEntry };
}

function createEnforcementFixture({
  repoRoot,
  runId,
  manifestPath = null,
  state = "loaded",
  grandfather = false,
  legacy = false,
  rubricPath = undefined,
  rubricContent = DEFAULT_ENFORCEMENT_RUBRIC,
  anchorOverrides = {},
} = {}) {
  if (!repoRoot || !runId) {
    throw new Error("createEnforcementFixture requires repoRoot and runId");
  }

  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.rmSync(path.join(runDir, DEFAULT_RUBRIC_PATH), { recursive: true, force: true });
  fs.rmSync(path.join(runDir, "rubric-dir"), { recursive: true, force: true });

  let nextAnchor = {
    ...anchorOverrides,
  };
  delete nextAnchor.rubric_grandfathered;
  delete nextAnchor.rubric_path;

  if (grandfather) {
    nextAnchor.rubric_grandfathered = legacy
      ? true
      : createGrandfatheredRubricAnchor(
          typeof anchorOverrides.rubric_grandfathered === "object" && anchorOverrides.rubric_grandfathered !== null
            ? anchorOverrides.rubric_grandfathered
            : {}
        );
    if (!legacy) {
      registerGrandfatheredRubricMigration(runId, {
        applied_at: nextAnchor.rubric_grandfathered.applied_at,
        reason: nextAnchor.rubric_grandfathered.reason || "test fixture grandfathered run",
      });
    }
  } else {
    switch (state) {
      case "loaded":
      case "missing":
      case "empty":
        nextAnchor.rubric_path = rubricPath ?? DEFAULT_RUBRIC_PATH;
        break;
      case "outside_run_dir":
        nextAnchor.rubric_path = rubricPath ?? "../escape.yaml";
        break;
      case "invalid":
        nextAnchor.rubric_path = rubricPath ?? "rubric-dir";
        break;
      case "not_set":
        break;
      default:
        throw new Error(`Unsupported createEnforcementFixture state: ${state}`);
    }
  }

  if (grandfather) {
    // Explicit legacy bypass only; callers must opt in so enforcement remains the default.
  } else if (state === "loaded") {
    const fullPath = path.join(runDir, nextAnchor.rubric_path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, rubricContent, "utf-8");
  } else if (state === "empty") {
    const fullPath = path.join(runDir, nextAnchor.rubric_path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "   \n", "utf-8");
  } else if (state === "invalid") {
    fs.mkdirSync(path.join(runDir, nextAnchor.rubric_path), { recursive: true });
  }

  if (manifestPath) {
    const record = readManifest(manifestPath);
    // Merge into the existing persisted anchor so unrelated fields
    // (done_criteria_path, done_criteria_source, rubric_source, etc.)
    // are preserved. Only the rubric-related keys are owned by this helper.
    const existingAnchor = record.data.anchor || {};
    const mergedAnchor = { ...existingAnchor, ...nextAnchor };
    if (grandfather) {
      delete mergedAnchor.rubric_path;
    } else {
      delete mergedAnchor.rubric_grandfathered;
      if (state === "not_set") {
        delete mergedAnchor.rubric_path;
      }
    }
    writeManifest(manifestPath, {
      ...record.data,
      anchor: mergedAnchor,
    }, record.body);
    return {
      runDir,
      anchor: mergedAnchor,
      rubricPath: mergedAnchor.rubric_path || null,
      rubricContent,
    };
  }

  return {
    runDir,
    anchor: nextAnchor,
    rubricPath: nextAnchor.rubric_path || null,
    rubricContent,
  };
}

module.exports = {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createGrandfatheredRubricAnchor,
  createEnforcementFixture,
  registerGrandfatheredRubricMigration,
};
