"use strict";

/**
 * Read-only fake `gh` CLI fixture for relay-orca `status` tests (#945 D3/D10),
 * following the tests/relay-review/fixtures/fake-gh.js house pattern but hardened for
 * the read-only contract: it serves ONLY `gh issue view` and `gh pr view` reads (and
 * read-shaped `gh api` GETs). ANY other subcommand — pr merge, pr comment, issue
 * close, an `api` with a write method, etc. — writes a poison marker and exits
 * non-zero so the test hard-fails.
 *
 * Behavior is scenario-driven: `issues[<n>]` and `prs[<n>]` supply the JSON the pinned
 * D4 field lists (`state,stateReason` and `state,mergedAt,headRefOid`) return. Every
 * invocation is appended to a shared log.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultGhScenario(overrides = {}) {
  return {
    issues: overrides.issues || {},
    prs: overrides.prs || {},
  };
}

function fakeGhScript({ scenarioPath, logPath, poisonPath }) {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
const poisonPath = ${JSON.stringify(poisonPath)};

function appendLog(line) { if (logPath) fs.appendFileSync(logPath, line + "\\n", "utf-8"); }
appendLog(args.join(" "));
function loadScenario() { return JSON.parse(fs.readFileSync(scenarioPath, "utf-8")); }
function emit(payload, exitCode) { if (payload !== undefined && payload !== null) process.stdout.write(JSON.stringify(payload)); process.exit(typeof exitCode === "number" ? exitCode : 0); }
function poison(code) { if (poisonPath) fs.writeFileSync(poisonPath, "GH_WRITE_INVOKED:" + args.join(" "), "utf-8"); process.stderr.write("POISON: gh non-read subcommand must never run\\n"); process.exit(code); }

const isIssueView = args[0] === "issue" && args[1] === "view";
const isPrView = args[0] === "pr" && args[1] === "view";
const isApiWrite = args[0] === "api" && (args.some(function (t) { return t === "-X" || t === "--method"; }) || args.some(function (t) { return /^(POST|PATCH|PUT|DELETE)$/i.test(t); }));
const isApiRead = args[0] === "api" && !isApiWrite;

if (!isIssueView && !isPrView && !isApiRead) poison(92);

const scenario = loadScenario();

if (isIssueView) {
  const number = args[2];
  const issue = scenario.issues && scenario.issues[number];
  if (!issue) { process.stderr.write("issue not found\\n"); process.exit(1); }
  emit({ state: issue.state, stateReason: issue.stateReason === undefined ? null : issue.stateReason }, 0);
}
if (isPrView) {
  const number = args[2];
  const pr = scenario.prs && scenario.prs[number];
  if (!pr) { process.stderr.write("pr not found\\n"); process.exit(1); }
  emit({ state: pr.state, mergedAt: pr.mergedAt === undefined ? null : pr.mergedAt, headRefOid: pr.headRefOid === undefined ? null : pr.headRefOid }, 0);
}
if (isApiRead) emit({}, 0);

process.stderr.write("Unsupported fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function installFakeGh(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-orca-fake-gh-"));
  const ghPath = path.join(dir, options.binName || "gh");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const scenario = defaultGhScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  fs.writeFileSync(ghPath, fakeGhScript({ scenarioPath, logPath, poisonPath }), "utf-8");
  fs.chmodSync(ghPath, 0o755);

  return {
    dir,
    ghPath,
    scenarioPath,
    logPath,
    poisonPath,
    scenario,
    readLog() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    },
    readPoison() {
      if (!fs.existsSync(poisonPath)) return null;
      return fs.readFileSync(poisonPath, "utf-8");
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { defaultGhScenario, fakeGhScript, installFakeGh };
