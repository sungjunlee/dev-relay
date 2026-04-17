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

function createEnforcementFixture({
  repoRoot,
  runId,
  manifestPath = null,
  state = "loaded",
  grandfather = false,
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
    nextAnchor.rubric_grandfathered = true;
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
    writeManifest(manifestPath, {
      ...record.data,
      anchor: nextAnchor,
    }, record.body);
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
  createEnforcementFixture,
};
