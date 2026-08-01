const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getExecutor } = require("../../../skills/relay-dispatch/scripts/executors");
const {
  ADAPTER_PHASES,
  listAgentAdapters,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters");
const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_SCRIPT = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const ADAPTER_PLATFORM_DOC = "skills/relay-dispatch/references/agent-adapter-platform.md";
const OPERATOR_GUIDE_DOC = "docs/relay-operator-guide.md";

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

function markdownTableRows(text) {
  return text
    .split("\n")
    .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map((line) => line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()));
}

function adapterMatrixRows() {
  const doc = readRepoFile(ADAPTER_PLATFORM_DOC);
  const matrix = doc.slice(
    doc.indexOf("## Capability Matrix"),
    doc.indexOf("## New Adapter Checklist")
  );
  return new Map(markdownTableRows(matrix).map((cells) => {
    const name = cells[0].replace(/^`|`$/g, "");
    return [name, cells];
  }));
}


test("dispatch docs mirror executor timeout defaults", () => {
  const codexTimeout = getExecutor("codex").defaultTimeout;
  const claudeTimeout = getExecutor("claude").defaultTimeout;
  const opencodeTimeout = getExecutor("opencode").defaultTimeout;
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("skills/relay-dispatch/SKILL.md"),
  ].join("\n");

  assert.match(docs, new RegExp(`codex:?\\s*${codexTimeout}`, "i"));
  assert.match(docs, new RegExp(`claude(?:/opencode)?[^\\n]*${claudeTimeout}`, "i"));
  assert.match(docs, new RegExp(`opencode[^\\n]*${opencodeTimeout}`, "i"));
});

test("dispatch help mirrors executor timeout and auto-recover defaults", () => {
  const result = spawnSync("node", [DISPATCH_SCRIPT, "--help"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /default: 2400 for codex, 1800 for others/);
  assert.match(result.stdout, /auto-recover-commit.*default: on/);
});

test("recovery playbook documents landed auto-recover behavior, not stale deferral", () => {
  const playbook = readRepoFile("skills/relay-dispatch/references/recovery-playbook.md");

  assert.match(playbook, /#393 added Path 2/);
  assert.match(playbook, /all executor `completed-uncommitted` results unless `--no-auto-recover-commit` is passed/);
  assert.doesNotMatch(playbook, /#393[^.\n]*(?:deferred|Until #393 lands)/i);
  assert.doesNotMatch(playbook, /defer to a follow-up issue/i);
});

test("operator-facing OpenCode docs use the installed adapter contract", () => {
  const docs = [
    readRepoFile("skills/relay-dispatch/SKILL.md"),
    readRepoFile("skills/relay-dispatch/scripts/executors/README.md"),
    readRepoFile("skills/relay-dispatch/scripts/executors/opencode.js"),
    readRepoFile("skills/relay-dispatch/scripts/dispatch.js"),
  ].join("\n");

  assert.doesNotMatch(docs, /docs\/reviewer-policy-opencode\.md/);
  assert.doesNotMatch(docs, /reviewer-policy-opencode\.md/);
  assert.match(docs, /agent-adapter-platform\.md/);
  assert.match(docs, /independent primary review remains required/i);
});

test("model selection docs describe explicit bindings without legacy route configuration", () => {
  const docs = [
    readRepoFile("docs/model-route-policy.md"),
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("references/architecture.md"),
  ].join("\n");

  for (const phrase of [
    "~/.relay/projects/<repo-slug>/project.json",
    "~/.relay/projects/<repo-slug>/policy.json",
    "~/.relay/projects/<repo-slug>/routes.json",
    "route-plan.json",
    "relay-config plan-run",
    "--route-intent-file",
  ]) {
    assert.doesNotMatch(docs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const phrase of [
    "example/opencode-model-fast",
    "example/pi-model-fast",
    "google/antigravity-cli",
  ]) {
    assert.match(docs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(docs, /explicit.*model|model.*explicit/i);
  assert.match(docs, /adapter.*capability|capability.*adapter/i);
  assert.match(docs, /check review antigravity google\/antigravity-cli --json/);
  assert.doesNotMatch(docs, /agy --model/);
});

test("adapter platform docs publish the single 7-field executor contract", () => {
  const docs = [
    readRepoFile("AGENTS.md"),
    readRepoFile("CLAUDE.md"),
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("references/architecture.md"),
    readRepoFile("skills/relay-dispatch/scripts/executors/README.md"),
    readRepoFile(ADAPTER_PLATFORM_DOC),
  ].join("\n");

  assert.doesNotMatch(docs, /\b6-field\b/);
  assert.match(docs, /\b7-field\b/);
  for (const field of [
    "cliBinary",
    "defaultTimeout",
    "validateExecutionMode",
    "buildExecCommand",
    "finalizeResult",
    "register",
    "probe",
  ]) {
    assert.match(readRepoFile(ADAPTER_PLATFORM_DOC), new RegExp(`\\b${field}\\b`));
  }
});

test("adapter capability matrix mirrors supported adapter phase registry", () => {
  const doc = readRepoFile(ADAPTER_PLATFORM_DOC);
  for (const heading of [
    "Dispatch",
    "Primary review",
    "App registration",
  ]) {
    assert.match(doc, new RegExp(`\\| ${heading} `));
  }

  const rows = adapterMatrixRows();
  const adapters = listAgentAdapters();
  assert.deepEqual([...rows.keys()].sort(), adapters.map((adapter) => adapter.name).sort());

  for (const adapter of adapters) {
    const row = rows.get(adapter.name);
    const dispatch = adapter.phases[ADAPTER_PHASES.DISPATCH]?.supported === true;
    const primaryReview = adapter.phases[ADAPTER_PHASES.PRIMARY_REVIEW]?.supported === true;
    assert.match(row[1], dispatch ? /^Yes\b/ : /^No\b/, `${adapter.name} dispatch docs`);
    assert.match(row[2], primaryReview ? /^Yes\b/ : /^No\b/, `${adapter.name} primary review docs`);
    if (adapter.capabilities.appRegistration.supported) {
      assert.doesNotMatch(row[3], /^No\b/);
    } else {
      assert.match(row[3], /^No\b/);
    }
  }
});

test("operator docs mention every supported dispatch and review adapter", () => {
  const dispatchDocs = readRepoFile("skills/relay-dispatch/SKILL.md");
  const reviewDocs = readRepoFile("skills/relay-review/SKILL.md");
  const overviewDocs = [
    readRepoFile("README.md"),
    readRepoFile("references/architecture.md"),
    readRepoFile(ADAPTER_PLATFORM_DOC),
  ].join("\n");

  for (const adapter of listAgentAdapters()) {
    assert.match(overviewDocs, new RegExp(`\\b${adapter.name}\\b`, "i"), `${adapter.name} overview docs`);
    if (adapter.phases[ADAPTER_PHASES.DISPATCH]?.supported) {
      assert.match(dispatchDocs, new RegExp(`\\b${adapter.name}\\b`), `${adapter.name} dispatch docs`);
    }
    if (adapter.phases[ADAPTER_PHASES.PRIMARY_REVIEW]?.supported) {
      assert.match(reviewDocs, new RegExp(`--reviewer ${adapter.name}\\b`), `${adapter.name} primary review docs`);
    }
  }

  assert.match(readRepoFile(ADAPTER_PLATFORM_DOC), /agy`? CLI only/);
});

test("operator guide readiness mirrors the current adapter contract", () => {
  const doc = readRepoFile(OPERATOR_GUIDE_DOC);
  const start = doc.indexOf("## Adapter Readiness Matrix");
  const end = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  assert.notEqual(start, -1, "operator guide must publish adapter readiness");
  assert.match(section, /agent-adapter-platform\.md/);
  for (const adapter of listAgentAdapters()) {
    assert.match(section, new RegExp(`\\b${adapter.name}\\b`, "i"), `${adapter.name} readiness`);
  }
  assert.match(section, /Cline is dispatch-only/);
  assert.doesNotMatch(section, /advisory review/i);
});

test("operator guide teaches default and manual workflows before adapter readiness", () => {
  const doc = readRepoFile(OPERATOR_GUIDE_DOC);
  const defaultWorkflowIndex = doc.indexOf("## Default Workflow");
  const skillsIndex = doc.indexOf("## Skills");
  const manualPhaseIndex = doc.indexOf("## Manual Phase Control");
  const matrixIndex = doc.indexOf("## Adapter Readiness Matrix");

  assert.notEqual(defaultWorkflowIndex, -1, "operator guide must document the default workflow");
  assert.notEqual(skillsIndex, -1, "operator guide must document the skill surface before advanced adapter readiness");
  assert.notEqual(manualPhaseIndex, -1, "operator guide must document manual phase control before advanced adapter readiness");
  assert.notEqual(matrixIndex, -1, "operator guide must publish adapter readiness after the default path");
  assert.ok(defaultWorkflowIndex < matrixIndex, "default workflow must appear before adapter readiness");
  assert.ok(defaultWorkflowIndex < skillsIndex, "default workflow must appear before the skill surface");
  assert.ok(skillsIndex < matrixIndex, "skill surface must appear before adapter readiness");
  assert.ok(skillsIndex < manualPhaseIndex, "skill surface must appear before manual phase control");
  assert.ok(manualPhaseIndex < matrixIndex, "manual phase control must appear before adapter readiness");
});

test("operator docs publish the live dogfood harness and outcome meanings", () => {
  const docs = [
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("skills/relay-dispatch/references/operator-utilities.md"),
  ].join("\n");

  assert.match(docs, /live-dogfood\.js --repo \.[\s\S]*--pi-model '<pi-provider>\/<pi-model>'[\s\S]*--opencode-model '<opencode-provider>\/<opencode-model>'[\s\S]*--json --markdown/);
  assert.match(docs, /live-dogfood\.js --repo \.[\s\S]*--pi-model '<pi-provider>\/<pi-model>'[\s\S]*--opencode-model '<opencode-provider>\/<opencode-model>'[\s\S]*--dispatch-canary --json/);
  assert.match(docs, /RELAY_LIVE_DOGFOOD_PI_MODEL/);
  assert.match(docs, /RELAY_LIVE_DOGFOOD_OPENCODE_MODEL/);
  assert.match(docs, /--scenario <name>/);
  assert.match(docs, /temporary `RELAY_HOME`/);
  assert.match(docs, /without writing project configuration/);
  assert.match(docs, /healthy dispatch canar(?:y|ies)[^.\n]*Pi[^.\n]*OpenCode[^.\n]*Antigravity/i);
  assert.match(docs, /clean worktree/i);
  assert.match(docs, /no-op[^.\n]*PR[^.\n]*(?:fail|failure|false success)/i);
  assert.match(docs, /fail-safe timeout canary[^.\n]*(?:not|never)[^.\n]*healthy/i);
  for (const outcome of ["pass", "fail-safe-pass", "timeout", "fail", "not-run"]) {
    assert.match(docs, new RegExp(`\`${outcome}\``));
  }
  assert.match(docs, /fake-bin regressions and live canary evidence are not conflated/);
});
