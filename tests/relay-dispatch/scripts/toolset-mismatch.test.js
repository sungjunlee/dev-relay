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
const FAKE_CODEX = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-codex.js");
const ADAPTER_RUNTIME_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/adapter-runtime-preload.js");
const READ_ONCE_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-prompt-read-once-preload.js");
const UNDECLARED_ADAPTER_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-undeclared-adapter-preload.js");
const REGISTRY_DIVERGENCE_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-registry-divergence-preload.js");

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

function run(value, args, extraEnv = {}) {
  return spawnSync(process.execPath, [DISPATCH, value.repo, ...args, "--network-access", "enabled", "--json"],
    { encoding: "utf8", env: { ...value.env, ...extraEnv }, timeout: 60_000 });
}

function preloadEnv(value, preload, extra = {}) {
  return { NODE_OPTIONS: `${value.env.NODE_OPTIONS} --require=${preload}`, ...extra };
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
      runtimeDependencies: { executableParent: null, interpreterParent: null },
    },
    phases: { dispatch: dispatchPhase, primary_review: { supported: false, reason: "probe" } },
    buildDispatch: () => ({ command: "probe", args: [], cwd: "/" }),
  };
}

test("every dispatch-capable adapter declares its command-execution toolset explicitly", () => {
  const declared = Object.fromEntries(listAdapters().map((name) =>
    [name, getAdapter(name).capabilities({ phase: "dispatch" }).commandExecution]));
  assert.deepEqual(declared, {
    claude: true, codex: true, opencode: true, pi: false, antigravity: true, cursor: true, cline: true,
  });
});

test("a dispatch-capable adapter cannot omit its command-execution declaration", () => {
  const base = { supported: true, write: true, readOnly: false, networkControl: "informational", filesystemIsolation: "none", cancellation: "process", structuredOutput: "text" };
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

// Claude dispatch now permits Bash inside its native Bash sandbox.
test("claude accepts a command-demanding inline prompt", () => {
  const value = fixture("claude-inline");
  const result = run(value, ["--executor", "claude", "--branch", "claude-command", "--prompt", GIT_COMMAND_PROMPT, "--rubric-file", value.rubric, "--dry-run"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).executor, "claude");
  assert.doesNotMatch(result.stderr, /toolset mismatch/);
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

// DC6-f. Resume resolves the immutable executor before it reads or validates the new prompt. An
// explicit mismatch therefore fails at the executor binding rather than evaluating the wrong
// adapter's toolset, while preserving the same zero-write boundary.
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
  assert.equal(json(resumed.stderr).code, "RUN_EXECUTOR_MISMATCH");
  assert.deepEqual(facts.readFacts({ eventsPath }).facts, before, "no fact may be appended");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles, "no prompt or attempt artifact may be written");
});

// #1173 DC1-f. The preload lets the prompt path be read exactly once; a shell-less executor is
// required because a shell-capable one returns from the gate before reading anything. The observable
// is the CLI's own exit status: a second read finds the file gone and the process fails.
test("a shell-less dispatch validates and consumes the prompt in one read", () => {
  const value = fixture("pi-read-once");
  const result = run(value, ["--executor", "pi", "--branch", "pi-read-once", "--prompt-file", value.editPrompt,
    "--rubric-file", value.rubric, "--dry-run"],
  preloadEnv(value, READ_ONCE_PRELOAD, { RELAY_TEST_READ_ONCE_PATH: value.editPrompt }));
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).executor, "pi");
  assert.equal(fs.existsSync(value.editPrompt), false, "the one allowed read must have happened");
});

// #1173 DC1-a. The create path stamps prompt-<attemptId>.md from the same buffer the gate validated,
// so the one allowed read still has to carry the whole dispatch.
test("the create path stamps its attempt prompt from that single read", () => {
  const value = fixture("codex-read-once");
  const result = run(value, ["--branch", "codex-read-once", "--prompt-file", value.benignPrompt, "--rubric-file", value.rubric],
    preloadEnv(value, READ_ONCE_PRELOAD, { RELAY_TEST_READ_ONCE_PATH: value.benignPrompt }));
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.equal(fs.existsSync(value.benignPrompt), false, "the one allowed read must have happened");
  assert.equal(fs.readFileSync(path.join(output.run_dir, `prompt-${output.attempt_id}.md`), "utf8"),
    "Implement the requested change.\n");
});

// #1173 DC2-d. createNativeAdapter's mandatory declaration only binds adapters built through it. An
// adapter injected into the registry as a plain object arrives undeclared, and the gate used to read
// that as shell-capable and fail open. Driven as a real dispatch: under --dry-run nothing durable is
// written either way, so the state assertions would hold with the gate absent and prove nothing.
test("an adapter that never passed createNativeAdapter is rejected as undeclared", () => {
  const value = fixture("undeclared");
  const env = preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD);
  const result = run(value, ["--executor", "pi", "--branch", "undeclared", "--prompt-file", value.benignPrompt,
    "--rubric-file", value.rubric], env);
  assert.notEqual(result.status, 0, result.stdout);
  // State before code: a bypass reaches a real dispatch, which exits non-zero on its own and writes
  // nothing to stderr, so parsing stderr first would abort the test before these ever ran.
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false, "no run directory may be claimed");
  assert.equal(fs.existsSync(value.relayHome), false, "no relay home state may be created");
  assert.equal(git(value.repo, ["branch", "--list", "undeclared"]), "", "no branch may be created");
  assert.equal(json(result.stderr).code, "TOOLSET_UNDECLARED");
  assert.match(json(result.stderr).error, /executor 'pi'/);
  assert.match(json(result.stderr).error, /commandExecution/);
  // The rogue is otherwise complete: with the assert removed this same shape reaches a built
  // invocation and exits 0, so the guard flips a success into a rejection rather than trading one
  // failure for another. No state assertions here — a dry run has none to make.
  const dry = run(value, ["--executor", "pi", "--branch", "undeclared-dry", "--prompt-file", value.benignPrompt,
    "--rubric-file", value.rubric, "--dry-run"], env);
  assert.notEqual(dry.status, 0, dry.stdout);
  assert.equal(json(dry.stderr).code, "TOOLSET_UNDECLARED");
});

// #1173 round 2. The gate's assert is unconditional. A capability that reports `supported` from the
// request answers false here, where the gate passes none, and true to validateCapabilities, which
// passes one — so qualifying the assert with `supported` let a command-demanding prompt through both
// gates to a shell-less executor, claiming a run directory, branch, and worktree on the way.
test("a request-dependent supported flag cannot smuggle an undeclared adapter past the gate", () => {
  const value = fixture("request-dependent");
  const result = run(value, ["--executor", "pi", "--branch", "request-dependent", "--prompt-file", value.commandPrompt,
    "--rubric-file", value.rubric], preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD, { RELAY_TEST_ROGUE_SUPPORTED: "request-dependent" }));
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false, "no run directory may be claimed");
  assert.equal(fs.existsSync(value.relayHome), false, "no relay home state may be created");
  assert.equal(git(value.repo, ["branch", "--list", "request-dependent"]), "", "no branch may be created");
  assert.equal(json(result.stderr).code, "TOOLSET_UNDECLARED");
});

// #1173 round 3. The gate reads the declaration once. Reading the property twice let an accessor
// answer false to the typeof check and true to the decision, skipping the demand detector entirely —
// item 1's swap, reintroduced inside item 2's own guard.
test("an alternating commandExecution accessor cannot skip the demand detector", () => {
  const value = fixture("alternating");
  const result = run(value, ["--executor", "pi", "--branch", "alternating", "--prompt-file", value.commandPrompt,
    "--rubric-file", value.rubric], preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD, { RELAY_TEST_ROGUE_ALTERNATING: "1" }));
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false, "no run directory may be claimed");
  assert.equal(fs.existsSync(value.relayHome), false, "no relay home state may be created");
  assert.equal(git(value.repo, ["branch", "--list", "alternating"]), "", "no branch may be created");
  assert.equal(json(result.stderr).code, "TOOLSET_MISMATCH");
});

// #1173 round 2. An adapter that is both unsupported and undeclared is rejected here, not deferred to
// validateCapabilities: this is what pins the absence of a `supported` qualifier on the assert.
test("an unsupported dispatch phase does not exempt an adapter from declaring its toolset", () => {
  const value = fixture("unsupported-undeclared");
  const result = run(value, ["--executor", "pi", "--branch", "unsupported-undeclared", "--prompt-file", value.benignPrompt,
    "--rubric-file", value.rubric], preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD, { RELAY_TEST_ROGUE_SUPPORTED: "false" }));
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(fs.existsSync(value.relayHome), false, "no relay home state may be created");
  assert.equal(json(result.stderr).code, "TOOLSET_UNDECLARED");
  // Positive control for the knob itself: undeclared alone already fails above, so without this the
  // test would pass unchanged if RELAY_TEST_ROGUE_SUPPORTED were silently misspelled and never took
  // effect. Declaring commandExecution isolates `supported`, whose only remaining effect is the
  // downstream validateCapabilities rejection.
  const declaredToo = run(value, ["--executor", "pi", "--branch", "unsupported-declared", "--prompt-file", value.benignPrompt,
    "--rubric-file", value.rubric, "--dry-run"], preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD,
    { RELAY_TEST_ROGUE_SUPPORTED: "false", RELAY_TEST_ROGUE_COMMAND_EXECUTION: "false" }));
  assert.notEqual(declaredToo.status, 0, declaredToo.stdout);
  assert.equal(json(declaredToo.stderr).code, "DISPATCH_FAILED");
  assert.match(json(declaredToo.stderr).error, /phase is unsupported/);
});

// #1173 round 4. Three separate getAdapter calls let a rogue registry hand the gate one genuine
// descriptor and the dispatch another: it validated shell-capable codex and then ran a
// command-demanding prompt on shell-less claude, with no fabricated object and no false declaration
// anywhere. Requesting claude is deliberate — if this fixture ever goes inert the real registry
// answers claude, the gate rejects the prompt, and this test fails instead of quietly passing.
test("a registry that answers each resolution differently cannot split the gate from the dispatch", () => {
  const value = fixture("registry-divergence");
  const result = run(value, ["--executor", "claude", "--branch", "registry-divergence",
    "--prompt-file", value.commandPrompt, "--rubric-file", value.rubric], preloadEnv(value, REGISTRY_DIVERGENCE_PRELOAD));
  // The gate cannot stop this run and is not meant to: it validated a genuinely shell-capable
  // descriptor, so dispatch proceeds and durable state is produced. What one resolution buys is that
  // the adapter the gate validated is the adapter that dispatched, which is why the recorded executor
  // is the observable. A registry free to misroute claude to codex remains outside any toolset gate.
  const runsDir = fixtureRunsDir(value);
  assert.equal(fs.existsSync(runsDir), true, `${result.stderr}\n${result.stdout}`);
  const runDir = path.join(runsDir, fs.readdirSync(runsDir)[0]);
  const started = facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") }).facts
    .find((fact) => fact.type === "attempt_started");
  assert.equal(started?.payload.executor, "codex", "the executor that dispatched must be the one the gate validated");
});

// #1173 round 2. An unknown executor is an argv error; resolving the adapter before the prompt read
// keeps it from being reported as a missing file.
test("an unknown executor is reported before the prompt file is read", () => {
  const value = fixture("unknown-executor");
  const result = run(value, ["--executor", "nosuch", "--branch", "unknown-executor",
    "--prompt-file", path.join(value.root, "absent.md"), "--rubric-file", value.rubric, "--dry-run"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(json(result.stderr).error, /unknown adapter 'nosuch'/);
});

// #1173 DC2-d positive control: the same injection harness with the declaration present must behave
// exactly like the real adapter, which is what makes the rejection above the declaration's absence
// rather than an artefact of injecting a plain object.
test("the same injected adapter with a declaration still gates on the prompt", () => {
  const value = fixture("declared-injection");
  const env = preloadEnv(value, UNDECLARED_ADAPTER_PRELOAD, { RELAY_TEST_ROGUE_COMMAND_EXECUTION: "false" });
  const rejected = run(value, ["--executor", "pi", "--branch", "declared-command", "--prompt-file", value.commandPrompt,
    "--rubric-file", value.rubric, "--dry-run"], env);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.equal(json(rejected.stderr).code, "TOOLSET_MISMATCH");
  const accepted = run(value, ["--executor", "pi", "--branch", "declared-edit", "--prompt-file", value.editPrompt,
    "--rubric-file", value.rubric, "--dry-run"], env);
  assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
  assert.equal(json(accepted.stdout).executor, "pi");
});

test("dispatch usage publishes the override flag", () => {
  const result = spawnSync(process.execPath, [DISPATCH, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--allow-toolset-mismatch/);
});

// #1173 / CodeRabbit: executeForeground was exported with `overrides = {}`, so a caller that omitted
// the overrides derived `undefined` adapter/prompt — an untyped crash at credentialRequest or a
// silently-undefined prompt stamped downstream. The guard must fire before any filesystem read, so
// this passes a repo that does not exist: reaching repositoryIdentity would fail differently.
test("executeForeground fails typed when the gate-validated adapter or prompt is missing", async () => {
  const cli = { repo: "/definitely/not/a/relay/repo", values: {} };
  await assert.rejects(dispatch.executeForeground(cli, {}), (error) => error.code === "INVALID_INVOCATION");
  await assert.rejects(dispatch.executeForeground(cli, { prompt: { path: null, bytes: Buffer.from("x") } }), (error) => error.code === "INVALID_INVOCATION");
  await assert.rejects(dispatch.executeForeground(cli, { adapter: getAdapter("codex") }), (error) => error.code === "INVALID_INVOCATION");
});
