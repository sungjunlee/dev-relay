const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const { filesystemIsolationDiagnostic } = require("../../../skills/relay-dispatch/scripts/adapter-contract");

test("flat adapter registry retains all seven executor names", () => {
  assert.deepEqual(listAdapters(), ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"]);
});

test("filesystem-isolation diagnostics are static, visible, and nonblocking", () => {
  const opencode = getAdapter("opencode").capabilities({ phase: "dispatch", request: { sandbox: "read-only", networkAccess: "disabled" } });
  assert.equal(opencode.supported, true);
  assert.equal(opencode.warnings.length > 0, true);
  assert.deepEqual(filesystemIsolationDiagnostic(getAdapter("opencode"), "dispatch", { sandbox: "read-only", networkAccess: "enabled" }), {
    requested: "unavailable", effective: "none", diagnostic: "opencode has no native filesystem sandbox; continuing directly on the trusted local host.",
  });
  const cursor = getAdapter("cursor").capabilities({ phase: "dispatch", request: { sandbox: "read-only", networkAccess: "disabled" } });
  assert.equal(cursor.supported, true);
  assert.deepEqual(filesystemIsolationDiagnostic(getAdapter("cursor"), "dispatch", { sandbox: "read-only", networkAccess: "enabled" }), {
    requested: "enabled", effective: "native", diagnostic: null,
  });
});
