"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

// These are permanent environment boundaries: nine macOS sandbox canaries and
// two opt-in live executor checks. Every other Relay test must always run.
const ALLOWED_SKIPS = new Set([
  "relay-dispatch/scripts/adapter-live-canary.test.js :: two production phase cells pass only with explicit credentials and exact nonce evidence",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: provisioned authentication failure is failed, never skipped or not_run",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: dispatch cleanup-incomplete is settled before canary fixtures are removed",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: unsettleable dispatch cleanup preserves signed evidence and aborts the canary",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: a post-receipt timeout is cancelled and settled before canary fixture deletion",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: an invalid post-receipt terminal aborts with a typed cause and destroys no evidence",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: dispatch and review cells use phase-pristine fixtures",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: boundary mutation and stale or fallback nonce cannot produce a pass",
  "relay-dispatch/scripts/adapter-live-canary.test.js :: clean exit with a missing or wrong nonce artifact is output failure, not boundary mutation",
  "relay-dispatch/scripts/opencode-live.test.js :: opencode live canary is opt-in and uses explicit adapter/model selection",
  "relay-dispatch/scripts/pi-live.test.js :: pi live canary is opt-in and records explicit adapter/model capability",
]);

function relayTestFiles(root = TESTS_ROOT) {
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(absolute) : [absolute];
    });
  }
  return walk(root).filter((file) => file.endsWith(".test.js"));
}

function literalNameBefore(source, offset) {
  const prefix = source.slice(0, offset);
  const call = prefix.lastIndexOf("test(");
  if (call < 0) throw new Error("skip directive is not attached to a literal test call");
  const argument = prefix.slice(call + 5).trimStart();
  const match = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$]|\$(?!\{))*`)/.exec(argument);
  if (!match) throw new Error("skip directive test name must be a normalized literal");
  const quote = match[1][0];
  const body = match[1].slice(1, -1);
  return body.replace(new RegExp(`\\\\${quote}`, "g"), quote).replace(/\\\\n/g, "\n").replace(/\\\\\\\\/g, "\\");
}

function regexStartsAt(source, index) {
  const previous = source.slice(0, index).trimEnd().at(-1) || "";
  return !previous || "([{:;,=!&|?+-*%~".includes(previous);
}

function withoutComments(source) {
  let result = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (current === "\\") result += source[index += 1] || "";
      else if (current === quote) quote = null;
    } else if (current === "/" && next !== "/" && next !== "*" && regexStartsAt(source, index)) {
      let inClass = false;
      result += current;
      for (index += 1; index < source.length; index += 1) {
        result += source[index];
        if (source[index] === "\\") result += source[index += 1] || "";
        else if (source[index] === "[") inClass = true;
        else if (source[index] === "]") inClass = false;
        else if (source[index] === "/" && !inClass) break;
      }
    } else if (current === '"' || current === "'" || current === "`") {
      quote = current;
      result += current;
    } else if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
    } else if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
    } else result += current;
  }
  return result;
}

function stringMask(source) {
  const masked = [...source];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "/" && regexStartsAt(source, index)) {
      let inClass = false;
      masked[index] = " ";
      for (index += 1; index < source.length; index += 1) {
        masked[index] = source[index] === "\n" ? "\n" : " ";
        if (source[index] === "\\") {
          if (index + 1 < source.length) masked[index += 1] = " ";
        } else if (source[index] === "[") inClass = true;
        else if (source[index] === "]") inClass = false;
        else if (source[index] === "/" && !inClass) break;
      }
      continue;
    }
    const quote = source[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    masked[index] = " ";
    for (index += 1; index < source.length; index += 1) {
      if (source[index] === "\n") continue;
      masked[index] = " ";
      if (source[index] === "\\") {
        if (index + 1 < source.length) masked[index += 1] = " ";
      } else if (source[index] === quote) break;
    }
  }
  return masked.join("");
}

function directCallOptions(source) {
  const masked = stringMask(source);
  const objects = [];
  let indirect = false;
  for (const match of masked.matchAll(/\b(?:test|it|describe)\s*\(/g)) {
    const previous = masked.slice(0, match.index).trimEnd().at(-1) || "";
    if (previous === "." || /[A-Za-z0-9_$]/.test(previous)) continue;
    const open = match.index + match[0].lastIndexOf("(");
    let parentheses = 1, braces = 0, brackets = 0;
    const commas = [];
    for (let index = open + 1; index < masked.length; index += 1) {
      const token = masked[index];
      if (token === "(") parentheses += 1;
      else if (token === ")") parentheses -= 1;
      else if (token === "{") braces += 1;
      else if (token === "}") braces -= 1;
      else if (token === "[") brackets += 1;
      else if (token === "]") brackets -= 1;
      else if (token === "," && parentheses === 1 && braces === 0 && brackets === 0) commas.push(index);
      if (parentheses === 0) break;
    }
    if (commas.length === 0) continue;
    let start = commas[0] + 1;
    while (/\s/.test(masked[start] || "")) start += 1;
    if (masked[start] !== "{") {
      if (commas.length >= 2) indirect = true;
      continue;
    }
    let depth = 1, end = start + 1;
    for (; end < masked.length && depth > 0; end += 1) {
      if (masked[end] === "{") depth += 1;
      else if (masked[end] === "}") depth -= 1;
    }
    if (depth === 0) objects.push({ start, end, masked: masked.slice(start, end), source: source.slice(start, end) });
  }
  return { objects, indirect };
}

function hasTopLevelComputedProperty(option) {
  let depth = 0;
  for (let index = 0; index < option.masked.length; index += 1) {
    const token = option.masked[index];
    if (token === "{") depth += 1;
    else if (token === "}") depth -= 1;
    else if (token === "[" && depth === 1) {
      const previous = option.masked.slice(0, index).trimEnd().at(-1);
      if (previous === "{" || previous === ",") return true;
    }
  }
  return false;
}

function inspectSource(relative, source) {
  const executable = withoutComments(source);
  const maskedExecutable = stringMask(executable);
  const violations = [];
  const member = (name) => new RegExp(`\\b(?:test|it|describe)\\s*(?:\\.\\s*${name}|\\[\\s*(["'])${name}\\1\\s*\\])\\s*\\(`);
  const option = (name) => new RegExp(`(?:\\{|,)\\s*(?:${name}\\s*:|\\[\\s*(["'])${name}\\1\\s*\\]\\s*:|${name}\\s*(?=[,}]))`);
  if (member("only").test(executable)) violations.push(`${relative}: only registration is forbidden`);
  if (member("todo").test(executable)) violations.push(`${relative}: todo is forbidden`);
  if (member("skip").test(executable)) violations.push(`${relative}: skip registration is forbidden`);
  if (/\b(?:test|it|describe)\s*\[/.test(maskedExecutable)) {
    violations.push(`${relative}: computed test registration is forbidden`);
  }
  const skips = [];
  const calls = directCallOptions(executable);
  if (calls.indirect) violations.push(`${relative}: indirect three-argument test options are forbidden`);
  for (const optionObject of calls.objects) {
    if (hasTopLevelComputedProperty(optionObject)) {
      violations.push(`${relative}: computed test option is forbidden`);
      continue;
    }
    if (option("only").test(optionObject.source)) violations.push(`${relative}: only option is forbidden`);
    if (option("todo").test(optionObject.source)) violations.push(`${relative}: todo is forbidden`);
    const alternateSkipOption = /(?:\{|,)\s*skip\s*(?=[,}])/;
    if (alternateSkipOption.test(optionObject.source)) violations.push(`${relative}: shorthand skip is forbidden`);
    for (const match of optionObject.source.matchAll(/(?:\{|,)\s*skip\s*:/g)) {
      try { skips.push(`${relative} :: ${literalNameBefore(executable, optionObject.start + match.index)}`); }
      catch (error) { violations.push(`${relative}: ${error.message}`); }
    }
  }
  return { violations, skips };
}

function assertDirectives(files) {
  const violations = [];
  const skips = [];
  for (const { relative, source } of files) {
    const result = inspectSource(relative, source);
    violations.push(...result.violations);
    skips.push(...result.skips);
  }
  assert.deepEqual(violations, [], violations.join("\n"));
  assert.deepEqual(new Set(skips), ALLOWED_SKIPS, "skip directives must exactly match the permanent allowlist");
  assert.equal(skips.length, ALLOWED_SKIPS.size, "each allowed skip must occur exactly once");
}

test("Relay tests contain no focused/todo directives and exactly the allowed skips", () => {
  assertDirectives(relayTestFiles().map((file) => ({
    relative: path.relative(TESTS_ROOT, file).split(path.sep).join("/"),
    source: fs.readFileSync(file, "utf8"),
  })));
});

test("directive guard rejects injected unauthorized directives", () => {
  const skipProperty = ["sk", "ip: true"].join("");
  const allowed = [...ALLOWED_SKIPS].map((identity) => {
    const [relative, name] = identity.split(" :: ");
    return { relative, source: `test(${JSON.stringify(name)}, { ${skipProperty} }, () => {});` };
  });
  const injections = [
    ["test", ".only('focused', () => {});"].join(""),
    ["it", ".only('focused', () => {});"].join(""),
    ["describe", ".only('focused', () => {});"].join(""),
    ["test('focused', { on", "ly: true }, () => {});"].join(""),
    ["test", ".todo('unfinished');"].join(""),
    ["it", ".todo('unfinished');"].join(""),
    ["describe", ".todo('unfinished');"].join(""),
    ["test('later', { to", "do: true }, () => {});"].join(""),
    ["test", ".skip('hidden', () => {});"].join(""),
    ["it", ".skip('hidden', () => {});"].join(""),
    ["describe", ".skip('hidden', () => {});"].join(""),
    `test('hidden', { ${skipProperty} }, () => {});`,
    ["test", "['skip']('hidden', () => {});"].join(""),
    ["test('hidden', { ['sk", "ip']: true }, () => {});"].join(""),
    ["const skip = true; test('hidden', { sk", "ip }, () => {});"].join(""),
    ["test", "['only']('focused', () => {});"].join(""),
    ["test('focused', { ['on", "ly']: true }, () => {});"].join(""),
    ["const only = true; test('focused', { on", "ly }, () => {});"].join(""),
    ["test", "['todo']('unfinished');"].join(""),
    ["test('unfinished', { ['to", "do']: true }, () => {});"].join(""),
    ["const todo = true; test('unfinished', { to", "do }, () => {});"].join(""),
    ["test('hidden', { ['sk' + '", "ip']: true }, () => {});"].join(""),
    ["test('focused', { ['on' + '", "ly']: true }, () => {});"].join(""),
    ["test('unfinished', { ['to' + '", "do']: true }, () => {});"].join(""),
    "const key = 'skip'; test('hidden', { [key]: true }, () => {});",
    "test('hidden', { [`skip`]: true }, () => {});",
    ["const key = 'anything'; test", "[key]('hidden', () => {});"].join(""),
    ["test", "[`dynamic`]('hidden', () => {});"].join(""),
    ["test", "\n[key]('hidden', () => {});"].join(""),
    "const options = { timeout: 1 }; test('hidden', options, () => {});",
  ];
  for (const source of injections) {
    assert.throws(() => assertDirectives([...allowed, {
      relative: "relay/scripts/injected.test.js",
      source,
    }]), /forbidden|allowlist/);
  }
  assert.doesNotThrow(() => assertDirectives([...allowed, {
    relative: "relay/scripts/comment-decoy.test.js",
    source: ["// test", ".skip('comment only', () => {});\n/* { ['sk' + 'ip']: true } */\n",
      "test('ordinary body', () => { const key = 'value'; const value = { [key]: true }; });"].join(""),
  }, {
    relative: "relay/scripts/two-argument-callback.test.js",
    source: "function callback() {} test('callback identifier', callback);",
  }]));
});
