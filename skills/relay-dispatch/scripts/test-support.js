const fs = require("fs");
const path = require("path");

const {
  ensureRunLayout,
  readManifest,
  writeManifest,
} = require("./relay-manifest");
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

function createEnforcementFixture({
  repoRoot,
  runId,
  manifestPath = null,
  state = "loaded",
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
  delete nextAnchor.rubric_path;

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

  if (state === "loaded") {
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
    if (state === "not_set") {
      delete mergedAnchor.rubric_path;
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
};
