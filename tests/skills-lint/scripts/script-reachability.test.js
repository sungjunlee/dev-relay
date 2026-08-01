const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const ADAPTER_INDEX_PATH = path.join(SKILLS_DIR, "relay-dispatch", "scripts", "adapters", "index.js");

const PACKAGED_SCRIPT_ALLOWLIST = [];

function toRepoRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function walkFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  entries.forEach((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, predicate));
      return;
    }
    if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  });
  return results;
}

function listPackagedSkillScripts(repoRoot = REPO_ROOT) {
  return walkFiles(path.join(repoRoot, "skills"), (filePath) => {
    return filePath.endsWith(".js") && toRepoRelative(filePath, repoRoot).includes("/scripts/");
  });
}

function listSkillSourceFiles(repoRoot = REPO_ROOT) {
  return walkFiles(path.join(repoRoot, "skills"), (filePath) => filePath.endsWith(".js"));
}

function listReferenceFiles(repoRoot = REPO_ROOT) {
  const skillsRoot = path.join(repoRoot, "skills");
  const skillDocs = walkFiles(skillsRoot, (filePath) => {
    if (path.basename(filePath) === "SKILL.md") return true;
    const relativePath = toRepoRelative(filePath, repoRoot);
    return /\/references\/.*\.md$/.test(relativePath);
  });
  return [
    ...skillDocs,
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, "CLAUDE.md"),
  ].filter((filePath) => fs.existsSync(filePath));
}

function resolveSkillScriptRequire(sourcePath, requestedPath) {
  if (!requestedPath.startsWith(".")) return null;
  const base = path.resolve(path.dirname(sourcePath), requestedPath);
  const candidates = [
    base,
    `${base}.js`,
    path.join(base, "index.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && candidate.endsWith(".js")) || null;
}

function addRequireReachability({ reachable, repoRoot, sourceFiles }) {
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  sourceFiles.forEach((sourcePath) => {
    const content = fs.readFileSync(sourcePath, "utf-8");
    requirePattern.lastIndex = 0;
    let match;
    while ((match = requirePattern.exec(content)) !== null) {
      const target = resolveSkillScriptRequire(sourcePath, match[1]);
      if (!target) continue;
      const relativeTarget = toRepoRelative(target, repoRoot);
      const relativeSource = toRepoRelative(sourcePath, repoRoot);
      if (relativeTarget.startsWith("skills/") && relativeTarget !== relativeSource) {
        reachable.add(relativeTarget);
      }
    }
  });
}

function addDocumentationReachability({ docs, reachable, repoRoot, scriptFiles }) {
  const combinedDocs = docs
    .map((docPath) => fs.readFileSync(docPath, "utf-8"))
    .join("\n");

  scriptFiles.forEach((scriptPath) => {
    const basename = path.basename(scriptPath);
    if (combinedDocs.includes(basename)) {
      reachable.add(toRepoRelative(scriptPath, repoRoot));
    }
  });
}

function addAdapterDescriptorReachability({ adapterIndexPath, reachable, repoRoot }) {
  if (!fs.existsSync(adapterIndexPath)) return;
  const { getAdapter, listAdapters } = require(adapterIndexPath);
  listAdapters().forEach((name) => {
    const scriptPath = getAdapter(name).metadata.reviewScript;
    if (scriptPath && fs.existsSync(scriptPath)) {
      reachable.add(toRepoRelative(scriptPath, repoRoot));
      reachable.add(toRepoRelative(fs.realpathSync(scriptPath), fs.realpathSync(repoRoot)));
    }
  });
}

function splitPathJoinArguments(rawArguments) {
  const args = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|__dirname/g;
  let match;
  while ((match = tokenPattern.exec(rawArguments)) !== null) {
    args.push(match[0] === "__dirname" ? "__dirname" : (match[1] ?? match[2]));
  }
  return args;
}

function addPathJoinSpawnReachability({ reachable, repoRoot, sourceFiles }) {
  const pathJoinPattern = /path\.join\s*\(([^)]*)\)/g;
  sourceFiles.forEach((sourcePath) => {
    const content = fs.readFileSync(sourcePath, "utf-8");
    pathJoinPattern.lastIndex = 0;
    let match;
    while ((match = pathJoinPattern.exec(content)) !== null) {
      const args = splitPathJoinArguments(match[1]);
      if (args[0] !== "__dirname" || !args.some((arg) => arg.endsWith(".js"))) continue;

      const resolved = path.resolve(path.dirname(sourcePath), ...args.slice(1));
      const relative = toRepoRelative(resolved, repoRoot);
      if (fs.existsSync(resolved) && relative.startsWith("skills/") && relative.includes("/scripts/")) {
        reachable.add(relative);
      }
    }
  });
}

function assertAllowlistEntriesExist({ allowlist, repoRoot }) {
  allowlist.forEach((relativePath) => {
    assert.ok(
      fs.existsSync(path.join(repoRoot, relativePath)),
      `script reachability allowlist entry no longer exists: ${relativePath}`,
    );
  });
}

function findUnreachableScripts({
  adapterIndexPath = ADAPTER_INDEX_PATH,
  allowlist = PACKAGED_SCRIPT_ALLOWLIST,
  docs,
  repoRoot = REPO_ROOT,
  scriptFiles,
  sourceFiles,
} = {}) {
  assertAllowlistEntriesExist({ allowlist, repoRoot });

  const packagedScripts = scriptFiles || listPackagedSkillScripts(repoRoot);
  const skillsSourceFiles = sourceFiles || listSkillSourceFiles(repoRoot);
  const referenceDocs = docs || listReferenceFiles(repoRoot);
  const reachable = new Set(allowlist);

  addRequireReachability({ reachable, repoRoot, sourceFiles: skillsSourceFiles });
  addDocumentationReachability({ docs: referenceDocs, reachable, repoRoot, scriptFiles: packagedScripts });
  addAdapterDescriptorReachability({ adapterIndexPath, reachable, repoRoot });
  addPathJoinSpawnReachability({ reachable, repoRoot, sourceFiles: skillsSourceFiles });

  return packagedScripts
    .map((scriptPath) => toRepoRelative(scriptPath, repoRoot))
    .filter((relativePath) => !reachable.has(relativePath))
    .sort();
}

function assertAllPackagedSkillScriptsReachable(options = {}) {
  const orphans = findUnreachableScripts(options);
  assert.deepEqual(
    orphans,
    [],
    `unreachable packaged skill scripts:\n${orphans.map((orphan) => `- ${orphan}`).join("\n")}`,
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function buildFixtureRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "script-reachability-"));
  writeFile(path.join(repoRoot, "README.md"), "Fixture docs mention documented-tool.js.\n");
  writeFile(path.join(repoRoot, "CLAUDE.md"), "Fixture guide.\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "SKILL.md"), "Run entrypoint.js.\n");
  writeFile(path.join(repoRoot, "skills", "relay-dispatch", "SKILL.md"), "Adapters are registered in adapters/index.js.\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "references", "tools.md"), "Use referenced-helper.js.\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "entrypoint.js"), 'require("./lib/extensionless");\nrequire("./spawner");\n');
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "lib", "extensionless.js"), "module.exports = {};\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "documented-tool.js"), "module.exports = {};\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "referenced-helper.js"), "module.exports = {};\n");
  writeFile(
    path.join(repoRoot, "skills", "fixture", "scripts", "spawner.js"),
    'const path = require("node:path");\npath.join(__dirname, "dynamic-worker.js");\n',
  );
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "dynamic-worker.js"), "module.exports = {};\n");
  writeFile(
    path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
    [
      "function listAdapters() { return ['fixture']; }",
      "function getAdapter() { return { metadata: { reviewScript: require('node:path').join(__dirname, '../../../relay-review/scripts/adapter-reviewer.js') } }; }",
      "module.exports = { getAdapter, listAdapters };",
      "",
    ].join("\n"),
  );
  writeFile(path.join(repoRoot, "skills", "relay-review", "scripts", "adapter-reviewer.js"), "module.exports = {};\n");
  return repoRoot;
}

test("scanner reports a planted orphan by exact file name", () => {
  const repoRoot = buildFixtureRepo();
  const orphanPath = path.join(repoRoot, "skills", "fixture", "scripts", "zz-orphan-probe.js");
  writeFile(orphanPath, "module.exports = {};\n");

  assert.throws(
    () => assertAllPackagedSkillScriptsReachable({
      adapterIndexPath: path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
      allowlist: [],
      repoRoot,
    }),
    /zz-orphan-probe\.js/,
  );
});

test("scanner recognizes require, documentation, rule 3 adapter descriptor, and rule 4 path.join dynamic reachability", () => {
  const repoRoot = buildFixtureRepo();
  const fixtureAdapter = require(path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"));
  assert.equal(fs.existsSync(fixtureAdapter.getAdapter("fixture").metadata.reviewScript), true);

  assertAllPackagedSkillScriptsReachable({
    adapterIndexPath: path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
    allowlist: [],
    repoRoot,
  });
});

test("generic flag-registry command registration alone does not count as script reachability", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "script-reachability-flag-registry-"));
  writeFile(path.join(repoRoot, "README.md"), "No command names here.\n");
  writeFile(path.join(repoRoot, "CLAUDE.md"), "No command names here.\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "SKILL.md"), "No script references here.\n");
  writeFile(path.join(repoRoot, "skills", "relay-dispatch", "SKILL.md"), "Adapter registry: adapters/index.js.\n");
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "flag-registry.js"), [
    "const COMMAND_FLAGS = {",
    "  'zz-orphan-probe': ['--json'],",
    "};",
    "module.exports = { COMMAND_FLAGS };",
    "",
  ].join("\n"));
  writeFile(path.join(repoRoot, "skills", "fixture", "scripts", "zz-orphan-probe.js"), "module.exports = {};\n");
  writeFile(
    path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
    "module.exports = { getAdapter: () => null, listAdapters: () => [] };\n",
  );

  assert.deepEqual(
    findUnreachableScripts({
      adapterIndexPath: path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
      allowlist: [],
      repoRoot,
    }),
    [
      "skills/fixture/scripts/flag-registry.js",
      "skills/fixture/scripts/zz-orphan-probe.js",
    ],
  );
});

test("allowlist entries must exist on disk", () => {
  const repoRoot = buildFixtureRepo();

  assert.throws(
    () => findUnreachableScripts({
      adapterIndexPath: path.join(repoRoot, "skills", "relay-dispatch", "scripts", "adapters", "index.js"),
      allowlist: ["skills/fixture/scripts/missing-convention-entry.js"],
      repoRoot,
    }),
    /allowlist entry no longer exists/,
  );
});

test("real adapter reviewer and executor scripts are reachable", () => {
  const orphans = new Set(findUnreachableScripts());
  [
    "skills/relay-dispatch/scripts/adapters/codex.js",
    "skills/relay-dispatch/scripts/adapters/opencode.js",
    "skills/relay-review/scripts/invoke-reviewer-codex.js",
    "skills/relay-review/scripts/invoke-reviewer-opencode.js",
  ].forEach((relativePath) => {
    assert.ok(!orphans.has(relativePath), `${relativePath} must be reachable`);
  });
});

test("all packaged skill scripts are reachable", () => {
  assertAllPackagedSkillScriptsReachable();
});
