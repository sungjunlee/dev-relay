const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const {
  ADAPTER_PHASES,
} = require("../../../skills/relay-dispatch/scripts/adapters");
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
  const codexTimeout = getAdapter("codex").defaults.timeoutMs / 1000;
  const claudeTimeout = getAdapter("claude").defaults.timeoutMs / 1000;
  const opencodeTimeout = getAdapter("opencode").defaults.timeoutMs / 1000;
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("skills/relay-dispatch/SKILL.md"),
  ].join("\n");

  assert.match(docs, new RegExp(`codex:?\\s*${codexTimeout}`, "i"));
  assert.match(docs, new RegExp(`claude(?:/opencode)?[^\\n]*${claudeTimeout}`, "i"));
  assert.match(docs, new RegExp(`opencode[^\\n]*${opencodeTimeout}`, "i"));
});

test("dispatch help publishes the flat executor registry and vNext ownership boundary", () => {
  const result = spawnSync("node", [DISPATCH_SCRIPT, "--help"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.equal(result.status, 0, result.stderr);
  for (const name of listAdapters()) assert.match(result.stdout, new RegExp(`\\b${name}\\b`));
  assert.match(result.stdout, /Dispatch never commits, pushes, opens a PR, or runs recovery/);
});

test("recovery playbook documents only the canonical inspect/recover surface", () => {
  const playbook = readRepoFile("skills/relay-dispatch/references/recovery-playbook.md");

  assert.match(playbook, /relay-recover\.js inspect/);
  assert.match(playbook, /relay-recover\.js recover/);
  assert.match(playbook, /Retired verbs and their target-state\s+and force-policy flags fail closed/);
  assert.match(playbook, /accepts only `inspect` and `recover`/);
  assert.doesNotMatch(playbook, /remain temporary argv aliases/);
  assert.doesNotMatch(playbook, /generation ledger/);
  assert.doesNotMatch(playbook, /recover-state\.js[^\n]*--to/);
  assert.doesNotMatch(playbook, /recover-state\.js[^\n]*--force/);
});

test("executor prompt leaves Git metadata and publication exclusively to canonical recovery", () => {
  const prompt = readRepoFile("skills/relay/references/prompt-template.md");

  assert.match(prompt, /reviewable dirty-worktree changes/);
  assert.match(prompt, /canonical `relay-recover recover` alone commits, pushes/);
  assert.match(prompt, /Do not run `git add`, `git commit`, `git push`/);
  assert.doesNotMatch(prompt, /Do NOT skip the commit/);
  assert.doesNotMatch(prompt, /final work is committed/);
});

test("operator-facing OpenCode docs use the installed adapter contract", () => {
  const docs = [
    readRepoFile("skills/relay-dispatch/SKILL.md"),
    readRepoFile("skills/relay-dispatch/scripts/adapters/opencode.js"),
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
  assert.match(
    docs,
    /check --phase review --reviewer antigravity --model google\/antigravity-cli --json/,
  );
  assert.doesNotMatch(docs, /agy --model/);
});

test("adapter platform docs publish the flat four-method adapter contract", () => {
  const docs = [
    readRepoFile("AGENTS.md"),
    readRepoFile("CLAUDE.md"),
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("references/architecture.md"),
    readRepoFile(ADAPTER_PLATFORM_DOC),
  ].join("\n");

  assert.doesNotMatch(docs, /\b7-field\b/);
  assert.match(docs, /four-method/i);
  for (const field of [
    "capabilities",
    "buildInvocation",
    "parseOutcome",
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
  ]) {
    assert.match(doc, new RegExp(`\\| ${heading} `));
  }

  const rows = adapterMatrixRows();
  const adapters = listAdapters().map(getAdapter);
  assert.deepEqual([...rows.keys()].sort(), adapters.map((adapter) => adapter.name).sort());

  for (const adapter of adapters) {
    const row = rows.get(adapter.name);
    const dispatch = adapter.capabilities({ phase: ADAPTER_PHASES.DISPATCH }).supported === true;
    const primaryReview = adapter.capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported === true;
    assert.match(row[1], dispatch ? /^Yes\b/ : /^No\b/, `${adapter.name} dispatch docs`);
    assert.match(row[2], primaryReview ? /^Yes\b/ : /^No\b/, `${adapter.name} primary review docs`);
    assert.equal(row.length, 3, `${adapter.name} capability row`);
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

  for (const adapter of listAdapters().map(getAdapter)) {
    assert.match(overviewDocs, new RegExp(`\\b${adapter.name}\\b`, "i"), `${adapter.name} overview docs`);
    if (adapter.capabilities({ phase: ADAPTER_PHASES.DISPATCH }).supported) {
      assert.match(dispatchDocs, new RegExp(`\\b${adapter.name}\\b`), `${adapter.name} dispatch docs`);
    }
    if (adapter.capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported) {
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
  for (const adapter of listAdapters().map(getAdapter)) {
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

test("operator docs keep live adapter evidence test-only", () => {
  const docs = [
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("skills/relay-dispatch/references/operator-utilities.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /adapter-live-canary\.js|live-dogfood\.js/);
  assert.match(docs, /release-only/i);
  assert.match(docs, /read-only adapter canary/i);
});
