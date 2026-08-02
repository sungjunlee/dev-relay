const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../../../skills/relay-dispatch/scripts/adapter-contract");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const transcripts = require("../fixtures/adapter-transcripts.json");

let root;
let repo;
let cwd;
let promptPath;
let resultPath;
let stdoutPath;
let stderrPath;
let schemaPath;

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
  schemaPath = path.join(root, "review-schema.json");
  fs.writeFileSync(promptPath, "Do the thing; do not interpolate $HOME or $(whoami).\n");
  fs.writeFileSync(schemaPath, '{"type":"object"}\n');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function invocationFor(adapter, phase = "dispatch") {
  return adapter.buildInvocation({
    phase,
    cwd,
    promptPath,
    promptBytes: fs.readFileSync(promptPath),
    resultPath,
    schemaPath,
    model: "provider/model; literally-not-a-shell-command",
    timeoutMs: 123456,
    sandbox: adapter.name === "codex" ? "read-only" : "workspace-write",
    networkAccess: "enabled",
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
    assert.equal(adapter.metadata.processContainment, contract.PROCESS_CONTAINMENT);
    assert.equal(adapter.metadata.providerTransport, "remote_required");
    assert.equal(adapter.metadata.credentialTransport, "explicit_bundle");
    assert.ok(adapter.metadata.runtimeDependencies);
    assert.ok(Number.isInteger(adapter.defaults.timeoutMs));
  }
});

test("session-backed adapters expose owner-only credential bundles without secret argv", () => {
  for (const name of ["antigravity", "cline", "cursor"]) {
    const adapter = getAdapter(name), capability = adapter.capabilities({ phase: "dispatch", request: { sandbox: "workspace-write", networkAccess: "enabled" } });
    assert.equal(capability.credentialTransport, "explicit_bundle", name);
    assert.ok(adapter.metadata.credentials.files.length > 0, name);
    const invocation = invocationFor(adapter); assert.equal(invocation.args.includes("-k"), false, name);
  }
});

test("provider transport is outer-enabled while only verified adapters may force-disable tool networking", () => {
  for (const name of listAdapters()) {
    const adapter = getAdapter(name), invocation = invocationFor(adapter);
    assert.equal(invocation.networkAccess, "enabled", name);
    assert.equal(invocation.toolNetworkAccess, "enabled", name);
    assert.ok(Object.isFrozen(invocation.runtimeDependencies), name);
  }
  for (const name of ["claude", "codex", "cursor", "antigravity", "opencode", "cline"]) assert.throws(() => getAdapter(name).buildInvocation({
    phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath, sandbox: "workspace-write", networkAccess: "disabled",
  }), (error) => error instanceof contract.AdapterCapabilityError && /tool network disable/.test(error.message), name);
  for (const name of ["pi"]) {
    const invocation = getAdapter(name).buildInvocation({ phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
      sandbox: "workspace-write", networkAccess: "disabled", timeoutSeconds: 123 });
    assert.equal(invocation.networkAccess, "enabled", name);
    assert.equal(invocation.toolNetworkAccess, "disabled", name);
  }
  for (const name of ["pi", "cline"]) assert.deepEqual(getAdapter(name).metadata.runtimeDependencies, { executableParent: 1, interpreterParent: null }, name);
  assert.deepEqual(getAdapter("cursor").metadata.runtimeDependencies, { executableParent: 0, interpreterParent: null });
  for (const name of listAdapters().filter((value) => !["pi", "cline", "cursor"].includes(value))) {
    assert.deepEqual(getAdapter(name).metadata.runtimeDependencies, { executableParent: null, interpreterParent: null }, name);
  }
});

test("every dispatch adapter returns argv-only invocations and preserves metacharacters as data", () => {
  const stdinAdapters = new Set(["claude", "codex", "cursor", "opencode", "pi"]);
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
    if (stdinAdapters.has(name)) {
      assert.equal(invocation.stdinPath, promptPath, name);
      assert.doesNotMatch(serialized, /Do the thing|\$HOME|RELAY WORKTREE BOUNDARY/, name);
    } else {
      assert.match(serialized, /\$HOME|RELAY WORKTREE BOUNDARY/, name);
    }
  }
});

test("Codex omits the reasoning override when the operator did not select one", () => {
  const invocation = getAdapter("codex").buildInvocation({
    phase: "dispatch",
    cwd,
    promptPath,
    promptBytes: fs.readFileSync(promptPath),
    resultPath,
    model: null,
    timeoutMs: 123456,
    sandbox: "workspace-write",
    networkAccess: "enabled",
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
  assert.equal(contract.validateCapabilities(getAdapter("cursor"), "dispatch", { readOnly: true, sandbox: "read-only", networkAccess: "enabled" }).supported, true);
  assert.equal(contract.validateCapabilities(getAdapter("codex"), "primary_review", { readOnly: true }).supported, true);
  assert.equal(
    getAdapter("codex").buildInvocation({
      phase: "dispatch",
      cwd,
      promptPath,
      promptBytes: fs.readFileSync(promptPath),
      resultPath,
      sandbox: "read-only",
      networkAccess: "enabled",
    }).networkAccess,
    "enabled",
  );
});

test("supported primary review roles build direct read-only CLI invocations, never wrapper or shell commands", () => {
  for (const name of ["codex", "claude", "cursor", "opencode", "pi", "antigravity"]) {
    const phase = "primary_review";
    const invocation = invocationFor(getAdapter(name), phase);
    assert.notEqual(invocation.command, process.execPath, `${name}/${phase}`);
    assert.equal(invocation.cwd, cwd, `${name}/${phase}`);
    assert.equal(invocation.args.some((arg) => /invoke-reviewer-/.test(arg)), false, `${name}/${phase}`);
    assert.ok(!invocation.args.join("\u0000").includes("sh -c"), `${name}/${phase}`);
    assert.ok(
      invocation.stdinPath === promptPath
      || invocation.args.includes(fs.readFileSync(promptPath, "utf8")),
      `${name}/${phase}`
    );
  }
});

test("native invocation requires trusted prompt bytes and rejects invalid UTF-8 without reopening promptPath", () => {
  const adapter = getAdapter("codex");
  const input = {
    phase: "dispatch",
    cwd,
    promptPath,
    resultPath,
    sandbox: "workspace-write",
    networkAccess: "enabled",
  };
  assert.throws(() => adapter.buildInvocation(input), /promptBytes must be a Buffer/);
  assert.throws(
    () => adapter.buildInvocation({ ...input, promptBytes: Buffer.from([0xff, 0xfe]) }),
    /valid canonical UTF-8/,
  );

  const trusted = Buffer.from("trusted bytes\n", "utf8");
  const original = fs.readFileSync(promptPath);
  fs.writeFileSync(promptPath, "attacker path bytes\n");
  try {
    const invocation = adapter.buildInvocation({ ...input, promptBytes: trusted });
    assert.equal(invocation.stdinPath, promptPath);
    assert.equal(invocation.stdinSha256, require("node:crypto").createHash("sha256").update(trusted).digest("hex"));
    assert.equal(invocation.args.includes("trusted bytes\n"), false);
    assert.equal(invocation.args.includes("attacker path bytes\n"), false);
  } finally {
    fs.writeFileSync(promptPath, original);
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

test("all seven native adapters preserve full dispatch argv order and policy inputs", () => {
  const prompt = fs.readFileSync(promptPath, "utf8");
  const model = "provider/model; literally-not-a-shell-command";
  const commonDir = path.resolve(cwd, execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
  const opencodePrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, "Run every shell command from that repository worktree.", "Do not read, write, git add, git commit, or create files outside that repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
  const antigravityPrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, `Before doing anything, run: cd ${cwd}`, "Create and edit source files only in that repository worktree. You may inspect git status, but do not run git add, git commit, git push, or create a PR; canonical relay recovery owns Git metadata and publication.", "Do not create, edit, or report source files under ~/.gemini, scratch directories, or any path outside the repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
  const clinePrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, "Run every shell command from that repository worktree.", "Do not read, write, git add, git commit, or create files outside that repository worktree.", "Do not use cline --worktree; relay already created and owns this worktree.", "", prompt].join("\n");
  const golden = {
    codex: { command: "codex", args: ["exec", "-C", cwd, "--color", "never", "-o", resultPath, "-c", "model_reasoning_effort=high", "-m", model, "--sandbox", "danger-full-access", "-"] },
    claude: { command: "claude", args: ["-p", "--safe-mode", "--output-format", "text", "--allowedTools", "Read,Write,Edit,Glob,Grep", "--disallowedTools", "Bash,WebFetch,WebSearch,Agent", "--model", model] },
    cursor: { command: "agent", args: ["--print", "--trust", "--auto-review", "--workspace", cwd, "--output-format", "text", "--sandbox", "disabled", "--model", model] },
    opencode: { command: "opencode", args: ["run", "--pure", "--dir", cwd, "-m", model] },
    pi: { command: "pi", args: ["--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--tools", "read,grep,find,ls,write,edit", "--model", model, "--thinking", "high", "--print"] },
    antigravity: { command: "agy", args: ["--prompt", antigravityPrompt, "--print-timeout", "123s", "--mode", "accept-edits", "--disable-slash-commands", "--sandbox"] },
    cline: { command: "cline", args: ["--json", "-P", "provider", "-m", model, "--cwd", cwd, "--auto-approve", "true", "--timeout", "123", clinePrompt] },
  };
  for (const [name, expected] of Object.entries(golden)) {
    const invocation = invocationFor(getAdapter(name));
    assert.equal(invocation.command, expected.command, name);
    assert.deepEqual([...invocation.args], expected.args, name);
    assert.equal(invocation.cwd, cwd, name);
    if (!["antigravity", "cline"].includes(name)) {
      assert.equal(invocation.stdinPath, promptPath, name);
      assert.equal(invocation.stdinSha256, require("node:crypto").createHash("sha256").update(prompt).digest("hex"), name);
    }
  }
});

test("dry-run uses the same real adapter builder and argv as launch for all seven executors", () => {
  function normalize(args) {
    return [...args].map((value) => (
      value === resultPath || /relay-dispatch-dry-run-[^/]+\/executor-output$/.test(value)
        ? "<RESULT>"
        : value
    ));
  }
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    const values = {
      branch: null,
      copy: null,
      model: "provider/model; literally-not-a-shell-command",
      reasoning: "high",
      sandbox: name === "codex" ? "read-only" : "workspace-write",
      "network-access": "enabled",
    };
    const cli = { creating: false, runId: `dry-${name}`, timeoutSeconds: 123, values };
    const actual = dispatch.dryRunInvocation({
      cli,
      identity: { checkout: cwd, repoRoot: repo },
      adapter,
      inputs: { prompt: { path: promptPath, bytes: fs.readFileSync(promptPath) }, rubric: null },
    });
    const launched = adapter.buildInvocation({
      phase: "dispatch",
      cwd,
      promptPath,
      promptBytes: fs.readFileSync(promptPath),
      resultPath,
      model: values.model,
      timeoutMs: 123_000,
      sandbox: values.sandbox,
      networkAccess: values["network-access"],
      reasoning: values.reasoning,
    });
    assert.equal(actual.command, launched.command, name);
    assert.equal(actual.cwd, launched.cwd, name);
    assert.deepEqual(normalize(actual.args), normalize(launched.args), name);
    assert.equal(actual.validation, "adapter_build_invocation", name);
    assert.equal(actual.launch_boundary, "host_sandbox_required_do_not_execute_raw", name);
  }
});

test("Codex and Cursor disable only their nested sandbox under the required host boundary", () => {
  for (const phase of ["dispatch", "primary_review"]) {
    const codex = invocationFor(getAdapter("codex"), phase), cursor = invocationFor(getAdapter("cursor"), phase);
    assert.deepEqual(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
    assert.equal(codex.args.includes("--skip-git-repo-check"), phase === "primary_review");
    assert.equal(codex.args.includes("--add-dir"), false);
    assert.deepEqual(cursor.args.slice(cursor.args.indexOf("--sandbox"), cursor.args.indexOf("--sandbox") + 2), ["--sandbox", "disabled"]);
    assert.deepEqual(cursor.privateEnvPaths, [{ key: "CURSOR_CONFIG_DIR", root: "home", relative: ".cursor" }, { key: "CURSOR_DATA_DIR", root: "scratch", relative: "cursor-data" }]);
  }
  assert.equal(getAdapter("cursor").capabilities({ phase: "dispatch", request: { sandbox: "read-only", networkAccess: "enabled" } }).supported, true);
});

test("adapter metadata is static and carries no integration side channel", () => {
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    assert.equal(Object.hasOwn(adapter, "integrations"), false, name);
    assert.equal(Object.values(adapter.metadata).some((value) => typeof value === "function"), false, `${name} metadata must be static`);
    assert.ok(Array.isArray(adapter.metadata.credentials.files), `${name} credential files`);
    assert.ok(Array.isArray(adapter.metadata.credentials.envHints), `${name} credential env hints`);
    for (const file of adapter.metadata.credentials.files) {
      assert.deepEqual(Object.keys(file).sort(), ["access", "id", "recommendedSource", "targetRel", "targetRoot"], name);
    }
  }
  assert.deepEqual(getAdapter("pi").metadata.credentials.envHints, ["QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"]);
  assert.deepEqual(getAdapter("claude").metadata.credentials.envHints, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
});

test("Claude disables customizations without disabling explicit OAuth in either phase", () => {
  for (const phase of ["dispatch", "primary_review"]) {
    const invocation = invocationFor(getAdapter("claude"), phase);
    assert.equal(invocation.args.includes("--safe-mode"), true, phase);
    assert.equal(invocation.args.includes("--bare"), false, phase);
  }
  assert.equal(invocationFor(getAdapter("claude"), "primary_review").args.includes("--no-session-persistence"), true);
  assert.equal(getAdapter("claude").capabilities({ phase: "dispatch" }).networkControl, "informational");
  assert.throws(() => getAdapter("claude").buildInvocation({ phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
    sandbox: "workspace-write", networkAccess: "disabled" }), /tool network disable/);
});

test("private environment paths are closed, relative, rooted, and collision-free", () => {
  const shape = (privateEnvPaths) => ({ command: process.execPath, args: [], cwd, privateEnvPaths });
  assert.deepEqual(contract.assertInvocationShape(shape([{ key: "TOOL_DIR", root: "scratch", relative: "tool-data" }])).privateEnvPaths,
    [{ key: "TOOL_DIR", root: "scratch", relative: "tool-data" }]);
  for (const value of [[{ key: "TOOL_DIR", root: "scratch", relative: "/tmp/escape" }], [{ key: "TOOL_DIR", root: "home", relative: "../escape" }],
    [{ key: "HOME", root: "home", relative: ".tool" }], [{ key: "TOOL_DIR", root: "outside", relative: ".tool" }],
    [{ key: "TOOL_DIR", root: "home", relative: ".tool" }, { key: "TOOL_DIR", root: "scratch", relative: "tool" }]]) {
    assert.throws(() => contract.assertInvocationShape(shape(value)), /private environment path is invalid/);
  }
});

test("credential requests are value-free, catalog-bound, and reject reserved or ambiguous inputs", () => {
  const metadata = getAdapter("codex").metadata.credentials;
  const missingSource = path.join(root, "not-opened-auth.json");
  const request = contract.credentialRequest(metadata, {
    envNames: ["OPENAI_API_KEY"], fileSpecs: [`auth=${missingSource}`],
  });
  assert.deepEqual(request.summary, { env_names: ["OPENAI_API_KEY"], file_ids: ["auth"] });
  assert.equal(fs.existsSync(missingSource), false, "normalization must not open a credential source");
  for (const name of ["HOME", "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "PYTHONPATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"])
    assert.throws(() => contract.credentialRequest(metadata, { envNames: [name] }), /unsafe, reserved/, name);
  assert.throws(() => contract.credentialRequest({ files: [], envHints: ["NODE_OPTIONS"] }), /metadata/);
  assert.throws(() => contract.credentialRequest(metadata, { envNames: ["TOKEN", "TOKEN"] }), /duplicated/);
  assert.throws(() => contract.credentialRequest(metadata, { fileSpecs: [`unknown=${missingSource}`] }), /declared/);
  assert.throws(() => contract.credentialRequest(metadata, { fileSpecs: ["auth=relative"] }), /absolute/);
  assert.throws(() => contract.credentialRequest(metadata, { fileSpecs: [`auth=${missingSource}`, `auth=${missingSource}`] }), /collision/);
});

test("review invocation is an immutable direct descriptor without hidden lifecycle hooks", () => {
  assert.throws(() => contract.assertInvocationShape({
    command: process.execPath,
    args: ["wrapper.js"],
    cwd,
    controlInvocation: { command: "agent", args: ["--sandbox", "read-only"], cwd: repo },
  }), /unsupported metadata/);
  const piInvocation = invocationFor(getAdapter("pi"), "primary_review");
  assert.equal(piInvocation.command, "pi");
  assert.equal(piInvocation.stdinPath, promptPath);
  assert.equal(piInvocation.controlInvocation, undefined);
  assert.ok(Object.isFrozen(piInvocation));
  assert.ok(Object.isFrozen(piInvocation.args));
  assert.throws(() => piInvocation.args.push("--write"), TypeError);
});

test("Pi dispatch retains locate/read/edit tools while review removes only mutation", () => {
  const dispatch = invocationFor(getAdapter("pi"), "dispatch"), review = invocationFor(getAdapter("pi"), "primary_review");
  const dispatchTools = dispatch.args[dispatch.args.indexOf("--tools") + 1].split(","), reviewTools = review.args[review.args.indexOf("--tools") + 1].split(",");
  assert.deepEqual(dispatchTools, ["read", "grep", "find", "ls", "write", "edit"]);
  assert.deepEqual(reviewTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(dispatchTools.filter((tool) => !["write", "edit"].includes(tool)), reviewTools);
  assert.ok(!dispatchTools.includes("bash")); assert.ok(!reviewTools.includes("bash"));
});

test("Antigravity review transports exact staged prompt bytes as one argv value", () => {
  const prompt = fs.readFileSync(promptPath, "utf8");
  const invocation = invocationFor(getAdapter("antigravity"), "primary_review");
  const promptIndex = invocation.args.indexOf("--prompt");
  assert.notEqual(promptIndex, -1);
  assert.equal(invocation.args[promptIndex + 1], prompt);
  assert.equal(invocation.args.some((value) => value === `@${promptPath}`), false);
  assert.deepEqual(invocation.args.slice(-5), ["--output-format", "text", "--mode", "plan", "--disable-slash-commands", "--sandbox"].slice(-5));
});

test("Antigravity rejects prompts above its conservative argv budget before process-list exposure", () => {
  assert.throws(() => getAdapter("antigravity").buildInvocation({
    phase: "primary_review",
    cwd,
    promptPath,
    promptBytes: Buffer.alloc(256 * 1024, "x"),
    resultPath,
    schemaPath,
    timeoutMs: 123_000,
    sandbox: "read-only",
    networkAccess: "enabled",
  }), /argv.*256 KiB.*process list/i);
  assert.equal(getAdapter("antigravity").metadata.promptTransport, "argv_visible");
  assert.match(getAdapter("antigravity").metadata.promptTransportWarning, /process list.*256 KiB/i);
});

test("argv-visible prompt exceptions are exactly Cline and Antigravity and are declarative bounded warnings", () => {
  const exceptions = listAdapters().filter((name) => getAdapter(name).metadata.promptTransport === "argv_visible");
  assert.deepEqual([...exceptions].sort(), ["antigravity", "cline"]);
  for (const name of exceptions) assert.match(getAdapter(name).metadata.promptTransportWarning, /process list.*256 KiB/i, name);
  for (const name of ["claude", "codex", "cursor", "opencode", "pi"]) {
    assert.match(getAdapter(name).metadata.promptTransport, /^stdin/);
    const invocation = invocationFor(getAdapter(name));
    assert.equal(invocation.args.includes(fs.readFileSync(promptPath, "utf8")), false, name);
  }
});

test("all supported primary review adapters pass capability negotiation", () => {
  for (const name of ["codex", "claude", "cursor", "opencode", "pi", "antigravity"]) {
    const adapter = getAdapter(name);
    const capability = contract.validateCapabilities(adapter, "primary_review", {
      readOnly: true,
      sandbox: "read-only",
      networkAccess: "enabled",
    });
    assert.equal(capability.supported, true, name);
  }
});

test("production dispatch and review integration contain no concrete executor-name branches", () => {
  const files = [
    path.join(__dirname, "../../../skills/relay-dispatch/scripts/dispatch.js"),
    path.join(__dirname, "../../../skills/relay-review/scripts/review-runner.js"),
  ];
  const branchPattern = /(?:===|!==|case)\s*["'](?:codex|claude|cursor|opencode|pi|antigravity|cline)["']/;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), branchPattern, file);
});

test("native adapter sources have no reverse imports into relay-review", () => {
  const adaptersDir = path.join(__dirname, "../../../skills/relay-dispatch/scripts/adapters");
  for (const file of fs.readdirSync(adaptersDir).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(adaptersDir, file), "utf8");
    assert.doesNotMatch(source, /require\([^\n]*relay-review/, file);
  }
});
