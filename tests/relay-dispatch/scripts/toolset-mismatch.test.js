// #1158: a prompt that demands command execution dispatched to an executor whose dispatch toolset
// has no shell used to run to a silent no-op. Dispatch now rejects it before any durable state.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const { createNativeAdapter } = require("../../../skills/relay-dispatch/scripts/adapter-contract");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");

const ROOT = path.resolve(__dirname, "../../..");
const DISPATCH = path.join(ROOT, "skills/relay-dispatch/scripts/dispatch.js");
const FAKE_CODEX = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-codex.js");
const ADAPTER_RUNTIME_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-adapter-runtime-preload.js");

const COMMAND_PROMPT = "Fix the failing case, then run `node --test tests/relay-dispatch/scripts/*.test.js` before you finish.\n";
const GIT_COMMAND_PROMPT = "Apply the fix, then git commit the result on the dispatch branch.\n";
const EDIT_PROMPT = "Reword the readiness trigger in SKILL.md so it reads as orchestrator judgement rather than a scored gate. Keep the file under 150 lines and touch no other file.\n";

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-toolset-${label}-`)));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const rubric = path.join(root, "rubric.yaml");
  fs.writeFileSync(rubric, "done_criteria:\n  - change is reviewable\n");
  const commandPrompt = path.join(root, "command-prompt.md");
  fs.writeFileSync(commandPrompt, COMMAND_PROMPT);
  const editPrompt = path.join(root, "edit-prompt.md");
  fs.writeFileSync(editPrompt, EDIT_PROMPT);
  const benignPrompt = path.join(root, "benign-prompt.md");
  fs.writeFileSync(benignPrompt, "Implement the requested change.\n");
  fs.writeFileSync(path.join(bin, "codex"),
    fs.readFileSync(FAKE_CODEX, "utf8").replace(/^#![^\n]*/, `#!${process.execPath}`), { mode: 0o755 });
  const env = { ...process.env, RELAY_HOME: relayHome,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${ADAPTER_RUNTIME_PRELOAD}`].filter(Boolean).join(" "),
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { root, repo, relayHome, rubric, commandPrompt, editPrompt, benignPrompt, env };
}

function run(value, args) {
  return spawnSync(process.execPath, [DISPATCH, value.repo, ...args, "--network-access", "enabled", "--json"],
    { encoding: "utf8", env: value.env, timeout: 60_000 });
}

function json(text) { return JSON.parse(text); }

function fixtureRunsDir(value) {
  const canonical = fs.realpathSync(value.repo);
  const base = path.basename(canonical).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return path.join(value.relayHome, "runs", `${base}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`);
}

function probeDescriptor(dispatchPhase) {
  return {
    name: "probe", timeoutMs: 1000, outputProtocol: "text_stdout",
    metadata: {
      cliBinary: "probe", outputProtocol: "text_stdout", promptTransport: "stdin",
      processContainment: "inherited_scope_no_daemon", providerTransport: "remote_required",
      credentialTransport: "explicit_bundle",
      runtimeDependencies: { executableParent: null, interpreterParent: null },
      credentials: { files: [], envHints: [] },
    },
    phases: { dispatch: dispatchPhase, primary_review: { supported: false, reason: "probe" } },
    buildDispatch: () => ({ command: "probe", args: [], cwd: "/" }),
  };
}

test("every dispatch-capable adapter declares its command-execution toolset explicitly", () => {
  const declared = Object.fromEntries(listAdapters().map((name) =>
    [name, getAdapter(name).capabilities({ phase: "dispatch" }).commandExecution]));
  assert.deepEqual(declared, {
    claude: false, codex: true, opencode: true, pi: false, antigravity: true, cursor: true, cline: true,
  });
});

test("a dispatch-capable adapter cannot omit its command-execution declaration", () => {
  const base = { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" };
  assert.throws(() => createNativeAdapter(probeDescriptor(base)), /commandExecution/);
  assert.throws(() => createNativeAdapter(probeDescriptor({ ...base, commandExecution: "no" })), /commandExecution/);
  assert.equal(createNativeAdapter(probeDescriptor({ ...base, commandExecution: false }))
    .capabilities({ phase: "dispatch" }).commandExecution, false);
});

test("the command-demand detector matches every enumerated pattern and no plain edit brief", () => {
  const detect = dispatch.detectCommandExecutionDemand;
  const cases = [
    ["```bash\nls\n```", "fenced_shell_block"],
    ["~~~sh\nls\n~~~", "fenced_shell_block"],
    ["  ```shell\nls\n```", "fenced_shell_block"],
    ["```zsh\nls\n```", "fenced_shell_block"],
    ["node --test", "node_test"],
    ["node --test tests/relay-dispatch/scripts/*.test.js", "node_test"],
    ["npm test", "npm_test"],
    ["npm run lint", "npm_run"],
    ["npx skills add .", "npx"],
    ["git commit -m x", "git_write"],
    ["git push origin head", "git_write"],
    ["git rebase main", "git_write"],
    ["git merge --ff-only main", "git_write"],
    ["Run `./scripts/verify.sh` first.", "imperative_backticked_command"],
    ["Execute `make build` when done.", "imperative_backticked_command"],
  ];
  for (const [prompt, pattern] of cases) {
    assert.equal(detect(prompt)?.pattern, pattern, prompt);
  }
  assert.equal(detect(COMMAND_PROMPT).pattern, "node_test");
  assert.equal(detect(COMMAND_PROMPT).evidence, "node --test");
  assert.equal(detect(Buffer.from(GIT_COMMAND_PROMPT, "utf8")).pattern, "git_write");
  for (const clean of [
    EDIT_PROMPT,
    "Keep each SKILL.md under 150 lines and move operator playbooks to references/.",
    "Delete the migration overlay and its `run.json` writer generation field.",
    "Document that the runner executes nothing on its own.",
    "```js\nconst x = 1;\n```",
    "",
  ]) {
    assert.equal(detect(clean), null, clean);
  }
});

// DC6-a
test("pi rejects a command-demanding prompt-file before claiming any run directory", () => {
  const value = fixture("pi-prompt-file");
  const result = run(value, ["--executor", "pi", "--branch", "pi-command", "--prompt-file", value.commandPrompt, "--rubric-file", value.rubric]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(json(result.stderr).code, "TOOLSET_MISMATCH");
  assert.match(json(result.stderr).error, /executor 'pi'/);
  assert.match(json(result.stderr).error, /node --test/);
  assert.match(json(result.stderr).error, /--allow-toolset-mismatch/);
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false, "no run directory may be claimed");
  assert.equal(fs.existsSync(value.relayHome), false, "no relay home state may be created");
  assert.equal(git(value.repo, ["branch", "--list", "pi-command"]), "", "no branch may be created");
});

// DC6-b
test("claude rejects a command-demanding inline prompt", () => {
  const value = fixture("claude-inline");
  const result = run(value, ["--executor", "claude", "--branch", "claude-command", "--prompt", GIT_COMMAND_PROMPT, "--rubric-file", value.rubric]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(json(result.stderr).code, "TOOLSET_MISMATCH");
  assert.match(json(result.stderr).error, /executor 'claude'/);
  assert.match(json(result.stderr).error, /git commit/);
  assert.equal(fs.existsSync(value.relayHome), false);
  assert.equal(git(value.repo, ["branch", "--list", "claude-command"]), "");
});

// DC3 entry state 4
test("the detached form of a mismatched dispatch fails closed without spawning a run", () => {
  const value = fixture("pi-detached");
  const result = run(value, ["--executor", "pi", "--branch", "pi-detached", "--prompt-file", value.commandPrompt, "--rubric-file", value.rubric, "--detach"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(json(result.stderr).code, "TOOLSET_MISMATCH");
  assert.equal(fs.existsSync(value.relayHome), false);
  assert.equal(git(value.repo, ["branch", "--list", "pi-detached"]), "");
});

// DC6-c
test("pi passes validation for a pure edit brief", () => {
  const value = fixture("pi-edit");
  const result = run(value, ["--executor", "pi", "--branch", "pi-edit", "--prompt-file", value.editPrompt, "--rubric-file", value.rubric, "--dry-run"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).executor, "pi");
  assert.doesNotMatch(result.stderr, /toolset mismatch/);
});

// DC6-d
test("--allow-toolset-mismatch downgrades the rejection to one stderr warning and proceeds", () => {
  const value = fixture("pi-override");
  const result = run(value, ["--executor", "pi", "--branch", "pi-override", "--prompt-file", value.commandPrompt,
    "--rubric-file", value.rubric, "--allow-toolset-mismatch", "--dry-run"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).executor, "pi");
  assert.match(result.stderr, /warning: toolset mismatch/);
  assert.match(result.stderr, /--allow-toolset-mismatch/);
  assert.equal(result.stderr.match(/toolset mismatch/g).length, 1, "exactly one warning");
});

// DC5 / DC6-e
test("a shell-capable executor is unaffected by the same command-demanding prompt", () => {
  const value = fixture("codex-unaffected");
  const result = run(value, ["--executor", "codex", "--branch", "codex-command", "--prompt-file", value.commandPrompt, "--rubric-file", value.rubric, "--dry-run"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).executor, "codex");
  assert.doesNotMatch(result.stderr, /toolset mismatch/i);
});

// DC6-f. The gate is bound to the requested executor and runs before the run record is read, so the
// resume is rejected for the toolset, not for the executor binding or the derived action. Asserting
// the exact code is what makes this red when the gate is removed: without it the resume still fails,
// but as RUN_NOT_REDISPATCHABLE, and after appending nothing either way.
test("a mismatched resume is rejected with no attempt_started fact appended", () => {
  const value = fixture("resume");
  const created = run(value, ["--branch", "resume-base", "--prompt-file", value.benignPrompt, "--rubric-file", value.rubric]);
  assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
  const output = json(created.stdout);
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const before = facts.readFacts({ eventsPath }).facts;
  const beforeFiles = fs.readdirSync(output.run_dir).sort();

  const resumed = run(value, ["--run-id", output.run_id, "--executor", "pi", "--prompt-file", value.commandPrompt]);
  assert.notEqual(resumed.status, 0, resumed.stdout);
  assert.equal(json(resumed.stderr).code, "TOOLSET_MISMATCH");
  assert.deepEqual(facts.readFacts({ eventsPath }).facts, before, "no fact may be appended");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles, "no prompt or attempt artifact may be written");
});

test("dispatch usage publishes the override flag", () => {
  const result = spawnSync(process.execPath, [DISPATCH, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--allow-toolset-mismatch/);
});
