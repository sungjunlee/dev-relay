"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const host = require("../../../skills/relay-dispatch/scripts/host");
const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const runtime = { ...recovery, inspectRun: recovery.inspectProductionRun };
const { readRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const { getAdapter } = require("../../../skills/relay-dispatch/scripts/adapters");

const ROOT = path.resolve(__dirname, "../../..");
const DISPATCH = path.join(ROOT, "skills/relay-dispatch/scripts/dispatch.js");
const FAKE_CODEX = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-codex.js");
const FAKE_CURSOR = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-cursor.js");
const FAKE_CLINE = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-cline.js");
const FAKE_OPENCODE = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-opencode.js");
const CRASH_AFTER_START = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-crash-after-start-preload.js");
const ADAPTER_RUNTIME_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/adapter-runtime-preload.js");
const READ_ONCE_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-prompt-read-once-preload.js");
const RUN_CLAIM_RACE = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-run-claim-race-preload.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Absolute path to the real git, so a RELAY_GIT_BIN stub can delegate without inheriting a PATH
// that already points back at itself.
function realGit() {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "git");
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  throw new Error("git is not on PATH");
}

function installNodeFixture(source, target) {
  const bytes = fs.readFileSync(source, "utf8").replace(/^#![^\n]*/, `#!${process.execPath}`);
  fs.writeFileSync(target, bytes, { mode: 0o755 });
}

function fixture(label, { objectFormat = "sha1" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-dispatch-${label}-`)));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const format = objectFormat === "sha1" ? [] : [`--object-format=${objectFormat}`];
  execFileSync("git", ["init", ...format, "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", ...format, "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const prompt = path.join(root, "prompt.md");
  const rubric = path.join(root, "rubric.yaml");
  fs.writeFileSync(prompt, "Implement the requested change.\n");
  fs.writeFileSync(rubric, "done_criteria:\n  - change is reviewable\n");
  installNodeFixture(FAKE_CODEX, path.join(bin, "codex"));
  const fakePi = path.join(bin, "pi");
  fs.writeFileSync(fakePi, `#!${process.execPath}
"use strict";
if (process.env.PI_FIXTURE_INVOCATION_MARKER) require("fs").writeFileSync(process.env.PI_FIXTURE_INVOCATION_MARKER, JSON.stringify(process.argv.slice(2)));
if (process.env.PI_FIXTURE_FAIL_NO_WORK === "1") process.exit(1);
require("fs").writeFileSync(require("path").join(process.cwd(), "executor-change.txt"), "review me\\n");
process.stdout.write("fake pi completed\\n");
`, { mode: 0o755 });
  installNodeFixture(FAKE_CURSOR, path.join(bin, "agent"));
  const fakeCline = path.join(bin, "node_modules", "cline", "bin", "cline"); fs.mkdirSync(path.dirname(fakeCline), { recursive: true }); installNodeFixture(FAKE_CLINE, fakeCline);
  installNodeFixture(FAKE_OPENCODE, path.join(bin, "opencode"));
  const env = { ...process.env, RELAY_HOME: relayHome, RELAY_CURSOR_AGENT_BIN: path.join(bin, "agent"), RELAY_CLINE_BIN: fakeCline,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${ADAPTER_RUNTIME_PRELOAD}`].filter(Boolean).join(" "),
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { root, repo, remote, relayHome, bin, prompt, rubric, fakePi, env };
}

function run(value, args, env = value.env) {
  // Tool networking defaults to enabled; tests exercise the default unless they
  // pass an explicit --network-access value.
  return spawnSync(process.execPath, [DISPATCH, value.repo, ...args], { encoding: "utf8", env, timeout: 60_000 });
}

function json(stdout) { return JSON.parse(stdout); }

function fixtureRunsDir(value) {
  const canonical = fs.realpathSync(value.repo);
  const base = path.basename(canonical).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
  return path.join(value.relayHome, "runs", slug);
}

function githubObservationFixture(value, branch) {
  const statePath = path.join(value.root, "github-observation.json");
  const gitBin = path.join(value.bin, "git-observer");
  const ghBin = path.join(value.bin, "gh-observer");
  const invocationLog = path.join(value.root, "codex-invocations.log");
  fs.writeFileSync(statePath, JSON.stringify({ branch, head_sha: null, base_sha: null, gh_calls: 0, drift_body_after: null }));
  fs.writeFileSync(gitBin, `#!${process.execPath}
"use strict";
const fs = require("fs"), { spawnSync } = require("child_process");
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(process.env.RELAY_TEST_GITHUB_STATE, "utf8"));
if (args.includes("ls-remote")) {
  if (state.head_sha) process.stdout.write(state.head_sha + "\\trefs/heads/" + state.branch + "\\n");
  process.exit(0);
}
const child = spawnSync(process.env.RELAY_TEST_REAL_GIT, args, { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status === null ? 1 : child.status);
`, { mode: 0o755 });
  fs.writeFileSync(ghBin, `#!${process.execPath}
"use strict";
const fs = require("fs"), statePath = process.env.RELAY_TEST_GITHUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8")), args = process.argv.slice(2);
if (args[0] !== "pr" || args[1] !== "list") { process.stderr.write("unexpected gh invocation: " + args.join(" ")); process.exit(2); }
state.gh_calls += 1; fs.writeFileSync(statePath, JSON.stringify(state));
const body = state.drift_body_after !== null && state.gh_calls >= state.drift_body_after ? "drifted observation" : "stable observation";
process.stdout.write(JSON.stringify([{ number: 42, state: "OPEN", url: "https://github.com/owner/repo/pull/42",
  headRefName: state.branch, headRefOid: state.head_sha, baseRefName: "main", baseRefOid: state.base_sha,
  headRepository: { nameWithOwner: "owner/repo" }, headRepositoryOwner: { login: "owner" },
  isCrossRepository: false, mergedAt: null, mergeCommit: null, body }]));
`, { mode: 0o755 });
  git(value.repo, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);
  return {
    statePath,
    invocationLog,
    env: {
      ...value.env,
      RELAY_GIT_BIN: gitBin,
      RELAY_GH_BIN: ghBin,
      RELAY_TEST_GITHUB_STATE: statePath,
      RELAY_TEST_REAL_GIT: realGit(),
      FAKE_CODEX_INVOCATION_LOG: invocationLog,
    },
    update(update) {
      fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), ...update }));
    },
  };
}

function appendProductionFacts({ runDir, runId, worktree, entries }) {
  const eventsPath = path.join(runDir, "events.jsonl");
  return host.withRunLock({
    runDir,
    attemptId: `test-facts-${crypto.randomUUID()}`,
    operation: "test_append_facts",
    hostKind: "local_supervisor",
    hostHandle: `test-facts:${process.pid}`,
    worktreeDir: worktree,
  }, (lockContext) => {
    for (const entry of entries) facts.appendFact({ eventsPath, lockContext, fact: { ...entry, run_id: runId } });
  });
}

function dispatchFactCounts(runDir) {
  const runFacts = facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") }).facts;
  return {
    started: runFacts.filter((fact) => fact.type === "attempt_started").length,
    terminal: runFacts.filter((fact) => fact.type === "attempt_finished" || fact.type === "attempt_interrupted").length,
    attemptFacts: runFacts.filter((fact) => fact.type.startsWith("attempt_")).length,
    prompts: fs.readdirSync(runDir).filter((name) => name.startsWith("prompt-")).length,
  };
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await callback(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("cleanup recovery refuses to release an owner without a signed exact obligation", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-cleanup-pending-")));
  const runDir = path.join(root, "run"), worktree = path.join(root, "worktree"); fs.mkdirSync(runDir); fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const lockContext = host.acquireRunLock({ runDir, attemptId: "cleanup-pending", operation: "dispatch", worktreeDir: worktree });
  const originalWait = host.waitForTerminalResult;
  host.waitForTerminalResult = async () => { throw Object.assign(new Error("cleanup remains"), { code: "HOST_CLEANUP_INCOMPLETE" }); };
  try {
    await assert.rejects(dispatch.finishAttempt({ cli: {}, adapter: null, started: { receipt: {}, lockContext, runDir } }),
      (error) => error.code === "BREAK_EVIDENCE_INSUFFICIENT" && error.cleanup_recovery === "incomplete");
    assert.equal(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), "");
    assert.equal(host.inspectOwnership({ runDir }).status, "live");
  } finally {
    host.waitForTerminalResult = originalWait; host.releaseRunLock(lockContext); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run validates the closed Relay surface while writing zero durable bytes", () => {
  const value = fixture("dry");
  const stateDir = path.join(value.repo, ".git", "relay-runtime-vnext");
  const result = run(value, ["--branch", "dry-run", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).durable_bytes_written, 0);
  assert.equal(json(result.stdout).invocation.validation, "adapter_build_invocation");
  assert.equal(json(result.stdout).invocation.launch_boundary, "host_supervisor_required_do_not_execute_raw");
  assert.equal(json(result.stdout).invocation.network_access, "enabled", "routine dispatch defaults tool networking to enabled");
  assert.equal(json(result.stdout).invocation.tool_network_access, "enabled", "routine dispatch defaults tool networking to enabled");
  assert.deepEqual(json(result.stdout).filesystem_isolation, { requested: "workspace-write", effective: "native", diagnostic: null });
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.existsSync(value.relayHome), false);
  const cursor = run(value, ["--executor", "cursor", "--branch", "cursor-dry", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.equal(Object.hasOwn(json(cursor.stdout).invocation, "private_env_paths"), false);
  const retired = run(value, ["--branch", "retired-credential", "--prompt", "x", "--rubric-file", value.rubric,
    "--credential-env", "OPENAI_API_KEY", "--dry-run", "--json"]);
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /Unknown option/);

  git(value.repo, ["branch", "existing-dry"]);
  const existingBranch = run(value, ["--branch", "existing-dry", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.notEqual(existingBranch.status, 0);
  assert.equal(json(existingBranch.stderr).code, "BRANCH_EXISTS");
  assert.equal(fs.existsSync(value.relayHome), false);

  const invalidBranch = run(value, ["--branch", "bad branch", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.notEqual(invalidBranch.status, 0);
  assert.equal(git(value.repo, ["branch", "--list", "bad branch"]), "");
  assert.equal(fs.existsSync(value.relayHome), false);

  const missingCopy = run(value, ["--branch", "missing-copy", "--prompt", "x", "--rubric-file", value.rubric, "--copy", "missing.txt", "--dry-run", "--json"]);
  assert.notEqual(missingCopy.status, 0);
  assert.equal(fs.existsSync(value.relayHome), false);

  const escapedCopy = run(value, ["--branch", "escaped-copy", "--prompt", "x", "--rubric-file", value.rubric, "--copy", "../prompt.md", "--dry-run", "--json"]);
  assert.notEqual(escapedCopy.status, 0);
  assert.match(json(escapedCopy.stderr).error, /--copy escapes repo/);
  assert.equal(fs.existsSync(value.relayHome), false);

  const obsolete = run(value, ["--branch", "old", "--prompt", "x", "--rubric-file", value.rubric, "--auto-recover-commit"]);
  assert.notEqual(obsolete.status, 0);
  assert.match(obsolete.stderr, /Unknown option '--auto-recover-commit'/);
});

test("tool-network disable fails closed for informational executors and preserves provider transport for native ones", () => {
  const value = fixture("network-disabled-preflight");
  const unsupported = run(value, ["--branch", "network-disabled-codex", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--dry-run", "--json"]);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /tool network disable/i);
  // The explicit native-deny request fails before any branch, worktree, run, or fact effects.
  const rejected = run(value, ["--branch", "network-disabled-rejected", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--json"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /tool network disable/i);
  assert.equal(git(value.repo, ["branch", "--list", "network-disabled-rejected"]), "", "a rejected advanced request must not create a branch");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("network-disabled-rejected"), false, "a rejected advanced request must not register a worktree");
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false, "a rejected advanced request must not create a run directory");
  // pi is the only adapter declaring networkControl "native"; claude is deliberately informational,
  // because safe mode preserves admin-managed hooks and so cannot prove complete tool egress denial.
  const result = run(value, ["--executor", "pi", "--branch", "network-disabled-native", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout); assert.equal(output.invocation.network_access, "enabled"); assert.equal(output.invocation.tool_network_access, "disabled");
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false);
});

test("dispatch defaults tool networking to enabled and rejects the retired sandbox flag", () => {
  const value = fixture("dispatch-defaults");
  const parsed = dispatch.parseCli([value.repo, "--branch", "defaults-b", "--prompt", "x", "--rubric-file", value.rubric]);
  assert.equal(parsed.values["network-access"], "enabled");
  assert.equal(Object.hasOwn(parsed.values, "sandbox"), false);
  const explicit = dispatch.parseCli([value.repo, "--branch", "defaults-b", "--prompt", "x", "--rubric-file", value.rubric, "--network-access", "enabled"]);
  assert.equal(explicit.values["network-access"], "enabled");
  assert.throws(() => dispatch.parseCli([value.repo, "--branch", "defaults-b", "--prompt", "x", "--rubric-file", value.rubric, "--sandbox", "workspace-write"]), /unknown flag/i);
  const retired = run(value, ["--branch", "defaults-b", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--sandbox", "workspace-write", "--json"]);
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /unknown flag/i);
  assert.equal(fs.existsSync(value.relayHome), false, "a retired --sandbox input must fail before durable effects");
});

test("retired dispatch flags fail closed instead of being silently ignored", () => {
  const value = fixture("retired-dispatch-flags");
  for (const flag of ["--request-id", "--leaf-id", "--allow-toolset-mismatch", "--sandbox"]) {
    const result = run(value, ["--branch", "closed-surface", "--prompt", "x", "--rubric-file", value.rubric, flag, "legacy", "--dry-run", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown flag/i);
  }
  assert.equal(fs.existsSync(value.relayHome), false);
});

test("prompt wording does not change dispatch admission or its unified dry-run contract", () => {
  const value = fixture("prompt-content-neutral");
  const prompts = [
    "Implement the requested change.\n",
    "Implement the requested change, then run `node --test tests/example.test.js`.\n",
    "Implement the requested change, then git commit the result.\n",
    "```bash\nnode --test tests/example.test.js\n```\n",
  ];
  const outputs = prompts.map((prompt, index) => {
    const result = run(value, ["--executor", "pi", "--branch", `prompt-content-${index}`, "--prompt", prompt,
      "--rubric-file", value.rubric, "--dry-run", "--json"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return json(result.stdout);
  });
  const expectedIsolation = {
    requested: "unavailable", effective: "none", diagnostic: "pi has no native filesystem sandbox; continuing directly on the trusted local host.",
  };
  for (const output of outputs) {
    assert.equal(output.executor, "pi");
    assert.deepEqual(output.filesystem_isolation, expectedIsolation);
  }
  assert.equal(fs.existsSync(value.relayHome), false, "dry-run must not create durable state");
});

test("the create path stages prompt bytes from the single trusted prompt read", () => {
  const value = fixture("prompt-read-once");
  const result = run(value, ["--branch", "prompt-read-once", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env,
    NODE_OPTIONS: `${value.env.NODE_OPTIONS} --require=${READ_ONCE_PRELOAD}`,
    RELAY_TEST_READ_ONCE_PATH: value.prompt,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.equal(fs.existsSync(value.prompt), false, "the one allowed read must have happened");
  assert.equal(fs.readFileSync(path.join(output.run_dir, `prompt-${output.attempt_id}.md`), "utf8"),
    "Implement the requested change.\n");
});

test("the removed migration cutover flag fails closed instead of being silently ignored", () => {
  const value = fixture("removed-cutover-flag");
  const result = run(value, ["--branch", "closed-cutover", "--prompt", "x", "--rubric-file", value.rubric, "--bootstrap-vnext", "--dry-run", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown flag/i);
  assert.equal(fs.existsSync(value.relayHome), false);
});

// The run directory is claimed by a non-recursive mkdir, which replaced an existsSync/mkdir pair that
// the deleted repository-wide generation lock used to serialize. A duplicate run id must be rejected
// on the cheap pre-check, before any Git work happens.
test("a duplicate run id is rejected before any branch or worktree is created", () => {
  const value = fixture("run-id-conflict");
  const runId = "conflict-run";
  const runDir = path.join(fixtureRunsDir(value), runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "sentinel"), "winner\n");

  const second = run(value, ["--branch", "conflict-b", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
  });
  assert.notEqual(second.status, 0);
  assert.match(`${second.stdout}${second.stderr}`, /run already exists/);
  assert.equal(fs.readFileSync(path.join(runDir, "sentinel"), "utf8"), "winner\n", "the winner's run directory must survive");
  assert.equal(git(value.repo, ["branch", "--list", "conflict-b"]), "", "no branch may be created for a duplicate run id");
});

// The pre-check above is an optimization; the authoritative claim is the mkdir. The preload hides the
// directory from `existsSync` exactly once, which is what a real concurrent dispatch looks like: the
// loser has already built its worktree by the time mkdir returns EEXIST. It must then unwind only its
// own branch and worktree and leave the winner's run directory untouched.
test("losing the run-directory claim race unwinds only the loser's own branch and worktree", () => {
  const value = fixture("run-claim-race");
  const runId = "race-run";
  const runDir = path.join(fixtureRunsDir(value), runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "sentinel"), "winner\n");

  const loser = run(value, ["--branch", "race-loser", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env,
    RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
    RELAY_TEST_RACE_ABSENT_ONCE: runDir,
    NODE_OPTIONS: [value.env.NODE_OPTIONS, `--require=${RUN_CLAIM_RACE}`].filter(Boolean).join(" "),
  });
  assert.notEqual(loser.status, 0);
  assert.match(`${loser.stdout}${loser.stderr}`, /run already exists/);
  assert.deepEqual(fs.readdirSync(runDir), ["sentinel"], "the loser must not delete or add to the winner's run directory");
  assert.equal(fs.readFileSync(path.join(runDir, "sentinel"), "utf8"), "winner\n");
  assert.equal(git(value.repo, ["branch", "--list", "race-loser"]), "", "the loser must remove the branch it created");
});

// The exclusive `git branch` failure is the ownership boundary. A competing ref can disappear
// before Git returns, so dispatch must not turn that failure into a mutable post-failure probe.
test("an atomic branch collision remains BRANCH_EXISTS when the competing ref vanishes before return", (t) => {
  const value = fixture("vanishing-branch-collision");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "vanishing-collision";
  const runId = "vanishing-collision-run";
  const log = path.join(value.root, "git.log");
  const gitStub = path.join(value.root, "vanishing-collision-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
    'const at = args[0] === "-C" ? 2 : 0;',
    `if (args[at] === "branch" && args[at + 1] === ${JSON.stringify(branch)}) {`,
    '  const repo = args[0] === "-C" ? args[1] : process.cwd();',
    '  execFileSync(REAL_GIT, ["-C", repo, "branch", args[at + 1], args[at + 2]], { stdio: "inherit" });',
    '  execFileSync(REAL_GIT, ["-C", repo, "branch", "-D", args[at + 1]], { stdio: "inherit" });',
    '  process.stderr.write("fatal: a branch named collision already exists\\n");',
    '  process.exit(128);',
    '}',
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const result = run(value, ["--branch", branch, "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_GIT_BIN: gitStub, RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
  });
  assert.notEqual(result.status, 0);
  const failure = json(result.stderr);
  assert.equal(failure.code, "BRANCH_EXISTS");
  assert.match(failure.error, new RegExp(`branch already exists: ${branch}`));
  assert.match(failure.error, /git worktree list --porcelain/);
  assert.doesNotMatch(failure.error, /relay-recover|--branch/);
  assert.equal(git(value.repo, ["branch", "--list", branch]), "", "the vanished competing ref must not be re-probed or recreated");
  assert.equal(fs.existsSync(path.join(value.relayHome, "runs", runId)), false, "a collision must not start dispatch recovery");
  const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args.includes("show-ref")), false, "dispatch must not probe mutable branch state after the failed create");
  assert.equal(calls.some((args) => args.includes("remove") || args.includes("-D")), false, "dispatch must not mutate recovery state after the failed create");
});

test("a non-collision branch creation failure is not mislabeled BRANCH_EXISTS", (t) => {
  const value = fixture("branch-create-io-failure");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const gitStub = path.join(value.root, "branch-create-io-failure-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'if (args[at] === "branch" && args[at + 1] === "io-failure") {',
    '  process.stderr.write("fatal: cannot write ref: input/output error\\n");',
    '  process.exit(128);',
    '}',
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const result = run(value, ["--branch", "io-failure", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_GIT_BIN: gitStub, RELAY_DISPATCH_INTERNAL_RUN_ID: "branch-create-io-failure-run",
  });
  assert.notEqual(result.status, 0);
  const failure = json(result.stderr);
  assert.notEqual(failure.code, "BRANCH_EXISTS");
  assert.doesNotMatch(failure.error, /relay-recover\.js recover/);
});

// `git worktree add -b` creates the branch before it can reject an occupied destination, so a
// dispatch that loses the retained-worktree race must delete the branch it just created. The
// preload hides the worktree path from the pre-check exactly once, which is what the real race
// looks like. A branch that already existed is never touched.
test("losing the retained-worktree race deletes only the branch this dispatch created", () => {
  const value = fixture("worktree-race");
  const runId = "worktree-race-run";
  const worktree = path.join(value.relayHome, "worktrees",
    path.basename(fixtureRunsDir(value)), runId, path.basename(fs.realpathSync(value.repo)));
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, "winner"), "winner\n");

  const loser = run(value, ["--branch", "wt-loser", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env,
    RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
    RELAY_TEST_RACE_ABSENT_ONCE: worktree,
    NODE_OPTIONS: [value.env.NODE_OPTIONS, `--require=${RUN_CLAIM_RACE}`].filter(Boolean).join(" "),
  });
  assert.notEqual(loser.status, 0);
  // Negative control: without the preload this dispatch dies at the `existsSync(worktree)`
  // pre-check, never creates a branch, and every assertion below would hold for the wrong reason.
  // Requiring the worktree-add failure proves the lie fired and the branch really was created.
  assert.match(`${loser.stdout}${loser.stderr}`, /worktree add|already exists/,
    "the preload must push this past the pre-check into the real worktree-add failure");
  assert.doesNotMatch(`${loser.stdout}${loser.stderr}`, /retained worktree already exists/,
    "hitting the pre-check means the race was never exercised");
  assert.equal(git(value.repo, ["branch", "--list", "wt-loser"]), "", "the loser must delete the branch git created for it");
  assert.equal(fs.readFileSync(path.join(worktree, "winner"), "utf8"), "winner\n", "the winner's worktree must survive");
});

// The failure path force-deletes a branch, so the property that matters is that it can only ever
// reach a branch this dispatch created. `git branch` is what makes that true: it fails closed on an
// existing name, so a branch carrying unmerged executor work is never reachable by the `-D`.
test("a pre-existing branch carrying unmerged work survives a failed dispatch", () => {
  const value = fixture("branch-preserved");
  git(value.repo, ["branch", "carries-work"]);
  git(value.repo, ["checkout", "-q", "carries-work"]);
  fs.writeFileSync(path.join(value.repo, "executor.txt"), "unmerged executor work\n");
  git(value.repo, ["add", "-A"]);
  git(value.repo, ["commit", "-m", "executor work"]);
  const work = git(value.repo, ["rev-parse", "HEAD"]);
  git(value.repo, ["checkout", "-q", "main"]);

  const result = run(value, ["--branch", "carries-work", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(result.status, 0, "dispatch must refuse a branch it does not own");
  assert.equal(git(value.repo, ["rev-parse", "--verify", "carries-work"]), work, "the branch must still point at the executor commit");
  assert.match(git(value.repo, ["for-each-ref", "--contains", work, "--format=%(refname)"]), /refs\/heads\/carries-work/,
    "the executor commit must remain reachable");
});

// The ownership token for a branch name is `git branch`, an atomic exclusive ref creation.
// `worktree add -b` cannot serve that role: it creates the branch before validating the destination,
// so a rejected destination leaves the branch behind, and probing with `rev-parse` first only moves
// the race. Twelve dispatches contend for one branch name *concurrently* — sequential spawns would
// prove nothing here. A branch may survive only if a retained worktree holds it.
//
// Honest scope: this test does NOT fail against the earlier `rev-parse` + `worktree add -b` shape.
// Git refuses `branch -D` on a branch checked out in another worktree, so it independently blocks
// the loser from deleting the winner's branch, and every branch relay creates is checked out
// immediately. The atomic token is kept because it removes the race rather than relying on that
// refusal, and because it is less code — not because this test distinguishes the two. What the
// exactly-one assertions do buy is proof that the race ran at all: an earlier `<= 1` form was
// satisfied by twelve failures and validated nothing.
test("concurrent dispatches contending for one branch name leave no orphan branch", { timeout: 120_000 }, async () => {
  const value = fixture("branch-contention");
  const started = Array.from({ length: 12 }, (unused, index) => new Promise((resolve) => {
    const child = spawn(process.execPath,
      [DISPATCH, value.repo, "--branch", "contended", "--prompt-file", value.prompt,
        "--rubric-file", value.rubric, "--network-access", "enabled", "--json"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"],
        env: { ...value.env, RELAY_DISPATCH_INTERNAL_RUN_ID: `contend-${index}` } });
    child.on("exit", (code) => resolve(code));
  }));
  const codes = await Promise.all(started);
  assert.equal(codes.length, 12);
  // Exactly one, not "at most one": `<= 1` is also satisfied when every dispatch fails for an
  // unrelated reason, which would make this test pass while never exercising the race at all.
  assert.equal(codes.filter((code) => code === 0).length, 1,
    `exactly one dispatch must win the branch, saw ${codes.filter((c) => c === 0).length} of ${codes.length} (codes: ${codes.join(",")})`);

  const branches = git(value.repo, ["branch", "--list", "contended"]).split("\n").filter(Boolean);
  const holders = git(value.repo, ["worktree", "list"]).split("\n").filter((line) => /\[contended\]/.test(line));
  assert.equal(branches.length, 1, `exactly one branch must survive, saw ${branches.length}`);
  assert.equal(holders.length, 1, `the surviving branch must be held by exactly one retained worktree, saw ${holders.length}`);
});

// `worktree remove --force` deletes a dirty worktree without asking, so the unwind must never run
// it on a destination this invocation did not register. A `worktree add` that fails *because* a
// competing dispatch owns that path would otherwise destroy that run's uncommitted executor work.
test("a failed worktree add never removes a destination this dispatch did not register", () => {
  const value = fixture("worktree-not-ours");
  const runId = "not-ours-run";
  const worktree = path.join(value.relayHome, "worktrees",
    path.basename(fixtureRunsDir(value)), runId, path.basename(fs.realpathSync(value.repo)));

  // A competing run already owns that destination, registered, with uncommitted executor work.
  git(value.repo, ["branch", "winner-br"]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, "winner-br"]);
  fs.writeFileSync(path.join(worktree, "executor-work.txt"), "uncommitted executor work\n");

  const loser = run(value, ["--branch", "loser-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env,
    RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
    RELAY_TEST_RACE_ABSENT_ONCE: worktree,
    NODE_OPTIONS: [value.env.NODE_OPTIONS, `--require=${RUN_CLAIM_RACE}`].filter(Boolean).join(" "),
  });
  assert.notEqual(loser.status, 0);
  assert.equal(fs.readFileSync(path.join(worktree, "executor-work.txt"), "utf8"), "uncommitted executor work\n",
    "the competing run's uncommitted work must survive");
  assert.match(git(value.repo, ["worktree", "list"]), new RegExp(`${runId}`),
    "the competing run's worktree must stay registered");
  assert.equal(git(value.repo, ["branch", "--list", "loser-br"]), "", "the loser must still clean up its own branch");
});

// Regression guard for the ordering of the run-directory claim. The claim happens after the retained
// worktree exists, so a crash during `git worktree add` cannot strand an empty run directory that
// afterwards rejects create, resume, inspect, and recover alike with no way to clear it.
test("a crash during retained-worktree creation strands no run directory", () => {
  const value = fixture("worktree-crash");
  const runId = "worktree-crash-run";
  const gitStub = path.join(value.root, "slow-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'if (args[at] === "worktree" && args[at + 1] === "add") {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);',
    '}',
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").replace("REAL_GIT", JSON.stringify(realGit())), { mode: 0o755 });

  const child = spawn(process.execPath, [DISPATCH, value.repo, "--branch", "worktree-crash", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--network-access", "enabled", "--json"], {
    env: { ...value.env, RELAY_DISPATCH_INTERNAL_RUN_ID: runId, RELAY_GIT_BIN: gitStub },
    stdio: ["ignore", "ignore", "ignore"],
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
  child.kill("SIGKILL");

  const runsDir = fixtureRunsDir(value);
  const stranded = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  assert.deepEqual(stranded, [], "a mid-worktree crash must leave no claimed run directory behind");
});

// This is the actual #1190 window, rather than a synthetic branch/worktree fixture: the git wrapper
// lets `worktree add` finish, records that fact, then blocks before dispatch can claim its run directory.
// The next same-branch dispatch must report a typed refusal and preserve the pre-run Git pair.
test("a post-worktree-add kill preserves the branch and registered worktree", { timeout: 120_000 }, (t) => {
  const value = fixture("stranded-worktree");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const runId = "stranded-worktree-run";
  const branch = "stranded-worktree";
  const worktree = path.join(value.relayHome, "worktrees", path.basename(fixtureRunsDir(value)), runId, path.basename(fs.realpathSync(value.repo)));
  const marker = path.join(value.root, "worktree-added.json");
  const gitStub = path.join(value.root, "post-add-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(`${process.env.RELAY_TEST_WORKTREE_ADDED_MARKER}.log`, JSON.stringify(args) + "\\n");',
    'const at = args[0] === "-C" ? 2 : 0;',
    'if (args[at] === "worktree" && args[at + 1] === "add") {',
    '  execFileSync(REAL_GIT, args, { stdio: "inherit" });',
    '  fs.writeFileSync(process.env.RELAY_TEST_WORKTREE_ADDED_MARKER, JSON.stringify({ pid: process.pid }));',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);',
    '  process.exit(0);',
    '}',
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const child = spawn(process.execPath, [DISPATCH, value.repo, "--branch", branch, "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--network-access", "enabled", "--json"], {
    env: { ...value.env, RELAY_DISPATCH_INTERNAL_RUN_ID: runId, RELAY_GIT_BIN: gitStub, RELAY_TEST_WORKTREE_ADDED_MARKER: marker },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += chunk; });
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  if (!fs.existsSync(marker)) {
    child.kill("SIGKILL");
    const calls = fs.existsSync(`${marker}.log`) ? fs.readFileSync(`${marker}.log`, "utf8") : "(wrapper was never started)";
    assert.fail(`git worktree add must complete before the dispatch is killed: ${childStderr}; git calls: ${calls}`);
  }
  const blockedGit = JSON.parse(fs.readFileSync(marker, "utf8"));
  child.kill("SIGKILL");
  try { process.kill(blockedGit.pid, "SIGKILL"); } catch {}

  assert.equal(fs.existsSync(path.join(fixtureRunsDir(value), runId)), false, "the kill window has no readable run.json");
  assert.equal(fs.existsSync(worktree), true, "the registered Relay worktree is stranded");
  const branchHead = git(value.repo, ["rev-parse", "--verify", branch]);
  const registry = git(value.repo, ["worktree", "list", "--porcelain"]);
  assert.match(registry, new RegExp(`branch refs/heads/${branch}`));

  const collided = run(value, ["--branch", branch, "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(collided.status, 0);
  const collision = json(collided.stderr);
  assert.equal(collision.code, "BRANCH_EXISTS");
  assert.match(collision.error, new RegExp(`branch already exists: ${branch}`));
  assert.match(collision.error, /cannot prove ownership of pre-run Git state/);
  assert.match(collision.error, /git worktree list --porcelain/);
  assert.match(collision.error, /new branch and run/);
  assert.doesNotMatch(collision.error, /relay-recover|remove stranded/);
  assert.equal(fs.existsSync(worktree), true, "dispatch must not clean up a branch it did not create");
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]), branchHead);
  assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]), registry);
  assert.equal(fs.existsSync(path.join(fixtureRunsDir(value), runId)), false);
});

// #1154 item 2: containment must be validated BEFORE `git worktree add`. A pre-existing symlink at the
// run-id component previously let git materialise the worktree at the symlink target first; the
// rejection unwound it, but git had already written outside the trusted base. The pre-validation
// rejects before git touches anything, proven by an instrumented git log that contains no `worktree add`.
test("a symlinked worktree destination is rejected before git materialises it", () => {
  const value = fixture("worktree-symlink");
  const runId = "worktree-symlink-run";
  const slug = path.basename(fixtureRunsDir(value));
  const runIdDir = path.join(value.relayHome, "worktrees", slug, runId);
  const target = path.join(value.root, "symlink-target");
  fs.mkdirSync(path.dirname(runIdDir), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, runIdDir, "dir");
  const logPath = path.join(value.root, "git.log");
  const gitStub = path.join(value.root, "log-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");`,
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").replace("REAL_GIT", JSON.stringify(realGit())), { mode: 0o755 });

  const result = run(value, ["--branch", "symlink-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"],
    { ...value.env, RELAY_GIT_BIN: gitStub, RELAY_DISPATCH_INTERNAL_RUN_ID: runId });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /contains a symlink/, "the pre-validation names the symlink");
  const invocations = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/) : [];
  assert.equal(invocations.some((line) => { try { const args = JSON.parse(line); return args[0] === "worktree" && args[1] === "add"; } catch { return false; } }), false,
    "git worktree add must never run against a symlinked destination");
  assert.equal(fs.readdirSync(target).length, 0, "nothing was materialised at the symlink target");
  assert.equal(git(value.repo, ["branch", "--list", "symlink-br"]), "", "no branch is left behind");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("symlink-br"), false, "no worktree is registered");
});

// #1154 item 2, intermediate-component variant: the symlink sits at the deterministic repoSlug
// component and the run-id leaf does NOT pre-exist. Without the pre-mkdir validation, recursive
// mkdirSync would resolve the symlink and create the run-id directory at the untrusted target
// before the loop runs. The validation must run before mkdirSync, so nothing is written anywhere.
test("a symlinked repoSlug component is rejected before mkdirSync writes through it", () => {
  const value = fixture("worktree-symlink");
  const runId = "worktree-symlink-run2";
  const slugDir = path.dirname(path.join(value.relayHome, "worktrees", path.basename(fixtureRunsDir(value)), runId));
  const target = path.join(value.root, "symlink-target-2");
  fs.mkdirSync(path.dirname(slugDir), { recursive: true });
  fs.rmSync(slugDir, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, slugDir, "dir");
  const logPath = path.join(value.root, "git.log");
  const gitStub = path.join(value.root, "log-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");`,
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
  ].join("\n").replace("REAL_GIT", JSON.stringify(realGit())), { mode: 0o755 });

  const result = run(value, ["--branch", "symlink-br2", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"],
    { ...value.env, RELAY_GIT_BIN: gitStub, RELAY_DISPATCH_INTERNAL_RUN_ID: runId });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /contains a symlink/, "the pre-validation names the symlink");
  const invocations = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/) : [];
  assert.equal(invocations.some((line) => { try { const args = JSON.parse(line); return args[0] === "worktree" && args[1] === "add"; } catch { return false; } }), false,
    "git worktree add must never run against a symlinked destination");
  assert.equal(fs.readdirSync(target).length, 0, "mkdirSync wrote nothing through the symlink to the target");
  assert.equal(git(value.repo, ["branch", "--list", "symlink-br2"]), "", "no branch is left behind");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("symlink-br2"), false, "no worktree is registered");
});

test("a symlinked worktree base is rejected before Relay writes through it", () => {
  const value = fixture("worktree-base-symlink");
  const target = path.join(value.root, "worktree-base-target");
  fs.mkdirSync(value.relayHome, { recursive: true });
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(value.relayHome, "worktrees"), "dir");

  const result = run(value, ["--branch", "base-symlink-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /must not be a symlink|worktree base contains a symlink/, "the pre-creation validation names the symlink");
  assert.deepEqual(fs.readdirSync(target), [], "nothing was written through the symlinked base");
  assert.equal(git(value.repo, ["branch", "--list", "base-symlink-br"]), "", "no branch is left behind");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("base-symlink-br"), false, "no worktree is registered");
});

test("a symlinked Relay home is rejected before Relay writes through it", () => {
  const value = fixture("worktree-home-symlink");
  const target = path.join(value.root, "worktree-home-target");
  fs.mkdirSync(target);
  fs.symlinkSync(target, value.relayHome, "dir");

  const result = run(value, ["--branch", "home-symlink-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /must not be a symlink|worktree base contains a symlink/, "the Relay-owned ancestor is rejected");
  assert.deepEqual(fs.readdirSync(target), [], "nothing was written through the symlinked Relay home");
  assert.equal(git(value.repo, ["branch", "--list", "home-symlink-br"]), "", "no branch is left behind");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("home-symlink-br"), false, "no worktree is registered");
});

test("a stable symlink prefix before an explicit Relay worktree base remains valid", () => {
  const value = fixture("worktree-stable-prefix");
  const stableTarget = path.join(value.root, "stable-prefix-target");
  const stableAlias = path.join(value.root, "stable-prefix-alias");
  fs.mkdirSync(stableTarget);
  fs.symlinkSync(stableTarget, stableAlias, "dir");
  const relayWorktreeBase = path.join(stableAlias, "worktrees");

  const result = run(value, ["--branch", "stable-prefix-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_WORKTREE_BASE: relayWorktreeBase,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.equal(output.worktree.startsWith(`${fs.realpathSync(stableTarget)}${path.sep}`), true,
    "the stable prefix is canonicalized before Relay creates its owned suffix");
});

test("a /tmp alias canonicalizes every Relay base before branch or worktree creation", () => {
  const value = fixture("tmp-alias-bases");
  const aliasHome = path.join("/tmp", `relay-dispatch-alias-${crypto.randomUUID()}`);
  const expectedHome = path.join(fs.realpathSync("/tmp"), path.basename(aliasHome));
  const aliasRuns = path.join(aliasHome, "runs");
  const aliasWorktrees = path.join(aliasHome, "worktrees");
  const result = run(value, ["--branch", "tmp-alias-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_HOME: aliasHome, RELAY_RUNS_BASE: aliasRuns, RELAY_WORKTREE_BASE: aliasWorktrees,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.equal(output.run_dir.startsWith(`${expectedHome}${path.sep}`), true, "run directory uses the canonical /tmp target");
  assert.equal(output.worktree.startsWith(`${expectedHome}${path.sep}worktrees${path.sep}`), true, "worktree uses the canonical /tmp target");
  assert.match(git(value.repo, ["branch", "--list", "tmp-alias-br"]), /tmp-alias-br/);
});

test("a non-directory explicit runs base fails before branch, worktree, or run creation", () => {
  const value = fixture("runs-base-file");
  const blocked = path.join(value.root, "runs-base-file");
  fs.writeFileSync(blocked, "not a directory\n");
  const result = run(value, ["--branch", "runs-base-file-br", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_RUNS_BASE: blocked,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /RELAY_RUNS_BASE existing prefix must be a directory/);
  assert.equal(git(value.repo, ["branch", "--list", "runs-base-file-br"]), "", "no branch is left behind");
  assert.equal(git(value.repo, ["worktree", "list"]).includes("runs-base-file-br"), false, "no worktree is registered");
});

test("attempt_started is durable before executor gate launch, so a launch-window crash cannot orphan work", () => {
  const value = fixture("launch-window");
  const runId = "crash-start-run";
  const crashed = run(value, ["--branch", "crash-start", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env,
    RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${CRASH_AFTER_START}`.trim(),
  });
  assert.equal(crashed.signal, "SIGKILL");
  const runDir = path.join(fixtureRunsDir(value), runId);
  const record = readRunRecord({ runDir });
  const journal = facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  assert.deepEqual(journal.facts.filter((fact) => fact.type.startsWith("attempt_")).map((fact) => fact.type), ["attempt_started"]);
  assert.equal(fs.existsSync(path.join(record.git.worktree, "executor-change.txt")), false);
  assert.equal(fs.readdirSync(runDir).some((name) => name.endsWith(".executor.json")), false);
});

test("dispatch persists immutable bindings and exact attempt facts but never auto-recovers dirty work", async () => {
  const value = fixture("facts");
  const before = git(value.repo, ["rev-parse", "HEAD"]);
  const result = run(value, [
    "--branch", "issue-7", "--issue-number", "7", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--done-criteria-file", value.rubric,
    "--executor", "codex", "--model", "test/model", "--json",
  ]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  assert.equal(record.git.start_sha, before);
  assert.equal(record.roles.executor, "codex");
  assert.equal(record.parent, null);
  assert.equal(git(record.git.worktree, ["rev-parse", "HEAD"]), before, "default dispatch must not commit executor dirt");
  assert.equal(fs.readFileSync(path.join(record.git.worktree, "executor-change.txt"), "utf8"), "review me\n");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const attempt = journal.facts.filter((fact) => fact.type.startsWith("attempt_"));
  assert.deepEqual(attempt.map((fact) => fact.type), ["attempt_started", "attempt_finished"]);
  assert.equal(attempt[0].payload.executor, "codex");
  assert.equal(attempt[0].payload.model, "test/model");
  assert.equal(attempt[1].payload.final_sha, before);
  assert.equal(attempt[1].payload.status, "completed");
  const hostResult = JSON.parse(fs.readFileSync(attempt[1].payload.result_path, "utf8"));
  assert.equal(hostResult.attempt_id, attempt[0].attempt_id);
  assert.equal(hostResult.host_handle, attempt[0].payload.host_handle);
  assert.equal(hostResult.status, "completed");
  assert.equal(output.outcome.status, "succeeded");
  const independentlyInspected = await runtime.inspectRun({ runDir: output.run_dir });
  assert.deepEqual(output.inspection.recommended_action, independentlyInspected.recommended_action);
});

test("trusted-local dispatch needs no Relay sandbox admission and reports native capability", () => {
  const value = fixture("native-host");
  const result = run(value, ["--branch", "native-host", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.deepEqual(output.filesystem_isolation, { requested: "workspace-write", effective: "native", diagnostic: null });
  assert.equal(output.outcome.status, "succeeded");
  assert.equal(fs.existsSync(path.join(output.worktree, "executor-change.txt")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "skills/relay-dispatch/scripts/host.js"), "utf8"), /sandbox-exec/);
});

test("a no-sandbox adapter remains dry-runnable with a visible diagnostic", () => {
  const value = fixture("no-native-sandbox");
  const result = run(value, ["--executor", "pi", "--branch", "no-native-sandbox", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(result.stdout).filesystem_isolation, {
    requested: "unavailable", effective: "none", diagnostic: "pi has no native filesystem sandbox; continuing directly on the trusted local host.",
  });
});

test("Pi dispatch admits an explicit Alibaba extension model without disabling extensions", () => {
  const value = fixture("pi-alibaba-ambient-extension");
  const result = run(value, [
    "--executor", "pi", "--model", "alibaba-plan/qwen3.8-max", "--branch", "pi-alibaba-ambient-extension",
    "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--dry-run", "--json",
  ]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(json(result.stdout).invocation.args, [
    "--no-session", "--no-context-files", "--no-skills",
    "--tools", "read,grep,find,ls,write,edit",
    "--model", "alibaba-plan/qwen3.8-max", "--print",
  ]);
});

test("Pi keeps non-Alibaba explicit model argv and launches the fake executable", () => {
  const value = fixture("pi-explicit-non-alibaba");
  const marker = path.join(value.root, "pi-invoked.log");
  const result = run(value, [
    "--executor", "pi", "--model", "openai/gpt-5", "--reasoning", "high", "--branch", "pi-explicit-non-alibaba",
    "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json",
  ], { ...value.env, PI_FIXTURE_INVOCATION_MARKER: marker });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), [
    "--no-session", "--no-context-files", "--no-skills",
    "--tools", "read,grep,find,ls,write,edit",
    "--model", "openai/gpt-5", "--thinking", "high", "--print",
  ]);
});

test("an empty adapter result cannot turn an exit-zero host result into a completed attempt", () => {
  const value = fixture("empty-outcome");
  fs.writeFileSync(value.prompt, JSON.stringify({ empty: true }));
  const result = run(value, ["--branch", "empty-outcome", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], value.env);
  assert.notEqual(result.status, 0);
  const output = json(result.stdout);
  assert.equal(output.host_status, "completed");
  assert.equal(output.status, "failed");
  assert.equal(output.outcome.status, "empty");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const finished = journal.facts.find((fact) => fact.type === "attempt_finished");
  assert.equal(finished.payload.status, "failed");
  assert.equal(finished.payload.exit_code, 0);
});

test("recognized OpenCode provider-unavailable stderr terminates dispatch with typed-only public state", { timeout: 60_000 }, () => {
  const value = fixture("opencode-provider-unavailable"), raw = "credential=hidden insufficient_quota trailing provider text", started = Date.now();
  const result = run(value, ["--executor", "opencode", "--branch", "opencode-provider-unavailable", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--timeout", "30", "--json"], { ...value.env, FAKE_OPENCODE_SIGNAL: raw, FAKE_OPENCODE_STAY_ALIVE: "1" });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout); assert.equal(output.status, "cancelled"); assert.equal(output.host_status, "cancelled");
  assert.equal(output.termination, "provider_unavailable"); assert.doesNotMatch(JSON.stringify(output), /credential=hidden|insufficient_quota/);
  assert.ok(Date.now() - started < 25_000);
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const attempts = journal.facts.filter((fact) => fact.type.startsWith("attempt_"));
  assert.deepEqual(attempts.map((fact) => fact.type), ["attempt_started", "attempt_finished"]);
  assert.equal(attempts[1].payload.status, "cancelled"); assert.equal(journal.facts.some((fact) => /verification_recorded|review_recorded/.test(fact.type)), false);
  assert.doesNotMatch(JSON.stringify(journal.facts), /credential=hidden|insufficient_quota/);
  const hostResult = JSON.parse(fs.readFileSync(attempts[1].payload.result_path, "utf8"));
  assert.equal(hostResult.termination, "provider_unavailable"); assert.doesNotMatch(JSON.stringify(hostResult), /credential=hidden|insufficient_quota/);
  const stderrPath = journal.facts.find((fact) => fact.type === "attempt_started").payload.stderr_path;
  assert.equal(fs.statSync(stderrPath).mode & 0o777, 0o600); assert.match(fs.readFileSync(stderrPath, "utf8"), /credential=hidden insufficient_quota/);
  assert.equal(fs.existsSync(path.join(output.run_dir, `host-attempt-${attempts[1].attempt_id}.cleanup-incomplete.json`)), false);
});

test("recognized OpenCode stderr preserves a delayed natural exit", { timeout: 60_000 }, () => {
  const value = fixture("opencode-provider-natural-exit");
  const result = run(value, ["--executor", "opencode", "--branch", "opencode-provider-natural-exit", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--timeout", "30", "--json"], {
    ...value.env, FAKE_OPENCODE_SIGNAL: "insufficient_quota", FAKE_OPENCODE_EXIT_CODE: "2", FAKE_OPENCODE_EXIT_DELAY_MS: "100",
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.equal(output.host_status, "failed"); assert.equal(output.termination, undefined);
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const finished = journal.facts.find((fact) => fact.type === "attempt_finished");
  assert.equal(finished.payload.status, "failed"); assert.equal(finished.payload.exit_code, 2);
});

test("recognized OpenCode stderr remains typed when the gate exits during Relay cancellation", { timeout: 60_000 }, () => {
  const value = fixture("opencode-provider-exits-on-term");
  const result = run(value, ["--executor", "opencode", "--branch", "opencode-provider-exits-on-term", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--timeout", "30", "--json"], {
    ...value.env, FAKE_OPENCODE_SIGNAL: "insufficient_quota", FAKE_OPENCODE_STAY_ALIVE: "1", FAKE_OPENCODE_EXIT_ON_TERM: "1",
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  assert.ok(new Set(["cancelled", "failed"]).has(output.status), JSON.stringify(output));
  assert.equal(output.termination, "provider_unavailable", JSON.stringify(output));
});

test("a malformed structured adapter result cannot turn an exit-zero host result into a completed attempt", () => {
  const value = fixture("malformed-outcome");
  const result = run(value, ["--branch", "malformed-outcome", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--executor", "cline", "--json"]);
  assert.notEqual(result.status, 0);
  const output = json(result.stdout);
  assert.equal(output.host_status, "completed");
  assert.equal(output.status, "failed");
  assert.equal(output.outcome.status, "failed");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const finished = journal.facts.find((fact) => fact.type === "attempt_finished");
  assert.equal(finished.payload.status, "failed");
  assert.equal(finished.payload.exit_code, 0);
});

test("detached mode returns a durable launch receipt while a child dispatcher retains the run lock", async () => {
  const value = fixture("detach");
  fs.writeFileSync(value.prompt, JSON.stringify({ delay_ms: 1000 }));
  const started = Date.now();
  const result = run(value, ["--branch", "detached", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--detach", "--json"], {
    ...value.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout);
  assert.equal(output.status, "dispatched");
  assert.ok(Date.now() - started < 5_000);
  assert.ok(output.dispatcher_pid > 0);
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const types = facts.readFacts({ eventsPath }).facts.map((fact) => fact.type);
    if (types.includes("attempt_finished")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("detached dispatcher did not persist attempt_finished");
});

test("fleet parent and ownership digest are immutable across redispatch", () => {
  const value = fixture("fleet");
  const ownership = JSON.stringify({ sprint: "backlog/sprints/runtime.md", track: "runtime", component: "dispatch" });
  const first = run(value, ["--branch", "fleet-child", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--fleet-id", "fleet-1", "--ownership-json", ownership, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  assert.deepEqual(record.parent, { kind: "fleet", id: "fleet-1" });
  assert.match(record.ownership_digest, /^[0-9a-f]{64}$/);
  const changed = run(value, ["--run-id", record.run_id, "--prompt", "again", "--executor", "codex", "--fleet-id", "fleet-2", "--ownership-json", ownership, "--json"]);
  assert.notEqual(changed.status, 0);
  assert.equal(json(changed.stderr).code, "RUN_NOT_REDISPATCHABLE");
  assert.deepEqual(readRunRecord({ runDir: output.run_dir }).parent, { kind: "fleet", id: "fleet-1" });
});

test("resume admission accepts only an exact inspect-derived redispatch action", () => {
  const redispatch = {
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "changes_requested" },
    recommended_action: { kind: "redispatch", key: "a".repeat(64) },
  };
  assert.equal(dispatch.assertResumeInspection(redispatch), redispatch);
  assert.throws(
    () => dispatch.assertResumeInspection({ derived: { terminal: true, phase: "terminal", action: "none" }, recommended_action: { kind: "none" } }),
    (error) => error.code === "RUN_TERMINAL",
  );
  for (const kind of ["review", "merge"]) {
    assert.throws(
      () => dispatch.assertResumeInspection({ derived: { terminal: false, phase: "active", action: kind }, recommended_action: { kind } }),
      (error) => error.code === "RUN_NOT_REDISPATCHABLE",
    );
  }
});

test("#1244 verification_failed is admitted as redispatch and rejects action-key drift", () => {
  const inspection = {
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "verification_failed" },
    recommended_action: { kind: "redispatch", key: "f".repeat(64) },
  };
  assert.equal(dispatch.assertResumeInspection(inspection, "f".repeat(64)), inspection);
  assert.throws(
    () => dispatch.assertResumeInspection(inspection, "e".repeat(64)),
    (error) => error.code === "RUN_ACTION_CHANGED",
  );
});

test("verification_failed resume revalidates the exact action key under lock before prompt or attempt facts", async () => {
  const value = fixture("resume-lock-barrier");
  const first = run(value, ["--branch", "resume-lock-barrier", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const beforePrompts = fs.readdirSync(output.run_dir).filter((name) => name.startsWith("prompt-")).sort();
  const beforeAttempts = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts.filter((fact) => fact.type.startsWith("attempt_")).length;
  const previousHome = process.env.RELAY_HOME;
  const previousPath = process.env.PATH;
  process.env.RELAY_HOME = value.relayHome;
  process.env.PATH = value.env.PATH;
  let calls = 0;
  const inspectRun = async () => ({
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "verification_failed" },
    recommended_action: { kind: "redispatch", key: (calls++ === 0 ? "a" : "b").repeat(64) },
  });
  try {
    const cli = dispatch.parseCli([value.repo, "--run-id", output.run_id, "--prompt", "retry", "--network-access", "enabled", "--json"]);
    const prompt = { path: null, bytes: Buffer.from("retry", "utf8") };
    const adapter = getAdapter(cli.values.executor);
    await assert.rejects(dispatch.executeForeground(cli, { inspectRun, prompt, adapter }), (error) => error.code === "RUN_ACTION_CHANGED");
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
  assert.deepEqual(fs.readdirSync(output.run_dir).filter((name) => name.startsWith("prompt-")).sort(), beforePrompts);
  assert.equal(facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts.filter((fact) => fact.type.startsWith("attempt_")).length, beforeAttempts);
});

test("#1244 production inspection and public --run-id dispatch execute one exact-current failed-verification retry", async () => {
  const value = fixture("verification-failed-production-resume");
  const github = githubObservationFixture(value, "verification-failed-production-resume");
  const first = run(value, ["--branch", "verification-failed-production-resume", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--done-criteria-file", value.rubric, "--json"], github.env);
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const output = json(first.stdout), record = readRunRecord({ runDir: output.run_dir });
  const head = git(record.git.worktree, ["rev-parse", "HEAD"]), tree = git(record.git.worktree, ["rev-parse", "HEAD^{tree}"]);
  fs.unlinkSync(path.join(record.git.worktree, "executor-change.txt"));
  github.update({ head_sha: head, base_sha: head });
  const now = new Date().toISOString();
  await appendProductionFacts({ runDir: output.run_dir, runId: output.run_id, worktree: record.git.worktree, entries: [
    { event_id: `pr-${crypto.randomUUID()}`, type: "pull_request_recorded", at: now, actor: "test-owner", payload: {
      pr_number: 42, repo: "owner/repo", head_ref: record.git.branch, base_ref: record.git.base_branch,
      head_sha: head, created_by_relay: true,
    } },
    { event_id: `verification-${crypto.randomUUID()}`, type: "verification_recorded", at: now, actor: "test-owner", payload: {
      head_sha: head, tree_sha: tree, done_criteria_sha256: record.contract.done_criteria_sha256,
      command: "node --test", verification_request_sha256: "1".repeat(64), declared_command_count: 1,
      completed_command_count: 1, result_path: path.join(output.run_dir, "failed-verification.log"),
      result_sha256: "2".repeat(64), exit_code: 1, status: "failed", operator: "test-owner",
    } },
  ] });

  const before = await withEnvironment(github.env, () => runtime.inspectRun({ runDir: output.run_dir }));
  assert.deepEqual([before.derived.action, before.derived.reason], ["redispatch", "verification_failed"]);
  assert.equal(before.recommended_action.kind, "redispatch");
  const counts = dispatchFactCounts(output.run_dir);
  const invocations = fs.readFileSync(github.invocationLog, "utf8").trim().split("\n").filter(Boolean).length;
  const retry = run(value, ["--run-id", output.run_id, "--prompt", "retry exact failed verification", "--json"], github.env);
  assert.equal(retry.status, 0, `${retry.stderr}\n${retry.stdout}`);
  assert.equal(fs.readFileSync(github.invocationLog, "utf8").trim().split("\n").filter(Boolean).length, invocations + 1,
    "the run-bound Codex executor must actually run once");
  assert.deepEqual(dispatchFactCounts(output.run_dir), {
    started: counts.started + 1,
    terminal: counts.terminal + 1,
    attemptFacts: counts.attemptFacts + 2,
    prompts: counts.prompts + 1,
  }, "exactly one complete new attempt and its bound prompt are appended");
});

test("#1244 production --run-id action-key drift appends zero prompts or attempts and never runs the executor", async () => {
  const value = fixture("verification-failed-production-drift");
  const github = githubObservationFixture(value, "verification-failed-production-drift");
  const first = run(value, ["--branch", "verification-failed-production-drift", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--done-criteria-file", value.rubric, "--json"], github.env);
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const output = json(first.stdout), record = readRunRecord({ runDir: output.run_dir });
  const head = git(record.git.worktree, ["rev-parse", "HEAD"]), tree = git(record.git.worktree, ["rev-parse", "HEAD^{tree}"]);
  fs.unlinkSync(path.join(record.git.worktree, "executor-change.txt"));
  github.update({ head_sha: head, base_sha: head });
  const now = new Date().toISOString();
  await appendProductionFacts({ runDir: output.run_dir, runId: output.run_id, worktree: record.git.worktree, entries: [
    { event_id: `pr-${crypto.randomUUID()}`, type: "pull_request_recorded", at: now, actor: "test-owner", payload: {
      pr_number: 42, repo: "owner/repo", head_ref: record.git.branch, base_ref: record.git.base_branch,
      head_sha: head, created_by_relay: true,
    } },
    { event_id: `verification-${crypto.randomUUID()}`, type: "verification_recorded", at: now, actor: "test-owner", payload: {
      head_sha: head, tree_sha: tree, done_criteria_sha256: record.contract.done_criteria_sha256,
      command: "node --test", verification_request_sha256: "3".repeat(64), declared_command_count: 1,
      completed_command_count: 1, result_path: path.join(output.run_dir, "failed-verification.log"),
      result_sha256: "4".repeat(64), exit_code: 1, status: "failed", operator: "test-owner",
    } },
  ] });
  const before = await withEnvironment(github.env, () => runtime.inspectRun({ runDir: output.run_dir }));
  assert.deepEqual([before.derived.action, before.derived.reason], ["redispatch", "verification_failed"]);
  const counts = dispatchFactCounts(output.run_dir);
  const invocations = fs.readFileSync(github.invocationLog, "utf8").trim().split("\n").filter(Boolean).length;
  const state = JSON.parse(fs.readFileSync(github.statePath, "utf8"));
  github.update({ drift_body_after: state.gh_calls + 2 });
  const retry = run(value, ["--run-id", output.run_id, "--prompt", "retry must be rejected", "--json"], github.env);
  assert.notEqual(retry.status, 0, `${retry.stderr}\n${retry.stdout}`);
  assert.equal(json(retry.stderr).code, "RUN_ACTION_CHANGED");
  assert.deepEqual(dispatchFactCounts(output.run_dir), counts, "stale action identity must append zero prompt or attempt writes");
  assert.equal(fs.readFileSync(github.invocationLog, "utf8").trim().split("\n").filter(Boolean).length, invocations,
    "the executor must not run after action-key drift");
});

test("production inspection excludes only the self-held dispatch lock from exact action identity", async () => {
  const value = fixture("production-self-lock");
  const first = run(value, ["--branch", "production-self-lock", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  const before = await runtime.inspectRun({ runDir: output.run_dir });
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const audit = (fragment, capability) => {
    const eventId = `host-${fragment.audit_key}`;
    const existing = facts.readFacts({ eventsPath }).facts.find((fact) => fact.event_id === eventId);
    const fact = facts.factFromHostAudit({
      runId: output.run_id,
      eventId,
      at: existing?.at || new Date().toISOString(),
      actor: "relay-host",
      audit: fragment,
    });
    facts.appendFact({ eventsPath, lockContext: capability, fact });
    return { durable: true, idempotent: true, audit_key: fragment.audit_key };
  };
  const lockContext = host.acquireRunLock({
    runDir: output.run_dir,
    attemptId: `dispatch-self-${crypto.randomBytes(4).toString("hex")}`,
    operation: "dispatch",
    hostKind: "local_supervisor",
    hostHandle: `dispatch-self:${process.pid}`,
    worktreeDir: record.git.worktree,
    audit,
  });
  try {
    await assert.rejects(runtime.inspectRun({
      runDir: output.run_dir,
      activeRunLock: Object.freeze({ lock_id: lockContext.lock_id, operation: "dispatch" }),
    }), /issued run lock|lock capability/i);
    const self = await runtime.inspectRun({
      runDir: output.run_dir,
      activeRunLock: lockContext,
    });
    const foreign = await runtime.inspectRun({ runDir: output.run_dir });
    assert.equal(self.observations.host.live, false);
    assert.equal(self.recommended_action.key, before.recommended_action.key);
    assert.equal(foreign.observations.host.live, true);
    assert.notEqual(foreign.recommended_action.key, before.recommended_action.key);
  } finally {
    host.releaseRunLock(lockContext, { outcome: "test_complete", audit });
  }
});

test("a denied resume writes no prompt, attempt, or fact before failing closed", () => {
  const value = fixture("resume-gate");
  const first = run(value, ["--branch", "resume-gate", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const beforeFiles = fs.readdirSync(output.run_dir).sort();
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const beforeFacts = facts.readFacts({ eventsPath }).facts;

  // #1173: the prompt is read once, in main(), ahead of the resume inspection. A readable prompt
  // therefore reaches the resume gate, while an unreadable one is rejected first for every executor.
  const denied = run(value, ["--run-id", output.run_id, "--prompt-file", value.prompt, "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "RUN_NOT_REDISPATCHABLE");
  const unreadable = run(value, ["--run-id", output.run_id, "--prompt-file", path.join(value.root, "missing-retry.md"), "--json"]);
  assert.notEqual(unreadable.status, 0);
  assert.equal(json(unreadable.stderr).code, "RUN_ARTIFACT_MISSING");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles);
  assert.deepEqual(facts.readFacts({ eventsPath }).facts, beforeFacts);
});

test("resume without --executor resolves the immutable Pi adapter and appends a Pi attempt", () => {
  const value = fixture("resume-bound-pi");
  git(value.repo, ["remote", "remove", "origin"]);
  const first = run(value, ["--branch", "resume-bound-pi", "--executor", "pi", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_PI_BIN: value.fakePi, PI_FIXTURE_FAIL_NO_WORK: "1",
  });
  assert.equal(first.status, 1, `${first.stderr}\n${first.stdout}`);
  const output = json(first.stdout);
  assert.equal(output.status, "failed");
  assert.equal(output.inspection.recommended_action.kind, "redispatch");
  assert.equal(output.inspection.derived.reason, "attempt_failed_no_work");
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const beforeAttempts = facts.readFacts({ eventsPath }).facts.filter((fact) => fact.type.startsWith("attempt_")).length;
  const resumed = run(value, ["--run-id", output.run_id, "--prompt", "write the requested bounded file", "--json"], {
    ...value.env, RELAY_PI_BIN: value.fakePi,
  });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  assert.equal(json(resumed.stdout).status, "completed");
  const afterAttempts = facts.readFacts({ eventsPath }).facts.filter((fact) => fact.type.startsWith("attempt_")).length;
  assert.equal(afterAttempts, beforeAttempts + 2, "the bound Pi resume wrote one complete second attempt");
  const started = facts.readFacts({ eventsPath }).facts.filter((fact) => fact.type === "attempt_started");
  assert.equal(started.at(-1).payload.executor, "pi");
});

test("explicit resume executor mismatch fails before prompt, attempt, or fact writes", () => {
  const value = fixture("resume-explicit-mismatch");
  const first = run(value, ["--branch", "resume-explicit-mismatch", "--executor", "pi", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
    ...value.env, RELAY_PI_BIN: value.fakePi,
  });
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const beforeFiles = fs.readdirSync(output.run_dir).sort();
  const beforeFacts = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts;
  const mismatch = run(value, ["--run-id", output.run_id, "--executor", "codex", "--prompt", "retry", "--json"], {
    ...value.env, RELAY_PI_BIN: value.fakePi,
  });
  assert.notEqual(mismatch.status, 0, mismatch.stdout);
  assert.equal(json(mismatch.stderr).code, "RUN_EXECUTOR_MISMATCH");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles);
  assert.deepEqual(facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts, beforeFacts);
});
