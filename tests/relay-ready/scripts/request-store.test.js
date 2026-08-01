"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const request = require("../../../skills/relay-ready/scripts/relay-request");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function fixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-ready-${label}-`)));
  const repo = path.join(root, "repo");
  const requests = path.join(root, "requests");
  fs.mkdirSync(repo);
  fs.mkdirSync(requests);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return { root, repo, requests: fs.realpathSync(requests) };
}

function requestRepoDir(base, repo) {
  const canonical = fs.realpathSync(repo);
  const name = path.basename(canonical).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const suffix = require("node:crypto").createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return path.join(base, `${name}-${suffix}`);
}

function contract(overrides = {}) {
  const handoff = {
    leaf_id: "leaf-01",
    title: "Implement the request",
    goal: "Ship one verified change",
    in_scope: ["Implementation"],
    out_of_scope: ["Deployment"],
    assumptions: [],
    escalation_conditions: ["The contract changes"],
    done_criteria_markdown: "- [ ] Tests pass",
    ...overrides.handoff,
  };
  return {
    source: { kind: "raw_text" },
    request_text: "Implement the requested change.",
    handoff,
    ...overrides,
    ...(overrides.handoff ? { handoff } : {}),
  };
}

function multiContract() {
  return {
    source: { kind: "raw_text" },
    request_text: "Implement two ordered changes.",
    handoffs: [
      { ...contract().handoff, leaf_id: "leaf-a", order: 1, title: "Foundation" },
      { ...contract().handoff, leaf_id: "leaf-b", order: 2, title: "Consumer", depends_on: ["leaf-a"] },
    ],
  };
}

function withBase(base, callback) {
  const prior = process.env.RELAY_REQUESTS_BASE;
  process.env.RELAY_REQUESTS_BASE = base;
  try { return callback(); }
  finally {
    if (prior === undefined) delete process.env.RELAY_REQUESTS_BASE;
    else process.env.RELAY_REQUESTS_BASE = prior;
  }
}

function runChild({ repo, requests, contractPath, requestId }) {
  const modulePath = path.resolve(__dirname, "../../../skills/relay-ready/scripts/relay-request.js");
  const source = [
    "const fs=require('fs');",
    `const api=require(${JSON.stringify(modulePath)});`,
    "const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));",
    "const result=api.persistRequestContract(process.argv[2],value,{requestId:process.argv[3]});",
    "process.stdout.write(JSON.stringify(result));",
  ].join("");
  const child = spawn(process.execPath, ["-e", source, contractPath, repo, requestId], {
    env: { ...process.env, RELAY_REQUESTS_BASE: requests },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("publishes one immutable single-leaf bundle with a last completion marker", () => {
  const value = fixture("single");
  const result = withBase(value.requests, () => request.persistRequestContract(value.repo, contract()));
  assert.match(result.requestId, /^req-\d{17}-[0-9a-f]{16}$/);
  assert.equal(request.readRequestArtifact(result.requestPath).data.state, "relay_ready");
  assert.equal(fs.readFileSync(result.rawRequestPath, "utf8"), "Implement the requested change.\n");
  assert.equal(fs.readFileSync(result.doneCriteriaPath, "utf8"), "- [ ] Tests pass\n");
  assert.equal(fs.existsSync(path.join(result.requestDir, "events.jsonl")), false);
  const marker = JSON.parse(fs.readFileSync(path.join(result.requestDir, "bundle-complete.json"), "utf8"));
  assert.equal(marker.request_id, result.requestId);
  assert.match(marker.bundle_sha256, /^[0-9a-f]{64}$/);
});

test("reads the public request exactly once and returns that verified snapshot", () => {
  const value = fixture("single-verified-snapshot");
  const result = withBase(value.requests, () => request.persistRequestContract(value.repo, contract()));
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  const opened = new Map();
  let publicReads = 0;
  fs.openSync = function trackedOpen(file, ...args) {
    const descriptor = originalOpen.call(this, file, ...args);
    if (typeof file === "string") opened.set(descriptor, path.resolve(file));
    return descriptor;
  };
  fs.readFileSync = function trackedRead(file, ...args) {
    if (typeof file === "number" && opened.get(file) === result.requestPath) publicReads += 1;
    return originalRead.call(this, file, ...args);
  };
  try {
    const artifact = request.readRequestArtifact(result.requestPath);
    assert.equal(artifact.data.request_id, result.requestId);
    assert.equal(publicReads, 1);
  } finally {
    fs.openSync = originalOpen;
    fs.readFileSync = originalRead;
  }
});

test("publishes an ordered multi-leaf bundle without mutable intake state", () => {
  const value = fixture("multi");
  const result = withBase(value.requests, () => request.persistRequestContract(value.repo, multiContract()));
  assert.deepEqual(result.leafIds, ["leaf-a", "leaf-b"]);
  const artifact = request.readRequestArtifact(result.requestPath);
  assert.equal(artifact.data.state, "relay_ready");
  assert.equal(artifact.data.leaf_count, 2);
  assert.equal(fs.existsSync(path.join(result.requestDir, "events.jsonl")), false);
});

test("same explicit request id and bytes are idempotent; conflicting bytes fail", () => {
  const value = fixture("idempotent");
  const requestId = "req-explicit-01";
  const first = withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId }));
  const second = withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId }));
  assert.equal(second.requestPath, first.requestPath);
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract({
      handoff: { done_criteria_markdown: "- [ ] Different bytes" },
    }), { requestId })),
    /different immutable bundle/,
  );
});

test("two concurrent writers converge on the same completed bundle", async () => {
  const value = fixture("concurrent");
  const contractPath = path.join(value.root, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(contract()));
  const requestId = "req-concurrent-01";
  const results = await Promise.all([
    runChild({ ...value, contractPath, requestId }),
    runChild({ ...value, contractPath, requestId }),
  ]);
  assert.deepEqual(results.map((entry) => entry.status), [0, 0], results.map((entry) => entry.stderr).join("\n"));
  assert.equal(JSON.parse(results[0].stdout).requestPath, JSON.parse(results[1].stdout).requestPath);
  const marker = path.join(JSON.parse(results[0].stdout).requestDir, "bundle-complete.json");
  assert.equal(fs.existsSync(marker), true);
});

test("twenty concurrent writer pairs never observe a partial completion marker", async () => {
  const value = fixture("concurrent-marker-stress");
  const contractPath = path.join(value.root, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(contract()));
  const pairs = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const requestId = `req-concurrent-marker-${index}`;
    return Promise.all([
      runChild({ ...value, contractPath, requestId }),
      runChild({ ...value, contractPath, requestId }),
    ]);
  }));
  for (const [index, pair] of pairs.entries()) {
    assert.deepEqual(pair.map((entry) => entry.status), [0, 0], `pair ${index}: ${pair.map((entry) => entry.stderr).join("\n")}`);
    assert.doesNotMatch(pair.map((entry) => entry.stderr).join("\n"), /Unexpected end of JSON input/);
  }
});

test("two concurrent writers with conflicting bytes elect one immutable bundle", async () => {
  const value = fixture("concurrent-conflict");
  const firstPath = path.join(value.root, "first.json");
  const secondPath = path.join(value.root, "second.json");
  fs.writeFileSync(firstPath, JSON.stringify(contract()));
  fs.writeFileSync(secondPath, JSON.stringify(contract({ handoff: { done_criteria_markdown: "- [ ] Other" } })));
  const requestId = "req-concurrent-conflict";
  const results = await Promise.all([
    runChild({ ...value, contractPath: firstPath, requestId }),
    runChild({ ...value, contractPath: secondPath, requestId }),
  ]);
  assert.deepEqual(results.map((entry) => entry.status).sort(), [0, 1]);
  assert.match(results.find((entry) => entry.status === 1).stderr, /different immutable bundle/);
});

test("a crash before completion leaves a fail-closed incomplete bundle", () => {
  const value = fixture("crash");
  const requestId = "req-crash-01";
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), {
      requestId,
      fault(stage) { if (stage === "after:raw-request.md") throw new Error("simulated crash"); },
    })),
    /incomplete request bundle.*simulated crash/,
  );
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId })),
    /without a completion marker/,
  );
});

test("a fault after marker fsync but before publication exposes no marker bytes", () => {
  const value = fixture("marker-before-publication");
  const requestId = "req-marker-before-publication";
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), {
      requestId,
      fault(stage) { if (stage === "after:bundle-complete.temp") throw new Error("marker publication fault"); },
    })),
    /incomplete request bundle.*marker publication fault/,
  );
  const requestDir = path.join(requestRepoDir(value.requests, value.repo), requestId);
  assert.equal(fs.existsSync(path.join(requestDir, "bundle-complete.json")), false);
  assert.deepEqual(fs.readdirSync(requestDir).filter((name) => name.includes("bundle-complete")), []);
  assert.throws(
    () => request.readRequestArtifact(path.join(path.dirname(requestDir), `${requestId}.md`)),
    /without a completion marker/,
  );
});

test("a malformed published completion marker fails closed immediately", () => {
  const value = fixture("malformed-marker");
  const requestId = "req-malformed-marker";
  const requestsDir = requestRepoDir(value.requests, value.repo);
  const requestDir = path.join(requestsDir, requestId);
  fs.mkdirSync(requestsDir);
  fs.mkdirSync(requestDir);
  fs.writeFileSync(path.join(requestDir, "bundle-complete.json"), "{\n");
  const started = Date.now();
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId })),
    /completion marker is malformed/,
  );
  assert.ok(Date.now() - started < 500, "malformed marker must fail without waiting for timeout");
});

test("the public request artifact is unreadable until its matching completion marker verifies the whole bundle", () => {
  const value = fixture("public-before-marker");
  const requestId = "req-public-before-marker";
  let requestPath;
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), {
      requestId,
      fault(stage) { if (stage === "after:../request.md") throw new Error("simulated crash"); },
    })),
    /incomplete request bundle.*simulated crash/,
  );
  requestPath = path.join(requestRepoDir(value.requests, value.repo), `${requestId}.md`);
  assert.throws(() => request.readRequestArtifact(requestPath), /without a completion marker/);

  const completed = withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId: "req-marker-integrity" }));
  const markerPath = path.join(completed.requestDir, "bundle-complete.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  delete marker.files["raw-request.md"];
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  assert.throws(() => request.readRequestArtifact(completed.requestPath), /incomplete or invalid inventory|digest does not match/);
});

test("request and leaf identifiers reject path traversal", () => {
  const value = fixture("ids");
  for (const requestId of ["../escape", "a/b", ".."] ) {
    assert.throws(
      () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId })),
      /safe path-independent identifier/,
    );
  }
  for (const leafId of ["../escape", "a/b", ".."] ) {
    assert.throws(
      () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract({ handoff: { leaf_id: leafId } }))),
      /safe path-independent identifier/,
    );
  }
});

test("rejects a symlinked requests base, repo directory, or request directory", () => {
  const value = fixture("symlink-dirs");
  const target = path.join(value.root, "target");
  fs.mkdirSync(target);
  const baseLink = path.join(value.root, "requests-link");
  fs.symlinkSync(target, baseLink);
  assert.throws(
    () => withBase(baseLink, () => request.persistRequestContract(value.repo, contract())),
    /trusted request directory/,
  );

  const ancestorTarget = path.join(value.root, "ancestor-target");
  const ancestorLink = path.join(value.root, "ancestor-link");
  fs.mkdirSync(path.join(ancestorTarget, "requests"), { recursive: true });
  fs.symlinkSync(ancestorTarget, ancestorLink);
  assert.throws(
    () => withBase(path.join(ancestorLink, "requests"), () => request.persistRequestContract(value.repo, contract())),
    /symlink ancestors/,
  );

  const repoDir = requestRepoDir(value.requests, value.repo);
  fs.symlinkSync(target, repoDir);
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract())),
    /trusted request directory/,
  );

  fs.unlinkSync(repoDir); fs.mkdirSync(repoDir);
  fs.symlinkSync(target, path.join(repoDir, "req-link-01"));
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId: "req-link-01" })),
    /untrusted/,
  );
});

test("completed bundles reject symlink and FIFO artifact replacement", () => {
  const value = fixture("special");
  const requestId = "req-special-01";
  const result = withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId }));
  const original = fs.readFileSync(result.doneCriteriaPath);
  const target = path.join(value.root, "criteria-target.md");
  fs.writeFileSync(target, original);
  fs.unlinkSync(result.doneCriteriaPath);
  fs.symlinkSync(target, result.doneCriteriaPath);
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId })),
    /symlink|ELOOP/,
  );
  fs.unlinkSync(result.doneCriteriaPath);
  execFileSync("mkfifo", [result.doneCriteriaPath]);
  assert.throws(
    () => withBase(value.requests, () => request.persistRequestContract(value.repo, contract(), { requestId })),
    /regular file/,
  );
});

test("persist-request CLI validates and publishes the final contract only", () => {
  const value = fixture("cli");
  const contractPath = path.join(value.root, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(contract()));
  const script = path.resolve(__dirname, "../../../skills/relay-ready/scripts/persist-request.js");
  const output = execFileSync(process.execPath, [script, "--repo", value.repo, "--contract-file", contractPath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, RELAY_REQUESTS_BASE: value.requests },
  });
  const result = JSON.parse(output);
  assert.equal(result.leafCount, 1);
  assert.equal(git(value.repo, ["status", "--porcelain"]), "");
});
