const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");

test("flat adapter registry retains all seven executor names", () => {
  assert.deepEqual(listAdapters(), ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"]);
});

test("adapter capability warnings preserve executor containment semantics", () => {
  const opencode = getAdapter("opencode").capabilities({ phase: "dispatch", request: { sandbox: "read-only", networkAccess: "disabled" } });
  assert.equal(opencode.supported, true);
  assert.match(opencode.warnings.join("\n"), /not enforced/);
  const cursor = getAdapter("cursor").capabilities({ phase: "dispatch", request: { sandbox: "read-only", networkAccess: "disabled" } });
  assert.equal(cursor.supported, true);
  assert.match(cursor.warnings.join("\n"), /host enforces the filesystem boundary.*disables Cursor's nested sandbox/);
});
