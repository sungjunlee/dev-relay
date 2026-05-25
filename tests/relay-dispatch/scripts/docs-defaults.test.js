const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getExecutor } = require("../../../skills/relay-dispatch/scripts/executors");

const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_SCRIPT = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
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
