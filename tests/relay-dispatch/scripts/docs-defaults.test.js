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
const {
  LIVE_DOGFOOD_READINESS_EXEMPTIONS,
  LIVE_DOGFOOD_SCENARIOS,
} = require("../../../skills/relay-dispatch/scripts/live-dogfood");

const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_SCRIPT = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const ADAPTER_PLATFORM_DOC = "skills/relay-dispatch/references/agent-adapter-platform.md";
const OPERATOR_GUIDE_DOC = "docs/relay-operator-guide.md";
const READINESS_STATUSES = Object.freeze([
  "stable",
  "limited",
  "fail-safe-experimental",
  "blocked",
  "not-supported",
]);
const LIVE_DOGFOOD_ADAPTERS = Object.freeze(["opencode", "pi", "antigravity"]);
const READINESS_ROLE_COLUMNS = Object.freeze([
  [1, "dispatch", "dispatch"],
  [2, "primary_review", "primary review"],
  [3, "advisory_review", "advisory review"],
]);

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

function operatorReadinessMatrix() {
  const doc = readRepoFile(OPERATOR_GUIDE_DOC);
  const start = doc.indexOf("## Adapter Readiness Matrix");
  assert.notEqual(start, -1, "operator guide must publish an adapter readiness matrix");
  const nextHeading = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);
  const adapterNames = new Set(listAgentAdapters().map((adapter) => adapter.name));
  return {
    section,
    rows: new Map(markdownTableRows(section)
      .map((cells) => {
        const name = cells[0].replace(/^`|`$/g, "");
        return [name, cells];
      })
      .filter(([name]) => adapterNames.has(name))),
  };
}

function readinessPair(cell) {
  const implementation = cell.match(/Implementation:\s*`([^`]+)`/i)?.[1];
  const live = cell.match(/Live:\s*`([^`]+)`/i)?.[1];
  return { implementation, live };
}

function rowsToText(cells) {
  return (cells || []).join(" ");
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
  assert.match(dispatchDocs, /--executor cursor/);
  assert.match(reviewDocs, /--reviewer pi/);
  assert.match(reviewDocs, /--reviewer antigravity/);
  assert.match(reviewDocs, /--reviewer cursor/);
  assert.match(readRepoFile(ADAPTER_PLATFORM_DOC), /agy`? CLI only/);
});

test("operator guide publishes adapter readiness matrix for every adapter and role", () => {
  const { section, rows } = operatorReadinessMatrix();
  const adapters = listAgentAdapters();

  for (const heading of ["Dispatch", "Primary review", "Advisory review"]) {
    assert.match(section, new RegExp(`\\| ${heading} `), `${heading} readiness column`);
  }

  assert.deepEqual([...rows.keys()].sort(), adapters.map((adapter) => adapter.name).sort());

  for (const adapter of adapters) {
    const row = rows.get(adapter.name);
    assert.ok(row, `${adapter.name} readiness row`);
    assert.equal(row.length, 4, `${adapter.name} readiness row has adapter plus three role cells`);

    for (const [index, role] of [
      [1, "dispatch"],
      [2, "primary review"],
      [3, "advisory review"],
    ]) {
      const pair = readinessPair(row[index]);
      assert.ok(pair.implementation, `${adapter.name} ${role} implementation status`);
      assert.ok(pair.live, `${adapter.name} ${role} live status`);
      assert.ok(READINESS_STATUSES.includes(pair.implementation), `${adapter.name} ${role} implementation status is allowed`);
      assert.ok(READINESS_STATUSES.includes(pair.live), `${adapter.name} ${role} live status is allowed`);
    }
  }

  for (const status of READINESS_STATUSES) {
    assert.match(section, new RegExp(`\`${status}\``), `${status} status is documented`);
  }
});

test("operator guide separates implementation parity from live promotion criteria", () => {
  const { section } = operatorReadinessMatrix();

  for (const issue of ["#609", "#610", "#611"]) {
    assert.match(section, new RegExp(issue), `${issue} source issue`);
  }

  assert.match(section, /Implementation[^.\n]*adapter surface/i);
  assert.match(section, /Live[^.\n]*dogfood evidence/i);
  assert.match(section, /fake-bin[^.\n]*unit tests[^.\n]*(?:insufficient|not sufficient|do not prove)/i);
  assert.match(section, /healthy live dogfood evidence[^.\n]*(?:required|promotion)/i);
  assert.match(section, /timeout[^.\n]*inconclusive/i);
  assert.match(section, /intentionally bounded fail-safe timeout canary/i);

  for (const adapter of ["pi", "opencode", "antigravity"]) {
    const row = rowsToText(operatorReadinessMatrix().rows.get(adapter));
    assert.match(row, /Live:\s*`(?!stable`)/i, `${adapter} live readiness is not published as stable without promotion evidence`);
  }
});

test("live dogfood metadata covers readiness matrix roles or explains exemptions", () => {
  const { rows } = operatorReadinessMatrix();
  const healthyScenarios = new Set(LIVE_DOGFOOD_SCENARIOS
    .filter((scenario) => scenario.healthyPromotion)
    .map((scenario) => `${scenario.adapter}:${scenario.phase}`));
  const exemptions = new Map(LIVE_DOGFOOD_READINESS_EXEMPTIONS
    .map((exemption) => [`${exemption.adapter}:${exemption.phase}`, exemption]));

  for (const adapter of LIVE_DOGFOOD_ADAPTERS) {
    const row = rows.get(adapter);
    assert.ok(row, `${adapter} readiness row`);

    for (const [index, phase, label] of READINESS_ROLE_COLUMNS) {
      const pair = readinessPair(row[index]);
      if (pair.implementation === "not-supported" && pair.live === "not-supported") {
        continue;
      }

      const key = `${adapter}:${phase}`;
      if (healthyScenarios.has(key)) {
        continue;
      }

      const exemption = exemptions.get(key);
      assert.ok(exemption, `${key} must have a healthy dogfood scenario or explicit exemption`);
      assert.equal(exemption.adapter, adapter);
      assert.equal(exemption.phase, phase);
      assert.ok(exemption.reason, `${key} exemption reason`);
      assert.match(rowsToText(row), exemption.readinessTextPattern, `${key} exemption tied to readiness wording for ${label}`);
    }
  }
});

test("operator-facing Antigravity docs keep live support marked fail-safe experimental", () => {
  const operatorDocs = [
    readRepoFile("README.md"),
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile(ADAPTER_PLATFORM_DOC),
  ].join("\n");

  assert.match(operatorDocs, /Antigravity[^.\n]*(?:fail-safe|fail safe)[^.\n]*experimental/i);
  assert.match(operatorDocs, /healthy live canary passes/i);
  assert.match(operatorDocs, /strict verdict JSON within timeout/i);
  assert.match(operatorDocs, /minimal repository change[^.\n]*recoverable\/reviewable state/i);
  assert.match(operatorDocs, /documented CLI limitation/i);
  assert.match(operatorDocs, /fail-safe timeout canary[^.\n]*(?:not|never)[^.\n]*healthy/i);
  assert.match(operatorDocs, /fake-bin tests alone/i);
  assert.match(operatorDocs, /review-runner\.js[^`]*--reviewer antigravity/i);
  assert.match(operatorDocs, /dispatch\.js[^`]*--executor antigravity/i);
  assert.match(operatorDocs, /failed\/escalated/i);
  assert.match(operatorDocs, /ready_to_merge/i);
  assert.doesNotMatch(operatorDocs, /Antigravity[^.\n]*(?:fully healthy|live healthy|live executor success|live reviewer success)[^.\n]*fake-bin/i);
});

test("operator docs publish the live dogfood harness and outcome meanings", () => {
  const docs = [
    readRepoFile("docs/relay-operator-guide.md"),
    readRepoFile("skills/relay-dispatch/references/operator-utilities.md"),
  ].join("\n");

  assert.match(docs, /live-dogfood\.js --repo \. --json --markdown/);
  assert.match(docs, /live-dogfood\.js --repo \. --dispatch-canary --json/);
  assert.match(docs, /temporary `RELAY_HOME`/);
  assert.match(docs, /scoped route policy/);
  assert.match(docs, /healthy dispatch canar(?:y|ies)[^.\n]*Pi[^.\n]*OpenCode[^.\n]*Antigravity/i);
  assert.match(docs, /clean worktree/i);
  assert.match(docs, /no-op[^.\n]*PR[^.\n]*(?:fail|failure|false success)/i);
  assert.match(docs, /fail-safe timeout canary[^.\n]*(?:not|never)[^.\n]*healthy/i);
  for (const outcome of ["pass", "fail-safe-pass", "timeout", "fail", "not-run"]) {
    assert.match(docs, new RegExp(`\`${outcome}\``));
  }
  assert.match(docs, /fake-bin regressions and live canary evidence are not conflated/);
});
