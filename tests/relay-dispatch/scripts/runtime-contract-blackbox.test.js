const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = require("../../../docs/contracts/relay-runtime-contracts.v1.json");

function topLevelTestNames(source) {
  const names = new Set();
  let braceDepth = 0;
  let lastTopLevelToken = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      if (braceDepth === 0) lastTopLevelToken = "string";
    } else if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
    } else if (current === "{") braceDepth += 1;
    else if (current === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) lastTopLevelToken = "}";
    }
    else if (braceDepth === 0 && source.startsWith("test", index)
      && source.slice(source.lastIndexOf("\n", index - 1) + 1, index).trim() === ""
      && (lastTopLevelToken === null || lastTopLevelToken === ";" || lastTopLevelToken === "}")
      && !/[A-Za-z0-9_$]/.test(source[index - 1] || "")
      && !/[A-Za-z0-9_$]/.test(source[index + 4] || "")) {
      const registration = /^test\s*\(\s*("(?:\\.|[^"\\])*")\s*,/.exec(source.slice(index));
      if (registration) names.add(JSON.parse(registration[1]));
    } else if (braceDepth === 0 && !/\s/.test(current)) lastTopLevelToken = current;
  }
  assert.equal(braceDepth, 0, "test source must have balanced top-level braces");
  return names;
}

function assertNamedTest(source, testName, label) {
  assert.equal(topLevelTestNames(source).has(testName), true,
    `${label} must resolve to a top-level direct named test registration`);
}

test("runtime contract manifest resolves every invariant to a current named Relay test", () => {
  assert.equal(contract.contract_version, 1);
  assert.equal(contract.invariants.length, 12);
  assert.equal(new Set(contract.invariants.map((entry) => entry.id)).size, 12);

  for (const invariant of contract.invariants) {
    assert.equal(invariant.status, "relay_gate", `${invariant.id} must use the current Relay gate`);
    assert.deepEqual(invariant.evidence || [], [], `${invariant.id} must not claim deleted legacy evidence`);
    assert.equal(typeof invariant.relay_test_path, "string", `${invariant.id} needs a named current Relay gate`);

    const separator = invariant.relay_test_path.indexOf("#");
    assert.ok(separator > 0, `${invariant.id} current Relay gate must name a test after #`);
    const relativeFile = invariant.relay_test_path.slice(0, separator);
    const testName = invariant.relay_test_path.slice(separator + 1);
    const absoluteFile = path.join(__dirname, "..", "..", "..", relativeFile);
    assert.equal(fs.existsSync(absoluteFile), true, `${invariant.id} missing ${relativeFile}`);
    assertNamedTest(fs.readFileSync(absoluteFile, "utf8"), testName, invariant.id);
  }
});

test("runtime contract anchor rejects a comment-only named test", () => {
  assert.throws(() => assertNamedTest('// test("RR-99 comment only", () => {});\n', "RR-99 comment only", "RR-99"),
    /top-level direct named test registration/);
  const templateOnly = ["const decoy = `", '\ntest("RR-99 template only", () => {});', "`;"].join("");
  assert.throws(() => assertNamedTest(templateOnly, "RR-99 template only", "RR-99"),
    /top-level direct named test registration/);
  assert.throws(() => assertNamedTest('function hidden() { test("RR-99 nested", () => {}); }', "RR-99 nested", "RR-99"),
    /top-level direct named test registration/);
  assert.throws(() => assertNamedTest('if (false) { test("RR-99 dead", () => {}); }', "RR-99 dead", "RR-99"),
    /top-level direct named test registration/);
  assert.throws(() => assertNamedTest('if (false) test("RR-99 unbraced dead", () => {});', "RR-99 unbraced dead", "RR-99"),
    /top-level direct named test registration/);
  assert.throws(() => assertNamedTest('if (false)\ntest("RR-99 newline dead", () => {});', "RR-99 newline dead", "RR-99"),
    /top-level direct named test registration/);
  assert.throws(() => assertNamedTest('false &&\ntest("RR-99 conditional dead", () => {});', "RR-99 conditional dead", "RR-99"),
    /top-level direct named test registration/);
});
