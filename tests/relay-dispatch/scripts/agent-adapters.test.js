const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ADAPTER_PHASES, getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");

const NAMES = ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"];

test("flat registry exposes seven dispatch adapters and only closed runtime phases", () => {
  assert.deepEqual(listAdapters(), NAMES);
  assert.deepEqual(Object.values(ADAPTER_PHASES), ["dispatch", "primary_review"]);
  for (const name of NAMES) assert.equal(getAdapter(name).capabilities({ phase: ADAPTER_PHASES.DISPATCH }).supported, true);
});

test("primary review support is explicit and Cline remains dispatch-only", () => {
  for (const name of NAMES.filter((name) => name !== "cline")) {
    const adapter = getAdapter(name);
    assert.equal(adapter.capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported, true);
    assert.equal(adapter.metadata.reviewScript, undefined);
  }
  assert.equal(getAdapter("cline").capabilities({ phase: ADAPTER_PHASES.PRIMARY_REVIEW }).supported, false);
});

test("descriptors expose only the four runtime methods and immutable metadata", () => {
  for (const name of NAMES) {
    const adapter = getAdapter(name);
    assert.deepEqual(Object.entries(adapter).filter(([, value]) => typeof value === "function").map(([key]) => key).sort(), ["buildInvocation", "capabilities", "parseOutcome", "probe"]);
    assert.equal(Object.isFrozen(adapter.metadata), true);
  }
});

test("registry fails closed for unknown adapters and phases", () => {
  assert.throws(() => getAdapter("nonexistent"), /unknown adapter 'nonexistent'/);
  assert.equal(getAdapter("codex").capabilities({ phase: "advisory_review" }).supported, false);
});

// The registry requires all seven descriptors literally and eagerly so the
// closed adapter surface cannot depend on lazy or dynamic loading.
test("registry statically loads every native adapter", () => {
  const registryPath = require.resolve("../../../skills/relay-dispatch/scripts/adapters");
  const nativePaths = NAMES.map((name) => require.resolve(`../../../skills/relay-dispatch/scripts/adapters/${name}`));
  delete require.cache[registryPath];
  nativePaths.forEach((modulePath) => delete require.cache[modulePath]);
  const registry = require(registryPath);
  for (const modulePath of nativePaths) {
    assert.equal(Boolean(require.cache[modulePath]), true, modulePath);
  }
  assert.deepEqual(registry.listAdapters().slice().sort(), NAMES.slice().sort());
});
