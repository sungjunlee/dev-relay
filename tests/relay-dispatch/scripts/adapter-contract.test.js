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
    assert.equal(Object.hasOwn(adapter.metadata, "credentialTransport"), false);
    assert.equal(Object.hasOwn(adapter.metadata, "credentials"), false);
    assert.equal(Object.hasOwn(adapter.capabilities({ phase: "dispatch" }), "commandExecution"), false, name);
    assert.ok(adapter.metadata.runtimeDependencies);
    assert.ok(Number.isInteger(adapter.defaults.timeoutMs));
  }
});

test("session-backed adapters rely on the ambient host session without secret argv", () => {
  for (const name of ["antigravity", "cline", "cursor"]) {
    const adapter = getAdapter(name), capability = adapter.capabilities({ phase: "dispatch", request: { networkAccess: "enabled" } });
    assert.equal(Object.hasOwn(capability, "credentialTransport"), false, name);
    assert.equal(Object.hasOwn(adapter.metadata, "credentials"), false, name);
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
    phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath, networkAccess: "disabled",
  }), (error) => error instanceof contract.AdapterCapabilityError && /tool network disable/.test(error.message), name);
  for (const name of ["pi"]) {
    const invocation = getAdapter(name).buildInvocation({ phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
      networkAccess: "disabled", timeoutSeconds: 123 });
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
    (error) => error instanceof contract.AdapterCapabilityError && /structured primary-review output contract/.test(error.message)
  );
  assert.equal(contract.validateCapabilities(getAdapter("cursor"), "dispatch", { networkAccess: "enabled" }).supported, true);
  assert.equal(contract.validateCapabilities(getAdapter("codex"), "primary_review", { readOnly: true }).supported, true);
  assert.equal(
    getAdapter("codex").buildInvocation({
      phase: "dispatch",
      cwd,
      promptPath,
      promptBytes: fs.readFileSync(promptPath),
      resultPath,
      networkAccess: "enabled",
    }).networkAccess,
    "enabled",
  );
});

test("adapter filesystem-isolation metadata is a closed static contract", () => {
  const create = (dispatch) => contract.createNativeAdapter({
    name: "filesystem-contract-fixture",
    timeoutMs: 1_000,
    metadata: {
      cliBinary: "fixture", processContainment: contract.PROCESS_CONTAINMENT,
      providerTransport: "remote_required", credentialTransport: "explicit_bundle",
      runtimeDependencies: { executableParent: null, interpreterParent: null }, credentials: { files: [], envHints: [] },
    },
    phases: { dispatch },
    outputProtocol: "text_stdout",
    buildDispatch: () => ({ command: "fixture", args: [], cwd }),
  });
  const base = { supported: true, write: true, readOnly: false, networkControl: "informational", loopbackListen: "unknown", cancellation: "process", structuredOutput: "text" };
  assert.doesNotThrow(() => create({ ...base, filesystemIsolation: "native", filesystemIsolationRequest: "workspace-write" }));
  assert.throws(() => create({ ...base, filesystemIsolation: "natvie", filesystemIsolationRequest: "workspace-write" }), /known filesystemIsolation/);
  assert.throws(() => create({ ...base, filesystemIsolation: "native" }), /native filesystemIsolationRequest/);
  assert.throws(() => create({ ...base, filesystemIsolation: "native", filesystemIsolationRequest: "writeable" }), /native filesystemIsolationRequest/);
  assert.doesNotThrow(() => create({ ...base, filesystemIsolation: "not_requested" }));
  assert.throws(() => create({ ...base, filesystemIsolation: "none", filesystemIsolationRequest: "read-only" }), /only valid with native/);
  assert.throws(() => create({ ...base, filesystemIsolation: "none", loopbackListen: "loopback" }), /known loopbackListen/);
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

test("OpenCode dispatch and review use the current non-interactive diagnostic argv", () => {
  const adapter = getAdapter("opencode");
  assert.deepEqual(invocationFor(adapter).args, [
    "run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure", "--dir", cwd,
    "-m", "provider/model; literally-not-a-shell-command",
  ]);
  assert.deepEqual(invocationFor(adapter, "primary_review").args, [
    "run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure",
    "-m", "provider/model; literally-not-a-shell-command",
  ]);
});

test("native invocation requires trusted prompt bytes and rejects invalid UTF-8 without reopening promptPath", () => {
  const adapter = getAdapter("codex");
  const input = {
    phase: "dispatch",
    cwd,
    promptPath,
    resultPath,
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
    assert.equal(adapter.parseOutcome({ exitCode: 0, stdoutPath, stderrPath, resultPath }).status,
      ["antigravity", "cline"].includes(name) ? "failed" : "empty", `${name} empty golden`);
    assert.equal(adapter.parseOutcome({ exitCode: 0, timedOut: true, stdoutPath, stderrPath, resultPath }).status, "timed_out", name);
    assert.equal(adapter.parseOutcome({ exitCode: 0, signal: "SIGTERM", stdoutPath, stderrPath, resultPath }).status, "cancelled", name);
  }
});

test("Codex parses a supervisor-proven completion even when timeout termination killed the process", () => {
  const prior = fs.existsSync(resultPath) ? fs.readFileSync(resultPath) : null;
  try {
    fs.writeFileSync(resultPath, "codex completed before timeout\n");
    const outcome = getAdapter("codex").parseOutcome({
      exitCode: 0, signal: "SIGKILL", timedOut: false, completionProven: true,
      stdoutPath, stderrPath, resultPath,
    });
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.output, "codex completed before timeout\n");
  } finally {
    if (prior === null) fs.rmSync(resultPath, { force: true });
    else fs.writeFileSync(resultPath, prior);
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
    assert.equal(isolatedEnvironment.status, "skipped", `${name} unavailable CLI probe`);
  }
});

test("all seven native adapters preserve full dispatch argv order and policy inputs", () => {
  const prompt = fs.readFileSync(promptPath, "utf8");
  const model = "provider/model; literally-not-a-shell-command";
  const commonDir = path.resolve(cwd, execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
  const opencodePrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, "Run every shell command from that repository worktree.", "Do not read, write, git add, git commit, or create files outside that repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
  const antigravityPrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, `Before doing anything, run: cd ${cwd}`, "Create and edit source files only in that repository worktree. You may inspect git status, but do not run git add, git commit, git push, or create a PR; canonical relay recovery owns Git metadata and publication.", "Do not create, edit, or report source files under ~/.gemini, scratch directories, or any path outside the repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
  const clinePrompt = ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, "Run every shell command from that repository worktree.", "Do not read, write, git add, git commit, or create files outside that repository worktree.", "Do not use cline --worktree; relay already created and owns this worktree.", "", prompt].join("\n");
  const claudeSandbox = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
  const golden = {
    codex: { command: "codex", args: ["exec", "-C", cwd, "--color", "never", "-o", resultPath, "-c", "model_reasoning_effort=high", "-m", model, "--sandbox", "workspace-write", "-"] },
    claude: { command: "claude", args: ["-p", "--settings", claudeSandbox, "--output-format", "text", "--allowedTools", "Read,Write,Edit,Glob,Grep,Bash", "--disallowedTools", "WebFetch,WebSearch,Agent", "--model", model] },
    cursor: { command: "agent", args: ["--print", "--trust", "--auto-review", "--workspace", cwd, "--output-format", "text", "--sandbox", "enabled", "--model", model] },
    opencode: { command: "opencode", args: ["run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure", "--dir", cwd, "-m", model] },
    pi: { command: "pi", args: ["--no-session", "--no-context-files", "--no-skills", "--tools", "read,grep,find,ls,write,edit", "--model", model, "--thinking", "high", "--print"] },
    antigravity: { command: "agy", args: ["--prompt", antigravityPrompt, "--print-timeout", "123s", "--mode", "accept-edits", "--output-format", "json", "--disable-slash-commands", "--sandbox"] },
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

test("Pi binds the manifest-declared Alibaba extension for primary review", () => {
  const adapter = getAdapter("pi");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(root, "missing-alibaba-home");
  const input = {
    phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
    model: "alibaba-plan/qwen3.8-max", networkAccess: "enabled",
  };
  const dispatchCapability = adapter.capabilities({ phase: "dispatch", request: {
    networkAccess: "enabled", model: input.model,
  } });
  assert.equal(dispatchCapability.supported, true);
  const dispatch = adapter.buildInvocation(input);
  assert.equal(dispatch.args.includes("--no-extensions"), false);
  assert.deepEqual(dispatch.args.slice(dispatch.args.indexOf("--model"), dispatch.args.indexOf("--model") + 2), ["--model", input.model]);

  const reviewCapability = adapter.capabilities({ phase: "primary_review", request: {
    readOnly: true, networkAccess: "enabled", model: input.model,
  } });
  assert.equal(reviewCapability.supported, false);
  assert.equal(reviewCapability.errorCode, "PI_EXTENSION_BINDING_MISSING");
  assert.equal(reviewCapability.diagnostic.stage, "pre-provider");
  assert.throws(() => adapter.buildInvocation({ ...input, phase: "primary_review", schemaPath }), (error) => {
    assert.equal(error.name, "AdapterCapabilityError");
    assert.equal(error.code, "PI_EXTENSION_BINDING_MISSING");
    assert.deepEqual(error.diagnostic, {
      code: "PI_EXTENSION_BINDING_MISSING",
      kind: "extension_binding",
      stage: "pre-provider",
      provider: "alibaba-plan",
      model: "alibaba-plan/qwen3.8-max",
      extension: "pi-alibaba-models",
      reason: "the manifest-declared Alibaba extension entry is not a trusted regular file",
    });
    assert.match(error.message, /installed pi-alibaba-models extension binding/);
    return true;
  });
  const alibabaHome = path.join(root, "alibaba-home");
  const packageRoot = path.join(alibabaHome, ".pi", "agent", "npm", "node_modules", "pi-alibaba-models");
  fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "pi-alibaba-models", pi: { extensions: ["extensions/alibaba.ts"] },
  }));
  fs.writeFileSync(path.join(packageRoot, "extensions", "alibaba.ts"), "export default {};\n");
  const alibabaHomeAlias = path.join(root, "alibaba-home-alias");
  fs.symlinkSync(alibabaHome, alibabaHomeAlias, "dir");
  process.env.HOME = alibabaHomeAlias;
  try {
    const bound = adapter.buildInvocation({ ...input, phase: "primary_review", schemaPath });
    const canonicalPackageRoot = fs.realpathSync(packageRoot);
    const extensionPath = fs.realpathSync(path.join(packageRoot, "extensions", "alibaba.ts"));
    assert.deepEqual(bound.args.slice(bound.args.indexOf("--extension"), bound.args.indexOf("--extension") + 2), ["--extension", extensionPath]);
    assert.equal(bound.extensionBinding.root, canonicalPackageRoot);
    assert.equal(bound.extensionBinding.entry.path, extensionPath);
    assert.deepEqual(bound.extensionBinding.runtimeFiles.map((file) => file.path), [
      fs.realpathSync(path.join(packageRoot, "package.json")), extensionPath,
    ]);
    assert.equal(bound.args.includes("--no-extensions"), true, "ambient extension discovery remains disabled");
    const manifestPath = path.join(packageRoot, "package.json");
    fs.writeFileSync(manifestPath, "{");
    assert.equal(adapter.capabilities({ phase: "primary_review", request: { readOnly: true, networkAccess: "enabled", model: input.model } }).errorCode, "PI_EXTENSION_BINDING_INVALID");
    fs.writeFileSync(manifestPath, JSON.stringify({ name: "pi-alibaba-models", pi: { extensions: ["extensions/alibaba.ts", "extensions/other.ts"] } }));
    assert.equal(adapter.capabilities({ phase: "primary_review", request: { readOnly: true, networkAccess: "enabled", model: input.model } }).errorCode, "PI_EXTENSION_BINDING_INVALID");
    fs.writeFileSync(manifestPath, JSON.stringify({ name: "pi-alibaba-models", pi: { extensions: ["../escape.ts"] } }));
    assert.equal(adapter.capabilities({ phase: "primary_review", request: { readOnly: true, networkAccess: "enabled", model: input.model } }).errorCode, "PI_EXTENSION_BINDING_INVALID");
    fs.writeFileSync(manifestPath, JSON.stringify({ name: "pi-alibaba-models", pi: { extensions: ["extensions/alibaba.ts"] } }));
    const outside = path.join(alibabaHome, "outside.ts"); fs.writeFileSync(outside, "outside\n"); fs.unlinkSync(extensionPath); fs.symlinkSync(outside, extensionPath);
    assert.equal(adapter.capabilities({ phase: "primary_review", request: { readOnly: true, networkAccess: "enabled", model: input.model } }).errorCode, "PI_EXTENSION_BINDING_INVALID");
    fs.unlinkSync(extensionPath); fs.writeFileSync(extensionPath, "export default {};\n");

    const linkedHome = path.join(root, "linked-package-home");
    const linkedRoot = path.join(linkedHome, ".pi", "agent", "npm", "node_modules", "pi-alibaba-models");
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(packageRoot, linkedRoot, "dir");
    process.env.HOME = linkedHome;
    assert.equal(adapter.capabilities({ phase: "primary_review", request: { readOnly: true, networkAccess: "enabled", model: input.model } }).errorCode, "PI_EXTENSION_BINDING_INVALID");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
  assert.deepEqual([...adapter.buildInvocation({
    ...input, phase: "primary_review", schemaPath, model: "openai/gpt-5",
  }).args], [
    "--no-session", "--no-context-files", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls",
    "--model", "openai/gpt-5", "--print",
  ]);
  for (const model of ["qwen/qwen3.8-max", null]) {
    const invocation = adapter.buildInvocation({ ...input, phase: "primary_review", schemaPath, model });
    assert.equal(invocation.args.includes("--no-extensions"), true);
    assert.equal(invocation.args.includes("--model"), model !== null);
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
      networkAccess: values["network-access"],
      reasoning: values.reasoning,
    });
    assert.equal(actual.command, launched.command, name);
    assert.equal(actual.cwd, launched.cwd, name);
    assert.deepEqual(normalize(actual.args), normalize(launched.args), name);
    assert.equal(actual.validation, "adapter_build_invocation", name);
    assert.equal(actual.launch_boundary, "host_supervisor_required_do_not_execute_raw", name);
  }
});

test("Codex and Cursor derive native requests from phase metadata without an outer Relay boundary", () => {
  for (const phase of ["dispatch", "primary_review"]) {
    const codex = invocationFor(getAdapter("codex"), phase), cursor = invocationFor(getAdapter("cursor"), phase);
    assert.deepEqual(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2), ["--sandbox", phase === "primary_review" ? "read-only" : "workspace-write"]);
    assert.equal(codex.args.includes("--skip-git-repo-check"), phase === "primary_review");
    assert.equal(codex.args.includes("--add-dir"), false);
    assert.deepEqual(cursor.args.slice(cursor.args.indexOf("--sandbox"), cursor.args.indexOf("--sandbox") + 2), ["--sandbox", "enabled"]);
    assert.equal(Object.hasOwn(cursor, "privateEnvPaths"), false);
  }
  assert.equal(getAdapter("cursor").capabilities({ phase: "dispatch", request: { networkAccess: "enabled" } }).supported, true);
  assert.deepEqual(contract.filesystemIsolationDiagnostic(getAdapter("codex"), "dispatch", {
    networkAccess: "enabled",
  }), { requested: "workspace-write", effective: "native", diagnostic: null });
});

test("dispatch keeps fixed writable-worktree semantics while the adapter owns its native filesystem request", () => {
  const promptBytes = fs.readFileSync(promptPath);
  const base = { phase: "dispatch", cwd, promptPath, promptBytes, resultPath, model: null, timeoutMs: 123_000, networkAccess: "enabled" };
  const codex = getAdapter("codex").buildInvocation(base);
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"], "Codex dispatch argv is fixed to workspace-write");
  const cursor = getAdapter("cursor").buildInvocation(base);
  assert.deepEqual(cursor.args.slice(cursor.args.indexOf("--sandbox"), cursor.args.indexOf("--sandbox") + 2), ["--sandbox", "enabled"], "Cursor dispatch argv is fixed to enabled");
  const antigravity = getAdapter("antigravity").buildInvocation(base);
  assert.equal(antigravity.args.includes("--sandbox"), true, "Antigravity keeps its declared --sandbox flag");
  const claude = getAdapter("claude").buildInvocation(base);
  assert.equal(claude.args.includes(JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } })), true, "Claude dispatch enables its native Bash sandbox settings");
});

test("generic adapter invocation defaults tool networking to disabled", () => {
  assert.throws(() => getAdapter("codex").buildInvocation({
    phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
  }), /tool network disable/);
});

test("adapter metadata is static and carries no integration side channel", () => {
  for (const name of listAdapters()) {
    const adapter = getAdapter(name);
    assert.equal(Object.hasOwn(adapter, "integrations"), false, name);
    assert.equal(Object.values(adapter.metadata).some((value) => typeof value === "function"), false, `${name} metadata must be static`);
    assert.equal(Object.hasOwn(adapter.metadata, "credentials"), false, `${name} has no credential catalog`);
  }
});

test("Claude dispatch enables native Bash while primary review is tool-read-only", () => {
  const dispatchInvocation = invocationFor(getAdapter("claude"));
  const reviewInvocation = invocationFor(getAdapter("claude"), "primary_review");
  assert.equal(dispatchInvocation.args.includes("--settings"), true);
  assert.equal(dispatchInvocation.args.includes(JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } })), true);
  assert.equal(dispatchInvocation.args.some((value) => value.includes("Bash")), true);
  assert.equal(dispatchInvocation.args.includes("--bare"), false);
  assert.equal(reviewInvocation.args.includes("--settings"), false);
  assert.equal(reviewInvocation.args.includes("--safe-mode"), true);
  assert.equal(reviewInvocation.args.includes("Read,Bash"), false);
  assert.equal(reviewInvocation.args.includes("Read"), true);
  assert.equal(reviewInvocation.args.includes("Bash,Write,Edit,WebFetch,WebSearch,Agent"), true);
  assert.equal(reviewInvocation.args.includes("--no-session-persistence"), true);
  assert.deepEqual(contract.filesystemIsolationDiagnostic(getAdapter("claude"), "dispatch"), {
    requested: "enabled", effective: "native_bash",
    diagnostic: "claude enables its native Bash sandbox; built-in file tools remain permission-bound rather than filesystem-sandboxed.",
  });
  assert.deepEqual(contract.filesystemIsolationDiagnostic(getAdapter("claude"), "primary_review", { readOnly: true }), {
    requested: "not_requested", effective: "not_requested",
    diagnostic: "claude native filesystem isolation is not requested for read-only primary review; continuing directly on the trusted local host.",
  });
  assert.equal(getAdapter("claude").capabilities({ phase: "dispatch" }).networkControl, "informational");
  assert.throws(() => getAdapter("claude").buildInvocation({ phase: "dispatch", cwd, promptPath, promptBytes: fs.readFileSync(promptPath), resultPath,
    networkAccess: "disabled" }), /tool network disable/);
});

test("invocation contract rejects retired private-environment metadata", () => {
  assert.throws(() => contract.assertInvocationShape({ command: process.execPath, args: [], cwd,
    privateEnvPaths: [{ key: "TOOL_DIR", root: "scratch", relative: "tool-data" }] }), /unsupported metadata/);
  assert.equal(Object.hasOwn(contract, "credentialRequest"), false);
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
  assert.deepEqual(invocation.args, [
    "--add-dir", cwd,
    "--prompt", prompt,
    "--print-timeout", "123s",
    "--output-format", "json",
    "--json-schema", schemaPath,
    "--mode", "plan",
    "--sandbox",
  ]);
  assert.equal(invocation.args.includes("--disable-slash-commands"), false);
});

test("Antigravity accepts only its JSON SUCCESS envelope and extracts structured review output", () => {
  const adapter = getAdapter("antigravity");
  fs.writeFileSync(stdoutPath, JSON.stringify({ status: "SUCCESS", message: "completed bounded work" }));
  const dispatchOutcome = adapter.parseOutcome({ phase: "dispatch", exitCode: 0, stdoutPath, stderrPath, resultPath });
  assert.equal(dispatchOutcome.status, "succeeded");
  assert.deepEqual(dispatchOutcome.output, { status: "SUCCESS", message: "completed bounded work" });

  fs.writeFileSync(stdoutPath, JSON.stringify({ status: "SUCCESS", structured_output: { verdict: "pass", summary: "looks good", issues: [] } }));
  const reviewOutcome = adapter.parseOutcome({ phase: "primary_review", exitCode: 0, stdoutPath, stderrPath, resultPath });
  assert.equal(reviewOutcome.status, "succeeded");
  assert.deepEqual(reviewOutcome.output, { verdict: "pass", summary: "looks good", issues: [] });

  fs.writeFileSync(stdoutPath, "");
  assert.notEqual(adapter.parseOutcome({ phase: "primary_review", exitCode: 0, stdoutPath, stderrPath, resultPath }).status, "succeeded", "empty output stays fail-closed");
  for (const value of [
    "not JSON",
    JSON.stringify({ status: "FAILURE", message: "provider rejected" }),
    JSON.stringify({ status: "SUCCESS" }),
    JSON.stringify({ status: "SUCCESS", structured_output: "not an object" }),
  ]) {
    fs.writeFileSync(stdoutPath, value);
    assert.equal(adapter.parseOutcome({ phase: "primary_review", exitCode: 0, stdoutPath, stderrPath, resultPath }).status, "failed", value);
  }
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
      networkAccess: "enabled",
    });
    assert.equal(capability.supported, true, name);
  }
});

test("production dispatch and review integration contain no concrete executor-name branches", () => {
  const files = [
    path.join(__dirname, "../../../skills/relay-dispatch/scripts/dispatch.js"),
    path.join(__dirname, "../../../skills/relay-review/scripts/review-runner.js"),
    path.join(__dirname, "../../../skills/relay-dispatch/scripts/host.js"),
    path.join(__dirname, "../../../skills/relay-dispatch/scripts/run-store.js"),
  ];
  const branchPattern = /(?:===|!==|case)\s*["'](?:codex|claude|cursor|opencode|pi|antigravity|cline)["']/;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), branchPattern, file);
});

test("provider-unavailable signals are adapter-owned frozen literals consumed generically", () => {
  const opencode = getAdapter("opencode");
  assert.ok(opencode.providerUnavailableSignals.length > 0);
  assert.ok(Object.isFrozen(opencode.providerUnavailableSignals));
  assert.ok(opencode.providerUnavailableSignals.every((signal) => signal === signal.toLowerCase()));
  for (const name of listAdapters().filter((value) => value !== "opencode")) {
    assert.deepEqual(getAdapter(name).providerUnavailableSignals, [], name);
  }
  assert.deepEqual(contract.normalizeProviderUnavailableSignals(["Insufficient_Quota", "Quota Exceeded"]), ["insufficient_quota", "quota exceeded"]);
  assert.throws(() => contract.normalizeProviderUnavailableSignals(["bad\nvalue"]), /literal strings/);
  assert.throws(() => contract.normalizeProviderUnavailableSignals(["same", "same"]), /must not repeat/);
});

test("only Codex declares bounded stable-file and stream-marker completion signals", () => {
  assert.deepEqual(getAdapter("codex").completionSignal, { kind: "stable_result_file", stableMs: 250, streamMarkers: ["tokens used"] });
  assert.equal(Object.isFrozen(getAdapter("codex").completionSignal), true);
  assert.equal(Object.isFrozen(getAdapter("codex").completionSignal.streamMarkers), true);
  assert.deepEqual(contract.normalizeCompletionSignal({
    kind: "stable_result_file", stableMs: 100, streamMarkers: [" marker one ", "marker two"],
  }), { kind: "stable_result_file", stableMs: 100, streamMarkers: ["marker one", "marker two"] });
  assert.throws(() => contract.normalizeCompletionSignal({ kind: "stable_result_file", stableMs: 250, streamMarkers: [] }), /bounded stableMs and streamMarkers/);
  assert.throws(() => contract.normalizeCompletionSignal({ kind: "stable_result_file", stableMs: 250, streamMarkers: ["bad\nmarker"] }), /bounded literal strings/);
  assert.throws(() => contract.normalizeCompletionSignal({ kind: "stable_result_file", stableMs: 250, streamMarkers: ["same", "same"] }), /must not repeat/);
  assert.throws(() => contract.normalizeCompletionSignal({ kind: "stable_result_file", stableMs: 250, streamMarkers: Array(17).fill(0).map((_, index) => `marker-${index}`) }), /bounded stableMs and streamMarkers/);
  for (const name of listAdapters().filter((value) => value !== "codex")) {
    assert.equal(getAdapter(name).completionSignal, null, name);
  }
});

test("native adapter sources have no reverse imports into relay-review", () => {
  const adaptersDir = path.join(__dirname, "../../../skills/relay-dispatch/scripts/adapters");
  for (const file of fs.readdirSync(adaptersDir).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(adaptersDir, file), "utf8");
    assert.doesNotMatch(source, /require\([^\n]*relay-review/, file);
  }
});
