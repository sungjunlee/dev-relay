const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../../../skills/relay-dispatch/scripts/adapter-contract");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const { createGenericAdapter, validateSchema } = require("../../../skills/relay-dispatch/scripts/adapters/generic");
const transcripts = require("../fixtures/adapter-transcripts.json");

let root;
let repo;
let cwd;
let promptPath;
let resultPath;
let stdoutPath;
let stderrPath;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-contract-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "adapter@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "adapter test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "adapter fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  cwd = path.join(root, "work tree with spaces");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "adapter-fixture", cwd]);
  promptPath = path.join(root, "prompt ; $literal.md");
  resultPath = path.join(root, "result output.txt");
  stdoutPath = path.join(root, "stdout.log");
  stderrPath = path.join(root, "stderr.log");
  fs.writeFileSync(promptPath, "Do the thing; do not interpolate $HOME or $(whoami).\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function invocationFor(adapter, phase = "dispatch") {
  return adapter.buildInvocation({
    phase,
    cwd,
    promptPath,
    resultPath,
    model: "provider/model; literally-not-a-shell-command",
    timeoutMs: 123456,
    sandbox: adapter.name === "codex" ? "read-only" : "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
}

test("new adapter registry preserves exactly the seven supported executors", () => {
  assert.deepEqual([...listAdapters()].sort(), ["antigravity", "claude", "cline", "codex", "cursor", "opencode", "pi"]);
  assert.throws(() => getAdapter("missing"), /unknown adapter/);
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    assert.equal(adapter.name, name);
    assert.deepEqual(
      Object.entries(adapter).filter(([, value]) => typeof value === "function").map(([key]) => key).sort(),
      ["buildInvocation", "capabilities", "parseOutcome", "probe"],
      `${name} must expose exactly the four adapter methods`
    );
    assert.ok(adapter.metadata.cliBinary);
    assert.ok(Number.isInteger(adapter.defaults.timeoutMs));
  }
});

test("every dispatch adapter returns argv-only invocations and preserves metacharacters as data", () => {
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    const invocation = invocationFor(adapter);
    assert.equal(typeof invocation.command, "string", name);
    assert.ok(Array.isArray(invocation.args), name);
    assert.equal(invocation.cwd, cwd, name);
    assert.ok(invocation.args.every((part) => typeof part === "string"), name);
    assert.ok(!invocation.command.includes(" "), `${name} command is not a shell command`);
    const serialized = JSON.stringify(invocation.args);
    assert.match(serialized, /literally-not-a-shell-command|\$HOME/, name);
    assert.match(serialized, /\$HOME|RELAY WORKTREE BOUNDARY|prompt-file/, name);
  }
});

test("Codex omits the reasoning override when the operator did not select one", () => {
  const invocation = getAdapter("codex").buildInvocation({
    phase: "dispatch",
    cwd,
    promptPath,
    resultPath,
    model: null,
    timeoutMs: 123456,
    sandbox: "read-only",
    networkAccess: "disabled",
  });
  assert.equal(invocation.args.includes("model_reasoning_effort=xhigh"), false);
  assert.equal(invocation.args.some((value, index) => (
    value === "-c"
    && /^model_reasoning_effort=/.test(String(invocation.args[index + 1] || ""))
  )), false);
});

test("phase matrix is fail-closed before an invocation is built", () => {
  assert.throws(
    () => invocationFor(getAdapter("cline"), "primary_review"),
    (error) => error instanceof contract.AdapterCapabilityError && /strict live canary/.test(error.message)
  );
  assert.throws(
    () => contract.validateCapabilities(getAdapter("cursor"), "dispatch", { readOnly: true }),
    /read-only dispatch mode|read-only execution is unsupported/
  );
  assert.equal(contract.validateCapabilities(getAdapter("codex"), "primary_review", { readOnly: true }).supported, true);
  assert.throws(
    () => getAdapter("codex").buildInvocation({
      phase: "dispatch",
      cwd,
      promptPath,
      resultPath,
      sandbox: "read-only",
      networkAccess: "enabled",
    }),
    /network-access enabled requires --sandbox workspace-write/
  );
});

test("supported primary review roles use the same descriptor and a Node argv bridge, never a shell", () => {
  for (const name of ["codex", "claude", "cursor", "opencode", "pi", "antigravity"]) {
    const phase = "primary_review";
    const invocation = invocationFor(getAdapter(name), phase);
    assert.equal(invocation.command, process.execPath, `${name}/${phase}`);
    assert.ok(invocation.args.some((arg) => /invoke-reviewer-/.test(arg)), `${name}/${phase}`);
    assert.ok(!invocation.args.join("\u0000").includes("sh -c"), `${name}/${phase}`);
  }
});

test("all adapters classify transcript success, failure, timeout, and cancellation consistently", () => {
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    const fixture = require(`../fixtures/adapter-transcripts/${name}.json`);
    fs.writeFileSync(stdoutPath, fixture.success);
    const success = adapter.parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath });
    assert.equal(success.status, "succeeded", name);
    assert.match(success.summary, new RegExp(name), `${name} success golden`);
    fs.writeFileSync(stdoutPath, fixture.error);
    assert.equal(adapter.parseOutcome({ exitCode: 2, stdoutPath, stderrPath, resultPath }).status, "failed", name);
    fs.writeFileSync(stdoutPath, fixture.empty);
    assert.equal(adapter.parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath }).status, name === "cline" ? "failed" : "empty", `${name} empty golden`);
    assert.equal(adapter.parseOutcome({ exitCode: 0, timedOut: true, stdoutPath, stderrPath, resultPath }).status, "timed_out", name);
    assert.equal(adapter.parseOutcome({ exitCode: 0, signal: "SIGTERM", stdoutPath, stderrPath, resultPath }).status, "cancelled", name);
  }
});

test("malformed JSONL transcript fails closed and text output without a transcript is empty", () => {
  fs.writeFileSync(stdoutPath, transcripts.cline_malformed);
  assert.equal(getAdapter("cline").parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath }).status, "failed");
  fs.writeFileSync(stdoutPath, "");
  assert.equal(getAdapter("pi").parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath }).status, "empty");
});

test("Cline keeps its dispatch transcript parser after its reviewer role is removed", () => {
  fs.writeFileSync(stdoutPath, transcripts.cline_success);
  const dispatch = getAdapter("cline").parseOutcome({ phase: "dispatch", exitCode: 0, stdoutPath, stderrPath, resultPath });
  assert.equal(dispatch.output, "completed cline work");
});

test("native probe is argv-only and reports unavailable CLIs as an explicit skip", () => {
  for (const name of listAdapters()) {
    const calls = [];
    const adapter = getAdapter(name);
    const available = adapter.probe({
      timeoutMs: 1234,
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: `${name} 1.0\n`, stderr: "" };
      },
    });
    assert.equal(available.status, "available", name);
    assert.deepEqual(calls[0].args, ["--version"], name);
    assert.equal(calls[0].options.timeout, 1234, name);
    const unavailable = adapter.probe({
      spawn() {
        const error = new Error("spawn ENOENT");
        error.code = "ENOENT";
        return { status: null, stdout: "", stderr: "", error };
      },
    });
    assert.equal(unavailable.status, "skipped", name);
    assert.match(unavailable.error, /CLI not found/, name);
    const isolatedEnvironment = adapter.probe({ env: { PATH: "" }, timeoutMs: 1000 });
    assert.equal(isolatedEnvironment.status, "skipped", `${name} unavailable live canary`);
  }
});

test("each native adapter has a golden command and argv marker", () => {
  const golden = {
    codex: { command: "codex", marker: "exec" },
    claude: { command: "claude", marker: "--output-format" },
    cursor: { command: "agent", marker: "--workspace" },
    opencode: { command: "opencode", marker: "run" },
    pi: { command: "pi", marker: "--no-session" },
    antigravity: { command: "agy", marker: "--prompt" },
    cline: { command: "cline", marker: "--json" },
  };
  for (const [name, expected] of Object.entries(golden)) {
    const invocation = invocationFor(getAdapter(name));
    assert.equal(invocation.command, expected.command, name);
    assert.ok(invocation.args.includes(expected.marker), `${name}: missing ${expected.marker}`);
  }
});

test("generic adapter only accepts closed argv templates and registered output protocols", () => {
  const generic = createGenericAdapter({
    name: "future-agent",
    command: "future-agent",
    args: ["run", "--model", "{model}", "--prompt-file", "{promptPath}", "--timeout", "{timeoutMs}"],
    cwd: "{cwd}",
    output_protocol: "json_result",
    capabilities: { write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  });
  const invocation = generic.buildInvocation({ phase: "dispatch", cwd, promptPath, resultPath, model: "vendor/model; not executed", timeoutMs: 9000 });
  assert.deepEqual(invocation.args.slice(0, 4), ["run", "--model", "vendor/model; not executed", "--prompt-file"]);
  const omittedModel = generic.buildInvocation({ phase: "dispatch", cwd, promptPath, resultPath, model: null, timeoutMs: 9000 });
  assert.ok(!omittedModel.args.includes("--model"));
  fs.writeFileSync(resultPath, transcripts.json_success);
  assert.deepEqual(generic.parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath }).output, { verdict: "pass" });
  assert.throws(() => generic.buildInvocation({ phase: "dispatch", cwd, promptPath, resultPath, model: "--unsafe" }), /non-flag string/);
  assert.throws(() => validateSchema({ name: "bad", command: "agent", args: ["--x={model}"], cwd: "{cwd}", output_protocol: "text_stdout", capabilities: {} }), /whole argv item/);
  assert.throws(() => validateSchema({ name: "bad", command: "agent", args: [], cwd: "{cwd}", output_protocol: "shell", capabilities: {} }), /output_protocol/);
  assert.throws(() => validateSchema({
    name: "bad",
    command: "agent",
    args: [],
    cwd: "{cwd}",
    output_protocol: "text_stdout",
    capabilities: { write: true, readOnly: false, networkControl: "native", cancellation: "process", structuredOutput: "text", extra: true },
  }), /must contain exactly/);
  assert.throws(() => validateSchema({
    name: "bad",
    command: "agent",
    args: [],
    cwd: "{cwd}",
    output_protocol: "text_stdout",
    capabilities: { write: "yes", readOnly: false, networkControl: "native", cancellation: "process", structuredOutput: "text" },
  }), /must be booleans/);
});

test("generic absolute commands cannot escape the approved directory through parent paths or symlinks", () => {
  const approved = path.join(root, "approved");
  const outside = path.join(root, "outside-agent");
  fs.mkdirSync(approved);
  fs.writeFileSync(outside, "#!/bin/sh\n");
  fs.chmodSync(outside, 0o755);
  const link = path.join(approved, "linked-agent");
  fs.symlinkSync(outside, link);
  const schema = {
    name: "contained",
    command: link,
    args: [],
    cwd: "{cwd}",
    output_protocol: "text_stdout",
    capabilities: { write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
  };
  assert.throws(() => createGenericAdapter(schema, { approvedAdapterDir: approved }), /escapes approvedAdapterDir/);
  assert.throws(() => createGenericAdapter({ ...schema, command: path.join(approved, "..", "outside-agent") }, { approvedAdapterDir: approved }), /escapes approvedAdapterDir/);
});

test("generic invocation pins canonical command identity and detects an inode swap before execution", () => {
  const approved = path.join(root, "identity-approved");
  fs.mkdirSync(approved);
  const original = path.join(approved, "agent-v1");
  const replacement = path.join(approved, "agent-v2");
  const commandLink = path.join(approved, "agent");
  fs.writeFileSync(original, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(replacement, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(original, 0o755);
  fs.chmodSync(replacement, 0o755);
  fs.symlinkSync(original, commandLink);
  const generic = createGenericAdapter({
    name: "identity-agent",
    command: commandLink,
    args: [],
    cwd: "{cwd}",
    output_protocol: "text_stdout",
    capabilities: { write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
  }, { approvedAdapterDir: approved });
  const invocation = generic.buildInvocation({ phase: "dispatch", cwd, promptPath, resultPath });
  assert.equal(invocation.command, fs.realpathSync(original));
  fs.unlinkSync(commandLink);
  fs.symlinkSync(path.join(root, "outside-agent"), commandLink);
  assert.doesNotThrow(() => contract.assertInvocationIdentity(invocation), "symlink swap cannot redirect a canonical command");
  fs.renameSync(replacement, original);
  assert.throws(() => contract.assertInvocationIdentity(invocation), /identity changed after validation/);
});

test("review control invocation rejects tampering and remains immutable", () => {
  assert.throws(() => contract.assertInvocationShape({
    command: process.execPath,
    args: ["wrapper.js"],
    cwd,
    controlInvocation: {
      command: "agent",
      args: ["--sandbox", "read-only"],
      cwd: repo,
    },
  }), /must be bound by the adapter contract/);
  const mismatchedAdapter = contract.makeLegacyCliAdapter({
    name: "mismatched-reviewer",
    legacy: {
      cliBinary: "mismatched",
      defaultTimeout: 1,
      probe() {},
      buildExecCommand() { return { cmd: "mismatched", args: [], cwd }; },
    },
    outputProtocol: "text_stdout",
    reviewScript: path.join(root, "review-wrapper.js"),
    buildReviewControlInvocation: () => ({
      command: "mismatched",
      args: ["--sandbox", "read-only"],
      cwd: repo,
    }),
    phases: {
      primary_review: {
        supported: true,
        write: false,
        readOnly: true,
        networkControl: "informational",
        cancellation: "process",
        structuredOutput: "json",
      },
    },
  });
  assert.throws(() => mismatchedAdapter.buildInvocation({
    phase: "primary_review",
    cwd,
    promptPath,
    resultPath,
    sandbox: "read-only",
    networkAccess: "disabled",
  }), /control invocation cwd must match/);

  const piInvocation = invocationFor(getAdapter("pi"), "primary_review");
  assert.ok(Object.isFrozen(piInvocation.controlInvocation));
  assert.ok(Object.isFrozen(piInvocation.controlInvocation.args));
  assert.throws(() => piInvocation.controlInvocation.args.push("--write"), TypeError);
});

test("all supported primary review adapters pass capability negotiation", () => {
  for (const name of ["codex", "claude", "cursor", "opencode", "pi", "antigravity"]) {
    const adapter = getAdapter(name);
    const capability = contract.validateCapabilities(adapter, "primary_review", {
      readOnly: true,
      sandbox: "read-only",
      networkAccess: "disabled",
    });
    assert.equal(capability.supported, true, name);
  }
});

test("production dispatch and review integration contain no concrete executor-name branches", () => {
  const files = [
    path.join(__dirname, "../../../skills/relay-dispatch/scripts/dispatch.js"),
    path.join(__dirname, "../../../skills/relay-review/scripts/review-runner/reviewer-invoke.js"),
  ];
  const branchPattern = /(?:===|!==|case)\s*["'](?:codex|claude|cursor|opencode|pi|antigravity|cline)["']/;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), branchPattern, file);
});
