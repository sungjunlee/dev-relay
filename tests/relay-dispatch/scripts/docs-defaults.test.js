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
  assert.match(result.stdout, /auto-recover-commit.*default: on for codex, off otherwise/);
});

test("recovery playbook documents landed auto-recover behavior, not stale deferral", () => {
  const playbook = readRepoFile("skills/relay-dispatch/references/recovery-playbook.md");

  assert.match(playbook, /#393 added Path 2/);
  assert.match(playbook, /Codex `completed-uncommitted` results unless `--no-auto-recover-commit` is passed/);
  assert.match(playbook, /For Claude and opencode, `--auto-recover-commit` remains an explicit opt-in/);
  assert.doesNotMatch(playbook, /#393[^.\n]*(?:deferred|Until #393 lands)/i);
  assert.doesNotMatch(playbook, /defer to a follow-up issue/i);
});

test("operator-facing OpenCode docs reference install-carried policy docs", () => {
  const docs = [
    readRepoFile("skills/relay-dispatch/SKILL.md"),
    readRepoFile("skills/relay-dispatch/scripts/executors/README.md"),
    readRepoFile("skills/relay-dispatch/scripts/executors/opencode.js"),
    readRepoFile("skills/relay-dispatch/scripts/dispatch.js"),
    readRepoFile("skills/relay-sidecar/SKILL.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /docs\/reviewer-policy-opencode\.md/);
  assert.match(docs, /skills\/relay-dispatch\/references\/reviewer-policy-opencode\.md|relay-dispatch\/references\/reviewer-policy-opencode\.md/);
});

test("adapter platform docs publish the single 7-field executor contract", () => {
  const docs = [
    readRepoFile("AGENTS.md"),
    readRepoFile("CLAUDE.md"),
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
    "Advisory review",
    "Sandbox",
    "Read-only",
    "Network",
    "Structured output",
    "Transport",
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
    const advisoryReview = adapter.phases[ADAPTER_PHASES.ADVISORY_REVIEW]?.supported === true;
    assert.match(row[1], dispatch ? /^Yes\b/ : /^No\b/, `${adapter.name} dispatch docs`);
    assert.match(row[2], primaryReview ? /^Yes\b/ : /^No\b/, `${adapter.name} primary review docs`);
    assert.match(row[3], advisoryReview ? /^Yes\b/ : /^No\b/, `${adapter.name} advisory review docs`);
    assert.ok(row[4], `${adapter.name} sandbox docs`);
    assert.ok(row[5], `${adapter.name} read-only docs`);
    assert.ok(row[6], `${adapter.name} network docs`);
    assert.ok(row[7], `${adapter.name} structured output docs`);
    assert.ok(row[8], `${adapter.name} transport docs`);
    assert.match(row[9], adapter.capabilities.appRegistration.supported ? /^Yes\b/ : /^No\b/);
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
    if (adapter.phases[ADAPTER_PHASES.ADVISORY_REVIEW]?.supported) {
      assert.match(reviewDocs, new RegExp(`--advisory-reviewer ${adapter.name}\\b`), `${adapter.name} advisory review docs`);
    }
  }

  assert.match(dispatchDocs, /--executor pi/);
  assert.match(dispatchDocs, /--executor antigravity/);
  assert.match(reviewDocs, /--reviewer pi/);
  assert.match(reviewDocs, /--reviewer antigravity/);
  assert.match(readRepoFile(ADAPTER_PLATFORM_DOC), /agy`? CLI only/);
});
