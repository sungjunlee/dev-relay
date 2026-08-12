"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

function relayTestFiles(root = TESTS_ROOT) {
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(absolute) : [absolute];
    });
  }
  return walk(root).filter((file) => file.endsWith(".test.js"));
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
    if (depth === 0) objects.push({ masked: masked.slice(start, end), source: source.slice(start, end) });
  }
  return { objects, indirect };
}

function hasForbiddenTopLevelOption(option) {
  let depth = 0;
  for (let index = 0; index < option.masked.length; index += 1) {
    const token = option.masked[index];
    if (token === "{") depth += 1;
    else if (token === "}") depth -= 1;
    else if (token === "[" && depth === 1) {
      const previous = option.masked.slice(0, index).trimEnd().at(-1);
      if (previous === "{" || previous === ",") return true;
    } else if (token === "." && depth === 1 && option.masked.startsWith("...", index)) {
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
  const calls = directCallOptions(executable);
  if (calls.indirect) violations.push(`${relative}: indirect three-argument test options are forbidden`);
  for (const optionObject of calls.objects) {
    if (hasForbiddenTopLevelOption(optionObject)) {
      violations.push(`${relative}: computed or spread test option is forbidden`);
      continue;
    }
    if (option("only").test(optionObject.source)) violations.push(`${relative}: only option is forbidden`);
    if (option("todo").test(optionObject.source)) violations.push(`${relative}: todo is forbidden`);
    const alternateSkipOption = /(?:\{|,)\s*skip\s*(?=[,}])/;
    if (alternateSkipOption.test(optionObject.source)) violations.push(`${relative}: shorthand skip is forbidden`);
    if (/(?:\{|,)\s*skip\s*:/.test(optionObject.source)) violations.push(`${relative}: skip option is forbidden`);
  }
  return { violations };
}

function assertDirectives(files) {
  const violations = [];
  for (const { relative, source } of files) {
    const result = inspectSource(relative, source);
    violations.push(...result.violations);
  }
  assert.deepEqual(violations, [], violations.join("\n"));
}

test("Relay tests contain no focused, todo, or skip directives", () => {
  assertDirectives(relayTestFiles().map((file) => ({
    relative: path.relative(TESTS_ROOT, file).split(path.sep).join("/"),
    source: fs.readFileSync(file, "utf8"),
  })));
});

test("directive guard rejects injected unauthorized directives", () => {
  const skipProperty = ["sk", "ip: true"].join("");
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
    "const hidden = { skip: true }; test('hidden', { ...hidden }, () => {});",
    "test('hidden', { ...{ skip: true } }, () => {});",
  ];
  for (const source of injections) {
    assert.throws(() => assertDirectives([{
      relative: "relay/scripts/injected.test.js",
      source,
    }]), /forbidden/);
  }
  assert.doesNotThrow(() => assertDirectives([{
    relative: "relay/scripts/comment-decoy.test.js",
    source: ["// test", ".skip('comment only', () => {});\n/* { ['sk' + 'ip']: true } */\n",
      "test('ordinary body', () => { const key = 'value'; const source = {}; const value = { [key]: true, ...source }; });",
      "test('nested option', { meta: { ...source } }, () => {});"].join(""),
  }, {
    relative: "relay/scripts/two-argument-callback.test.js",
    source: "function callback() {} test('callback identifier', callback);",
  }]));
});
