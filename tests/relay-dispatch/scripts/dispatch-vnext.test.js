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
const RELAY_RECOVER = path.join(ROOT, "skills/relay/scripts/relay-recover.js");
const FAKE_CODEX = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-codex.js");
const FAKE_CURSOR = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-cursor.js");
const FAKE_CLINE = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-cline.js");
const CRASH_AFTER_START = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-crash-after-start-preload.js");
const WRITE_CONTAINMENT_EXECUTOR = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-write-containment-executor.js");
const ADAPTER_RUNTIME_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-adapter-runtime-preload.js");
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-dispatch-vnext-${label}-`)));
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
  installNodeFixture(FAKE_CURSOR, path.join(bin, "agent"));
  const fakeCline = path.join(bin, "node_modules", "cline", "bin", "cline"); fs.mkdirSync(path.dirname(fakeCline), { recursive: true }); installNodeFixture(FAKE_CLINE, fakeCline);
  const env = { ...process.env, RELAY_HOME: relayHome, RELAY_CURSOR_AGENT_BIN: path.join(bin, "agent"), RELAY_CLINE_BIN: fakeCline,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${ADAPTER_RUNTIME_PRELOAD}`].filter(Boolean).join(" "),
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { root, repo, remote, relayHome, prompt, rubric, env };
}

function run(value, args, env = value.env) {
  const network = args.includes("--network-access") ? [] : ["--network-access", "enabled"];
  return spawnSync(process.execPath, [DISPATCH, value.repo, ...args, ...network], { encoding: "utf8", env, timeout: 60_000 });
}

function json(stdout) { return JSON.parse(stdout); }

function fixtureRunsDir(value) {
  const canonical = fs.realpathSync(value.repo);
  const base = path.basename(canonical).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
  return path.join(value.relayHome, "runs", slug);
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

test("dry-run validates the closed vNext surface while writing zero durable bytes", () => {
  const value = fixture("dry");
  const stateDir = path.join(value.repo, ".git", "relay-runtime-vnext");
  const result = run(value, ["--branch", "dry-run", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).durable_bytes_written, 0);
  assert.equal(json(result.stdout).invocation.validation, "adapter_build_invocation");
  assert.equal(json(result.stdout).invocation.launch_boundary, "host_sandbox_required_do_not_execute_raw");
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.existsSync(value.relayHome), false);
  const cursor = run(value, ["--executor", "cursor", "--branch", "cursor-dry", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(cursor.status, 0, cursor.stderr); assert.deepEqual(json(cursor.stdout).invocation.private_env_paths,
    [{ key: "CURSOR_CONFIG_DIR", root: "home", relative: ".cursor" }, { key: "CURSOR_DATA_DIR", root: "scratch", relative: "cursor-data" }]);

  const absentSource = path.join(value.root, "never-read-auth.json");
  const credentialDryRun = run(value, ["--branch", "credential-dry", "--prompt", "x", "--rubric-file", value.rubric, "--credential-env", "OPENAI_API_KEY",
    "--credential-file", `auth=${absentSource}`, "--dry-run", "--json"], { ...value.env, OPENAI_API_KEY: undefined });
  assert.equal(credentialDryRun.status, 0, credentialDryRun.stderr);
  assert.deepEqual(json(credentialDryRun.stdout).credential_request, { env_names: ["OPENAI_API_KEY"], file_ids: ["auth"] });
  assert.doesNotMatch(credentialDryRun.stdout + credentialDryRun.stderr, /never-read-auth/);
  assert.equal(fs.existsSync(absentSource), false);
  const customEnv = run(value, ["--branch", "custom-env-dry", "--prompt", "x", "--rubric-file", value.rubric,
    "--credential-env", "CUSTOM_PROVIDER_TOKEN", "--dry-run", "--json"], { ...value.env, CUSTOM_PROVIDER_TOKEN: undefined });
  assert.equal(customEnv.status, 0, customEnv.stderr);
  assert.deepEqual(json(customEnv.stdout).credential_request.env_names, ["CUSTOM_PROVIDER_TOKEN"]);

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
  // pi is the only adapter declaring networkControl "native"; claude is deliberately informational,
  // because safe mode preserves admin-managed hooks and so cannot prove complete tool egress denial.
  const result = run(value, ["--executor", "pi", "--branch", "network-disabled-native", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout); assert.equal(output.invocation.network_access, "enabled"); assert.equal(output.invocation.tool_network_access, "disabled");
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false);
});

test("removed readiness identity flags fail closed instead of being silently ignored", () => {
  const value = fixture("removed-readiness-flags");
  for (const flag of ["--request-id", "--leaf-id"]) {
    const result = run(value, ["--branch", "closed-surface", "--prompt", "x", "--rubric-file", value.rubric, flag, "legacy", "--dry-run", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown flag/i);
  }
  assert.equal(fs.existsSync(value.relayHome), false);
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
  assert.match(failure.error, new RegExp(`relay-recover\\.js recover --repo ['"]?${value.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(failure.error, new RegExp(`--branch ['"]?${branch}`));
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
// The next same-branch dispatch must only report the typed handoff; canonical recovery owns cleanup.
test("a post-worktree-add kill is recovered through the typed repo-and-branch recovery form", { timeout: 120_000 }, (t) => {
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
  assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`branch refs/heads/${branch}`));

  const collided = run(value, ["--branch", branch, "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(collided.status, 0);
  const collision = json(collided.stderr);
  assert.equal(collision.code, "BRANCH_EXISTS");
  assert.match(collision.error, new RegExp(`--repo ['"]?${value.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(collision.error, new RegExp(`--branch ['"]?${branch}`));
  assert.equal(fs.existsSync(worktree), true, "dispatch must not clean up a branch it did not create");

  const recovered = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "remove stranded Relay worktree", "--json"], { encoding: "utf8", env: value.env });
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveryResult = json(recovered.stdout);
  assert.equal(recoveryResult.status, "recovered");
  assert.equal(git(value.repo, ["branch", "--list", branch]), "");
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(recoveryResult.recovery_evidence), true, "unregistered bytes are preserved as recovery evidence");
  assert.equal(fs.existsSync(path.dirname(worktree)), false, "empty Relay-owned run parents are removed");
  assert.equal(path.relative(path.join(value.relayHome, "worktrees"), recoveryResult.recovery_evidence).startsWith(".."), true,
    "recovery evidence lives outside the trusted worktree base");

  const repeated = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "confirm idempotence", "--json"], { encoding: "utf8", env: value.env });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(json(repeated.stdout).status, "already_recovered");
});

test("stranded-worktree recovery ignores absent and structurally invalid candidate run records", (t) => {
  const value = fixture("stranded-worktree-ignorable-records");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-ignorable-records";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-ignorable-records");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);

  const candidateBase = fixtureRunsDir(value);
  fs.mkdirSync(path.join(candidateBase, "missing"), { recursive: true });
  fs.mkdirSync(path.join(candidateBase, "invalid"));
  fs.writeFileSync(path.join(candidateBase, "invalid", "run.json"), "{}\n");

  const result = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "ignore unclaimed and invalid candidates", "--json"], { encoding: "utf8", env: value.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result.stdout).status, "recovered");
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(git(value.repo, ["branch", "--list", branch]), "");
});

test("stranded-worktree recovery fails closed when a candidate run record is untrusted", (t) => {
  const value = fixture("stranded-worktree-untrusted-record");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-untrusted-record";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-untrusted-record");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);

  const candidate = path.join(fixtureRunsDir(value), "untrusted");
  const target = path.join(value.root, "candidate-run.json");
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(target, "{}\n");
  fs.symlinkSync(target, path.join(candidate, "run.json"));

  const result = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "do not discard when run ownership cannot be inspected", "--json"], { encoding: "utf8", env: value.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot safely inspect candidate run record.*UNTRUSTED_RUN_ARTIFACT/);
  assert.equal(fs.existsSync(worktree), true, "untrusted candidate inspection must happen before worktree deletion");
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]).length, 40, "branch must survive failed inspection");
  assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`branch refs/heads/${branch}`));
});

test("worktree porcelain accepts standard unrelated record types and rejects malformed records", () => {
  const head = "a".repeat(40);
  const entries = recovery.__testing.parseWorktreeList([
    "worktree /repo", `HEAD ${head}`, "branch refs/heads/target", "",
    "worktree /detached\n한글", `HEAD ${head}`, "detached", "locked maintenance\nwindow", "prunable gitdir is gone", "",
    "worktree /bare", "bare", "locked", "prunable", "", "",
  ].join("\0"));
  assert.deepEqual(entries.filter((entry) => entry.branch === "refs/heads/target").map((entry) => entry.worktree), ["/repo"]);
  assert.deepEqual(entries[1], {
    worktree: "/detached\n한글", head, branch: null, detached: true, bare: false,
    locked: "maintenance\nwindow", prunable: "gitdir is gone",
  });
  assert.deepEqual(entries[2], {
    worktree: "/bare", head: null, branch: null, detached: false, bare: true,
    locked: "", prunable: "",
  });
  assert.throws(
    () => recovery.__testing.parseWorktreeList(`worktree /repo\0HEAD ${head}\0branch refs/heads/target\0future value\0\0`),
    (error) => error.code === "INVALID_WORKTREE_REGISTRY",
  );
  assert.throws(
    () => recovery.__testing.parseWorktreeList(`worktree /repo\0HEAD ${head}\0branch refs/heads/target\0detached\0\0`),
    (error) => error.code === "INVALID_WORKTREE_REGISTRY",
  );
  assert.throws(
    () => recovery.__testing.parseWorktreeList(Buffer.from([0x77, 0x6f, 0x72, 0x6b, 0x74, 0x72, 0x65, 0x65, 0x20, 0xff, 0, 0])),
    (error) => error.code === "INVALID_WORKTREE_REGISTRY",
  );
});

test("stranded-worktree recovery handles NUL porcelain paths without Git quoting", (t) => {
  const value = fixture("stranded-worktree-unusual-path");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-한글";
  const base = path.join(value.root, "relay-worktrees\n한글");
  const worktree = path.join(base, "stranded\n한글");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(base, { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);

  const result = recovery.recoverStrandedWorktree({ repository: value.repo, branch, relayWorktreeBase: base });
  assert.equal(result.status, "recovered");
  assert.equal(fs.existsSync(worktree), false);
  assert.throws(() => git(value.repo, ["rev-parse", "--verify", branch]));
});

test("stranded-worktree recovery uses an independent ref instead of canonical checkout HEAD", (t) => {
  const value = fixture("stranded-worktree-independent-ref");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-independent-ref";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-independent-ref");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  git(value.repo, ["checkout", "--orphan", "unrelated-checkout"]);
  git(value.repo, ["rm", "-rf", "."]);
  fs.writeFileSync(path.join(value.repo, "unrelated.txt"), "unrelated root\n");
  git(value.repo, ["add", "unrelated.txt"]);
  git(value.repo, ["commit", "-m", "unrelated canonical checkout"]);
  assert.throws(() => git(value.repo, ["merge-base", "--is-ancestor", branch, "HEAD"]));

  const result = recovery.recoverStrandedWorktree({
    repository: value.repo, branch, relayWorktreeBase: path.join(value.relayHome, "worktrees"),
  });
  assert.equal(result.status, "recovered");
  assert.equal(fs.existsSync(worktree), false);
  assert.throws(() => git(value.repo, ["rev-parse", "--verify", branch]));
});

test("stranded-worktree recovery preserves a ref moved immediately before atomic deletion", (t) => {
  const value = fixture("stranded-worktree-ref-move-race");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-ref-move-race";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-ref-move-race");
  git(value.repo, ["branch", branch]);
  const savedHead = git(value.repo, ["rev-parse", "--verify", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const gitStub = path.join(value.root, "ref-move-race-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'const input = args[at] === "update-ref" && args[at + 1] === "--stdin" ? fs.readFileSync(0) : null;',
    'if (input) {',
    '  const repo = args[0] === "-C" ? args[1] : process.cwd();',
    '  const deletion = /^delete (\\S+) /m.exec(input.toString("utf8"));',
    '  const tree = execFileSync(REAL_GIT, ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();',
    '  const moved = execFileSync(REAL_GIT, ["-C", repo, "commit-tree", tree, "-p", "HEAD", "-m", "concurrent branch move"], { encoding: "utf8" }).trim();',
    '  execFileSync(REAL_GIT, ["-C", repo, "update-ref", deletion[1], moved]);',
    '}',
    'execFileSync(REAL_GIT, args, input ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" });',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  process.env.RELAY_GIT_BIN = gitStub;
  try {
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo,
      branch,
      relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }), (error) => error.code === "STRANDED_WORKTREE_CHANGED");
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
  }

  const movedHead = git(value.repo, ["rev-parse", "--verify", branch]);
  assert.notEqual(movedHead, savedHead, "the concurrent ref move must be observable");
  assert.equal(fs.existsSync(worktree), true, "the original Relay path must be restored");
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), savedHead, "the restored path keeps its saved checkout");
  assert.throws(() => git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "the restored path must not attach to the moved ref");
  assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${worktree}`), true);
  assert.equal(fs.readFileSync(path.join(worktree, "README.md"), "utf8"), "fixture\n", "compensation must not overwrite reviewable data");
});

test("stranded-worktree recovery atomically verifies its independent retaining ref", (t) => {
  const value = fixture("stranded-worktree-retaining-ref-race");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-retaining-ref-race";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-retaining-ref-race");
  git(value.repo, ["branch", branch]);
  const savedHead = git(value.repo, ["rev-parse", "--verify", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const gitStub = path.join(value.root, "retaining-ref-race-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'const input = args[at] === "update-ref" && args[at + 1] === "--stdin" ? fs.readFileSync(0) : null;',
    'if (input) {',
    '  const repo = args[0] === "-C" ? args[1] : process.cwd();',
    '  const retaining = /^verify (\\S+) /m.exec(input.toString("utf8"));',
    '  const tree = execFileSync(REAL_GIT, ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();',
    '  const moved = execFileSync(REAL_GIT, ["-C", repo, "commit-tree", tree, "-m", "concurrent retaining ref move"], { encoding: "utf8" }).trim();',
    '  execFileSync(REAL_GIT, ["-C", repo, "update-ref", retaining[1], moved]);',
    '}',
    'execFileSync(REAL_GIT, args, input ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" });',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  process.env.RELAY_GIT_BIN = gitStub;
  try {
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo,
      branch,
      relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }), (error) => error.code === "STRANDED_BRANCH_NOT_REMOVED");
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
  }

  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]), savedHead, "the target branch must survive a failed retaining-ref verify");
  assert.equal(fs.existsSync(worktree), true, "the original Relay path must be restored");
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), savedHead);
});

test("stranded-worktree recovery preserves a branch checked out after atomic deletion", (t) => {
  const value = fixture("stranded-worktree-holder-race");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-holder-race";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-holder-race");
  const holder = path.join(value.root, "concurrent-holder");
  const gitStub = path.join(value.root, "holder-race-git.js");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'const input = args[at] === "update-ref" && args[at + 1] === "--stdin" ? fs.readFileSync(0) : null;',
    'execFileSync(REAL_GIT, args, input ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" });',
    'if (input) {',
    '  const repo = args[0] === "-C" ? args[1] : process.cwd();',
    '  const deletion = /^delete (\\S+) (\\S+)$/m.exec(input.toString("utf8"));',
    '  execFileSync(REAL_GIT, ["-C", repo, "update-ref", deletion[1], deletion[2]], { stdio: "inherit" });',
    '  execFileSync(REAL_GIT, ["-C", repo, "worktree", "add", process.env.RELAY_TEST_HOLDER_WORKTREE, process.env.RELAY_TEST_HOLDER_BRANCH], { stdio: "inherit" });',
    '}',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  const previousHolderWorktree = process.env.RELAY_TEST_HOLDER_WORKTREE;
  const previousHolderBranch = process.env.RELAY_TEST_HOLDER_BRANCH;
  process.env.RELAY_GIT_BIN = gitStub;
  process.env.RELAY_TEST_HOLDER_WORKTREE = holder;
  process.env.RELAY_TEST_HOLDER_BRANCH = branch;
  try {
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo,
      branch,
      relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }),
      (error) => error.code === "STRANDED_WORKTREE_AMBIGUOUS");
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
    if (previousHolderWorktree === undefined) delete process.env.RELAY_TEST_HOLDER_WORKTREE;
    else process.env.RELAY_TEST_HOLDER_WORKTREE = previousHolderWorktree;
    if (previousHolderBranch === undefined) delete process.env.RELAY_TEST_HOLDER_BRANCH;
    else process.env.RELAY_TEST_HOLDER_BRANCH = previousHolderBranch;
  }

  assert.equal(fs.existsSync(worktree), true, "the removed Relay worktree must be restored before failing closed");
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]).length, 40, "the competing holder keeps the branch ref");
  assert.equal(git(holder, ["symbolic-ref", "--short", "HEAD"]), branch);
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), git(value.repo, ["rev-parse", "--verify", branch]), "the restored path keeps the exact saved checkout");
  assert.throws(() => git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]), "the restored path must not steal the competing holder's branch");
  assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${holder}`), true);
  assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${worktree}`), true);
});

test("stranded-worktree compensation restores a SHA-256 branch after post-delete observation failure", (t) => {
  const value = fixture("stranded-sha256-compensation", { objectFormat: "sha256" });
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-sha256-compensation";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-sha256-compensation");
  const marker = path.join(value.root, "fail-next-worktree-list");
  git(value.repo, ["branch", branch]);
  const savedHead = git(value.repo, ["rev-parse", "--verify", branch]);
  assert.equal(savedHead.length, 64);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const gitStub = path.join(value.root, "sha256-compensation-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'if (args[at] === "worktree" && args[at + 1] === "list" && fs.existsSync(process.env.RELAY_TEST_FAIL_MARKER)) {',
    '  fs.unlinkSync(process.env.RELAY_TEST_FAIL_MARKER);',
    '  process.stderr.write("injected post-delete worktree-list failure\\n");',
    '  process.exit(75);',
    '}',
    'const input = args[at] === "update-ref" && args[at + 1] === "--stdin" ? fs.readFileSync(0) : null;',
    'execFileSync(REAL_GIT, args, input ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" });',
    'if (input) fs.writeFileSync(process.env.RELAY_TEST_FAIL_MARKER, "fail once\\n");',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  const previousMarker = process.env.RELAY_TEST_FAIL_MARKER;
  process.env.RELAY_GIT_BIN = gitStub;
  process.env.RELAY_TEST_FAIL_MARKER = marker;
  try {
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo,
      branch,
      relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }), (error) => error.code === "STRANDED_WORKTREE_CLEANUP_INCOMPLETE");
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
    if (previousMarker === undefined) delete process.env.RELAY_TEST_FAIL_MARKER;
    else process.env.RELAY_TEST_FAIL_MARKER = previousMarker;
  }

  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]), savedHead, "the 64-digit branch ref must be recreated");
  assert.equal(fs.existsSync(worktree), true, "the original Relay path must be restored");
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), savedHead);
  assert.equal(git(worktree, ["symbolic-ref", "--short", "HEAD"]), branch);
});

test("stranded-worktree recovery restores the original path when a valid run reference appears after removal", (t) => {
  const value = fixture("stranded-worktree-reference-race");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-reference-race";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-reference-race");
  const head = git(value.repo, ["rev-parse", "HEAD"]);
  const runId = "post-remove-reference";
  const runDir = path.join(fixtureRunsDir(value), runId);
  const criteria = "done_criteria:\n  - preserve the stranded checkout\n";
  const payloadPath = path.join(value.root, "post-remove-reference.json");
  const record = {
    version: 3,
    run_id: runId,
    repo: { root: fs.realpathSync(value.repo), remote: "local/test" },
    git: { branch, base_branch: "main", worktree, start_sha: head },
    contract: { done_criteria_path: path.join(runDir, "done-criteria.md"), done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") },
    roles: { orchestrator: "relay", executor: "codex", reviewer: "reviewer" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(payloadPath, JSON.stringify({ runDir, criteria, record }));
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const gitStub = path.join(value.root, "reference-race-git.js");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'execFileSync(REAL_GIT, args, { stdio: "inherit" });',
    'if (args[at] === "worktree" && args[at + 1] === "remove") {',
    '  const payload = JSON.parse(fs.readFileSync(process.env.RELAY_TEST_REFERENCE_PAYLOAD, "utf8"));',
    '  fs.mkdirSync(payload.runDir, { recursive: true });',
    '  fs.writeFileSync(payload.record.contract.done_criteria_path, payload.criteria);',
    '  fs.writeFileSync(`${payload.runDir}/run.json`, `${JSON.stringify(payload.record, null, 2)}\\n`);',
    '}',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  const previousHome = process.env.RELAY_HOME;
  const previousPayload = process.env.RELAY_TEST_REFERENCE_PAYLOAD;
  process.env.RELAY_GIT_BIN = gitStub;
  process.env.RELAY_HOME = value.relayHome;
  process.env.RELAY_TEST_REFERENCE_PAYLOAD = payloadPath;
  try {
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo,
      branch,
      relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }), (error) => error.code === "STRANDED_WORKTREE_REFERENCED");
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
    if (previousHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousHome;
    if (previousPayload === undefined) delete process.env.RELAY_TEST_REFERENCE_PAYLOAD;
    else process.env.RELAY_TEST_REFERENCE_PAYLOAD = previousPayload;
  }

  assert.equal(fs.existsSync(worktree), true, "the original Relay path must be restored before reporting the new run reference");
  assert.equal(git(worktree, ["symbolic-ref", "--short", "HEAD"]), branch, "an exact free branch may be restored attached");
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), head);
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]), head, "the branch ref must survive the race");
  assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${worktree}`), true);
});

test("stranded-worktree recovery fails closed without deleting reviewable work", (t) => {
  const value = fixture("stranded-worktree-dirty");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-dirty";
  const worktree = path.join(value.relayHome, "worktrees", "manual-stranded");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  fs.writeFileSync(path.join(worktree, "executor-change.txt"), "do not discard\n");

  const result = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "must preserve dirty worktree", "--json"], { encoding: "utf8", env: value.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewable changes/);
  assert.equal(fs.readFileSync(path.join(worktree, "executor-change.txt"), "utf8"), "do not discard\n");
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]).length, 40);
  assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`branch refs/heads/${branch}`));
});

test("stranded-worktree recovery refuses ignored user content hidden from porcelain", (t) => {
  const value = fixture("stranded-worktree-ignored-content");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-ignored-content";
  const worktree = path.join(value.relayHome, "worktrees", "stranded-ignored-content");
  fs.writeFileSync(path.join(value.repo, ".gitignore"), "private/\n");
  git(value.repo, ["add", ".gitignore"]);
  git(value.repo, ["commit", "-m", "ignore private executor files"]);
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const ignoredPath = path.join(worktree, "private", "operator-notes.txt");
  fs.mkdirSync(path.dirname(ignoredPath));
  fs.writeFileSync(ignoredPath, "private bytes must survive\n");

  assert.equal(git(worktree, ["status", "--porcelain"]), "", "ordinary porcelain must not reveal the ignored file");
  assert.throws(() => recovery.recoverStrandedWorktree({
    repository: value.repo, branch, relayWorktreeBase: path.join(value.relayHome, "worktrees"),
  }), (error) => error.code === "STRANDED_WORKTREE_IGNORED_CONTENT" && /private\//.test(error.message));
  assert.equal(fs.readFileSync(ignoredPath, "utf8"), "private bytes must survive\n");
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]).length, 40, "the branch must survive");
  assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${worktree}`));
});

test("stranded-worktree recovery quarantines before the final hidden-content proof", (t) => {
  const value = fixture("stranded-worktree-late-ignored-content");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-late-ignored-content";
  const relayWorktreeBase = path.join(value.relayHome, "worktrees");
  const worktree = path.join(relayWorktreeBase, "runs", "late-ignored-content", "repo");
  const counterPath = path.join(value.root, "safety-proof-count");
  fs.writeFileSync(path.join(value.repo, ".gitignore"), "private/\n");
  git(value.repo, ["add", ".gitignore"]);
  git(value.repo, ["commit", "-m", "ignore private executor files"]);
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  const gitStub = path.join(value.root, "late-ignored-git.js");
  const holderSource = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [ready, done, evidenceRoot] = process.argv.slice(1);',
    'fs.writeFileSync(ready, "ready");',
    'const deadline = Date.now() + 60_000;',
    'const hasEvidence = () => { try { return fs.readdirSync(evidenceRoot).length > 0; } catch { return false; } };',
    'while (!hasEvidence() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    'if (!hasEvidence()) process.exit(2);',
    'const lateIgnored = path.join("private", "late-operator-notes.txt");',
    'fs.mkdirSync(path.dirname(lateIgnored), { recursive: true });',
    'fs.writeFileSync(lateIgnored, "late bytes must survive\\n");',
    'fs.writeFileSync(done, "done");',
  ].join("\n");
  fs.writeFileSync(gitStub, [
    `#!${process.execPath}`,
    'const { execFileSync, spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const at = args[0] === "-C" ? 2 : 0;',
    'const input = args[at] === "update-ref" && args[at + 1] === "--stdin" ? fs.readFileSync(0) : null;',
    'const output = execFileSync(REAL_GIT, args, { encoding: null, input, stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });',
    'if (args[at] === "--no-optional-locks" && args[at + 1] === "ls-files" && args.includes("-v") && args.includes("-z")) {',
    '  let count = 0;',
    '  try { count = Number(fs.readFileSync(process.env.RELAY_TEST_PROOF_COUNTER, "utf8")); } catch {}',
    '  count += 1;',
    '  fs.writeFileSync(process.env.RELAY_TEST_PROOF_COUNTER, String(count));',
    '  if (count === 3) {',
    '    const proofWorktree = args[0] === "-C" ? args[1] : process.cwd();',
    '    const ready = `${process.env.RELAY_TEST_PROOF_COUNTER}.holder-ready`;',
    '    const done = `${process.env.RELAY_TEST_PROOF_COUNTER}.holder-done`;',
    `    const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holderSource)}, ready, done, process.env.RELAY_TEST_EVIDENCE_ROOT],`,
    '      { cwd: proofWorktree, detached: true, stdio: "ignore" });',
    '    holder.unref();',
    '    const deadline = Date.now() + 60_000;',
    '    while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    '    if (!fs.existsSync(ready)) throw new Error("late writer did not acquire the quarantined directory");',
    '  }',
    '}',
    'process.stdout.write(output);',
  ].join("\n").split("REAL_GIT").join(JSON.stringify(realGit())), { mode: 0o755 });

  const previousGit = process.env.RELAY_GIT_BIN;
  const previousCounter = process.env.RELAY_TEST_PROOF_COUNTER;
  const previousEvidenceRoot = process.env.RELAY_TEST_EVIDENCE_ROOT;
  process.env.RELAY_GIT_BIN = gitStub;
  process.env.RELAY_TEST_PROOF_COUNTER = counterPath;
  process.env.RELAY_TEST_EVIDENCE_ROOT = `${relayWorktreeBase}.recovery-evidence`;
  let result;
  try {
    result = recovery.recoverStrandedWorktree({
      repository: value.repo, branch, relayWorktreeBase,
    });
  } finally {
    if (previousGit === undefined) delete process.env.RELAY_GIT_BIN;
    else process.env.RELAY_GIT_BIN = previousGit;
    if (previousCounter === undefined) delete process.env.RELAY_TEST_PROOF_COUNTER;
    else process.env.RELAY_TEST_PROOF_COUNTER = previousCounter;
    if (previousEvidenceRoot === undefined) delete process.env.RELAY_TEST_EVIDENCE_ROOT;
    else process.env.RELAY_TEST_EVIDENCE_ROOT = previousEvidenceRoot;
  }

  const holderDeadline = Date.now() + 60_000;
  while (!fs.existsSync(`${counterPath}.holder-done`) && Date.now() < holderDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  assert.equal(fs.existsSync(`${counterPath}.holder-done`), true, "the open-directory holder writes after the preservation rename");
  assert.equal(result.status, "recovered");
  assert.equal(fs.readFileSync(path.join(result.recovery_evidence, "private", "late-operator-notes.txt"), "utf8"), "late bytes must survive\n");
  assert.equal(path.relative(relayWorktreeBase, result.recovery_evidence).startsWith(".."), true,
    "bytes written through the open directory handle are preserved outside the Relay worktree base");
  assert.equal(fs.existsSync(worktree), false, "the published worktree path is removed");
  assert.throws(() => git(value.repo, ["rev-parse", "--verify", branch]), "the stranded branch is removed");
  const registry = git(value.repo, ["worktree", "list", "--porcelain"]);
  assert.equal(registry.includes(`worktree ${worktree}`), false, "the stranded worktree is unregistered");
  assert.doesNotMatch(registry, new RegExp(`branch refs/heads/${branch}`));
  assert.equal(fs.existsSync(path.dirname(worktree)), false, "empty Relay-owned worktree parents are removed");
  assert.equal(fs.existsSync(path.join(relayWorktreeBase, "runs")), false, "all empty Relay-owned worktree parents are removed");
});

test("stranded-worktree recovery refuses tracked changes hidden by index visibility flags", (t) => {
  for (const { flag, marker } of [
    { flag: "--assume-unchanged", marker: "h" },
    { flag: "--skip-worktree", marker: "S" },
  ]) {
    const value = fixture(`stranded-worktree-${marker}-flag`);
    t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
    const branch = `stranded-${marker}-flag`;
    const worktree = path.join(value.relayHome, "worktrees", `stranded-${marker}-flag`);
    git(value.repo, ["branch", branch]);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(value.repo, ["worktree", "add", worktree, branch]);
    fs.writeFileSync(path.join(worktree, "README.md"), `${marker} hidden modified bytes\n`);
    git(worktree, ["update-index", flag, "README.md"]);

    assert.equal(git(worktree, ["status", "--porcelain"]), "", `${flag} must hide the modification from ordinary porcelain`);
    assert.match(git(worktree, ["ls-files", "-v", "README.md"]), new RegExp(`^${marker} README\\.md$`));
    assert.throws(() => recovery.recoverStrandedWorktree({
      repository: value.repo, branch, relayWorktreeBase: path.join(value.relayHome, "worktrees"),
    }), (error) => error.code === "STRANDED_WORKTREE_INDEX_FLAGS" && /README\.md/.test(error.message), `${flag} must stop recovery`);
    assert.equal(fs.readFileSync(path.join(worktree, "README.md"), "utf8"), `${marker} hidden modified bytes\n`);
    assert.equal(git(value.repo, ["rev-parse", "--verify", branch]).length, 40, "the branch must survive");
    assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${worktree}`));
    assert.match(git(worktree, ["ls-files", "-v", "README.md"]), new RegExp(`^${marker} README\\.md$`), "the index flag must survive");
  }
});

test("stranded-worktree recovery preserves a clean branch with unique committed work", (t) => {
  const value = fixture("stranded-worktree-committed");
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const branch = "stranded-committed";
  const worktree = path.join(value.relayHome, "worktrees", "manual-stranded-committed");
  git(value.repo, ["branch", branch]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(value.repo, ["worktree", "add", worktree, branch]);
  fs.writeFileSync(path.join(worktree, "committed-executor-change.txt"), "do not discard\n");
  git(worktree, ["add", "committed-executor-change.txt"]);
  git(worktree, ["commit", "-m", "executor work awaiting review"]);
  const committedHead = git(worktree, ["rev-parse", "HEAD"]);

  const result = spawnSync(process.execPath, [RELAY_RECOVER, "recover", "--repo", value.repo, "--branch", branch,
    "--reason", "must preserve unique committed work", "--json"], { encoding: "utf8", env: value.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STRANDED_WORKTREE_UNMERGED|not retained by an independent Git ref/);
  assert.equal(git(value.repo, ["rev-parse", "--verify", branch]), committedHead, "the unique commit must survive");
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), committedHead, "the registered worktree must survive");
  assert.equal(git(worktree, ["status", "--porcelain"]), "", "the preserved worktree is clean");
  assert.match(git(value.repo, ["worktree", "list", "--porcelain"]), new RegExp(`branch refs/heads/${branch}`));
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

test("the actual executor process tree enforces filesystem/service boundaries and exposes enabled transport honestly", async () => {
  const value = fixture("write-containment");
  installNodeFixture(WRITE_CONTAINMENT_EXECUTOR, path.join(value.root, "bin", "codex"));
  const activeTarget = path.join(value.repo, "active-checkout-escape.txt");
  const siblingTarget = path.join(value.root, "sibling-escape.txt");
  const outsideTarget = path.join(os.tmpdir(), `relay-outside-escape-${crypto.randomUUID()}.txt`);
  const server = spawn(process.execPath, ["-e", "const net=require('net');const s=net.createServer(x=>x.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(Number(text.trim()));
    });
    server.once("error", reject);
    server.once("exit", (code) => { if (!text.includes("\n")) reject(new Error(`network probe server exited ${code}`)); });
  });
  try {
    fs.writeFileSync(value.prompt, JSON.stringify({ active: activeTarget, sibling: siblingTarget, outside: outsideTarget, port }));
    const result = run(value, ["--branch", "contained", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"], {
      ...value.env,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = json(result.stdout);
    const proof = JSON.parse(fs.readFileSync(path.join(output.worktree, "containment-proof.json"), "utf8"));
    assert.equal(proof.worktree, "written");
    assert.equal(proof.temp, "written");
    assert.match(proof.active, /^denied:/);
    assert.match(proof.sibling, /^denied:/);
    assert.match(proof.outside, /^denied:/);
    assert.equal(proof.network, "connected");
    assert.match(proof.apple_event, /^denied:/);
    for (const label of ["git_add", "git_commit", "git_ref", "git_config", "git_hook"]) {
      assert.match(proof[label], /^denied:/, `${label} must stay owned by canonical recovery`);
    }
    assert.equal(path.dirname(proof.tempdir), output.run_dir);
    assert.match(path.basename(proof.tempdir), /^executor-tmp-dispatch-/);
    assert.equal(fs.existsSync(activeTarget), false);
    assert.equal(fs.existsSync(siblingTarget), false);
    assert.equal(fs.existsSync(outsideTarget), false);
    assert.equal(output.outcome.status, "succeeded");
  } finally {
    server.kill("SIGTERM");
  }
});

test("read-only dispatch denies worktree writes while retaining only result and private temp writes", () => {
  const value = fixture("read-only-containment");
  installNodeFixture(WRITE_CONTAINMENT_EXECUTOR, path.join(value.root, "bin", "codex"));
  fs.writeFileSync(value.prompt, JSON.stringify({ active: path.join(value.repo, "active.txt"), sibling: path.join(value.root, "sibling.txt"),
    outside: path.join(os.tmpdir(), `relay-readonly-${crypto.randomUUID()}`), proof_in_result: true }));
  const result = run(value, ["--branch", "read-only-contained", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--sandbox", "read-only", "--json"], value.env);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout);
  const proof = JSON.parse(output.outcome.output);
  assert.match(proof.worktree, /^denied:/);
  assert.equal(proof.temp, "written");
  for (const label of ["git_add", "git_commit", "git_ref", "git_config", "git_hook"]) {
    assert.match(proof[label], /^denied:/, `${label} must stay owned by canonical recovery`);
  }
  assert.equal(fs.existsSync(path.join(output.worktree, "worktree-write.txt")), false);
});

test("executor dispatch fails closed on hosts without an enforceable write boundary", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-no-sandbox-")));
  assert.throws(
    () => host.sandboxInvocation({
      role: "executor",
      command: process.execPath,
      args: ["-e", ""],
      readRoots: [root],
      writeRoots: [root],
      platform: "linux",
    }),
    (error) => error.code === "EXECUTOR_WRITE_ISOLATION_UNAVAILABLE",
  );
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

test("resume revalidates the exact action key under the acquired run lock before prompt or attempt facts", async () => {
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
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "changes_requested" },
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

  // #1173: the prompt is read once, in main(), ahead of the resume inspection, so the denial needs a
  // readable prompt to be the resume gate's rejection and not the reader's. An unreadable one is now
  // rejected first for every executor, which is the shape the shell-less path already had.
  const denied = run(value, ["--run-id", output.run_id, "--prompt-file", value.prompt, "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "RUN_NOT_REDISPATCHABLE");
  const unreadable = run(value, ["--run-id", output.run_id, "--prompt-file", path.join(value.root, "missing-retry.md"), "--json"]);
  assert.notEqual(unreadable.status, 0);
  assert.equal(json(unreadable.stderr).code, "RUN_ARTIFACT_MISSING");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles);
  assert.deepEqual(facts.readFacts({ eventsPath }).facts, beforeFacts);
});
