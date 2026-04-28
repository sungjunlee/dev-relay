const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { EVENTS } = require("./relay-events");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const OUT_OF_SCOPE_EVENT_SINKS = new Set([
  "skills/relay-intake/scripts/relay-request.js",
  "skills/relay-dispatch/scripts/worktree-runtime.js",
]);

function toRepoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function listProductionJsFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readInScopeSources() {
  return listProductionJsFiles(SKILLS_DIR)
    .map((filePath) => ({
      filePath,
      relativePath: toRepoRelative(filePath),
      source: fs.readFileSync(filePath, "utf-8"),
    }))
    .filter(({ relativePath }) => !OUT_OF_SCOPE_EVENT_SINKS.has(relativePath));
}

function stripEventsObjectLiteral(relativePath, source) {
  if (relativePath !== "skills/relay-dispatch/scripts/relay-events.js") {
    return source;
  }
  return source.replace(
    /const EVENTS = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    "const EVENTS = Object.freeze({});"
  );
}

function collectProducerEventKeys(sources) {
  const keys = new Set();

  for (const { source } of sources) {
    for (const match of source.matchAll(/\bevent\s*:\s*EVENTS\.([A-Z0-9_]+)/g)) {
      keys.add(match[1]);
    }
    for (const match of findAppendRecoveryEventCalls(source)) {
      const eventArg = splitTopLevelArguments(match.args)[2]?.trim() || "";
      const eventKey = eventArg.match(/^EVENTS\.([A-Z0-9_]+)$/);
      if (eventKey) {
        keys.add(eventKey[1]);
      }
    }
  }

  return keys;
}

function findAppendRecoveryEventCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\bappendRecoveryEvent\s*\(([\s\S]*?)\);/g)) {
    const prefix = source.slice(Math.max(0, match.index - "function ".length), match.index);
    if (prefix === "function ") {
      continue;
    }
    calls.push({ index: match.index, text: match[0], args: match[1] });
  }
  return calls;
}

function splitTopLevelArguments(argsText) {
  const args = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of argsText) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

function findBareEventLiterals(sources) {
  const matches = [];

  for (const { relativePath, source } of sources) {
    const scanSource = stripEventsObjectLiteral(relativePath, source);
    for (const match of scanSource.matchAll(/\bevent\s*:\s*["'][a-z_]+["']/g)) {
      matches.push(`${relativePath}:${lineNumberForIndex(scanSource, match.index)}: ${match[0]}`);
    }
    for (const match of findAppendRecoveryEventCalls(scanSource)) {
      const eventArg = splitTopLevelArguments(match.args)[2]?.trim() || "";
      if (!/^EVENTS\.[A-Z0-9_]+$/.test(eventArg)) {
        matches.push(`${relativePath}:${lineNumberForIndex(scanSource, match.index)}: appendRecoveryEvent event arg ${eventArg || "(missing)"}`);
      }
    }
  }

  return matches;
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

test("EVENTS is a frozen object map for current run journal event names", () => {
  assert.equal(Object.isFrozen(EVENTS), true);
  assert.equal(Object.values(EVENTS).every((eventName) => typeof eventName === "string"), true);
  assert.equal(Object.values(EVENTS).includes("manual_recovery"), false);
  assert.equal(Object.values(EVENTS).includes("manual_state_correction"), false);
  assert.equal(Object.values(EVENTS).includes("manual_state_override"), false);
  assert.equal(Object.values(EVENTS).includes("request_persisted"), false);
  assert.equal(Object.values(EVENTS).includes("register"), false);
});

test("EVENTS values match the event names emitted by producer call sites under skills", () => {
  const sources = readInScopeSources();
  const producerKeys = collectProducerEventKeys(sources);
  const unknownKeys = sorted([...producerKeys].filter((key) => !Object.hasOwn(EVENTS, key)));
  assert.deepEqual(unknownKeys, []);

  const emittedEventNames = sorted([...producerKeys].map((key) => EVENTS[key]));
  const enumEventNames = sorted(Object.values(EVENTS));
  assert.deepEqual(emittedEventNames, enumEventNames);
});

test("journal producer call sites do not use bare string event names", () => {
  const bareEventLiterals = findBareEventLiterals(readInScopeSources());
  assert.deepEqual(bareEventLiterals, []);
});
