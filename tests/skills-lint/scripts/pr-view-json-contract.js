const fs = require("node:fs");
const path = require("node:path");

const CALL_NAMES = new Set(["gh", "execGh", "execFileSync"]);

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (type, value, startLine) => tokens.push({ type, value, line: startLine });

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      if (char === "\n") line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += (source.slice(index, stop).match(/\n/g) || []).length;
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      const startLine = line;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          break;
        }
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      const raw = source.slice(start, index);
      try {
        // The token is already constrained to a quoted JavaScript string literal.
        push("string", Function(`"use strict"; return (${raw});`)(), startLine);
      } catch {
        // A quote inside a regular-expression literal can look string-like to this
        // deliberately small lexer; it cannot be an argv string literal.
        push("nonliteral", "unparsed", startLine);
      }
      continue;
    }
    if (char === "`") {
      const startLine = line;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "`") { index += 1; break; }
        else { if (source[index] === "\n") line += 1; index += 1; }
      }
      push("nonliteral", "template", startLine);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      push("identifier", source.slice(start, index), line);
      continue;
    }
    push("punctuation", char, line);
    index += 1;
  }
  return tokens;
}

function matchingParen(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    if (tokens[index].value === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return tokens.length - 1;
}

function nextValueToken(tokens, index, end) {
  while (index < end && [",", "[", "]"].includes(tokens[index].value)) index += 1;
  return tokens[index];
}

function extractPrViewCallSites(source, file) {
  const tokens = tokenize(source);
  const callSites = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!CALL_NAMES.has(tokens[index].value) || tokens[index + 1].value !== "(") continue;
    const end = matchingParen(tokens, index + 1);
    const call = tokens.slice(index + 2, end);
    const prIndex = call.findIndex((token, offset) => (
      token.type === "string" && token.value === "pr" &&
      call.slice(offset + 1).find((candidate) => candidate.type === "string")?.value === "view"
    ));
    if (prIndex === -1) { index = end; continue; }
    const viewIndex = call.findIndex((token, offset) => offset > prIndex && token.type === "string" && token.value === "view");
    const jsonIndex = call.findIndex((token, offset) => offset > viewIndex && token.type === "string" && token.value === "--json");
    if (jsonIndex === -1) { index = end; continue; }
    const value = nextValueToken(call, jsonIndex + 1, call.length);
    callSites.push({
      file,
      line: tokens[index].line,
      fields: value?.type === "string" ? value.value : null,
      valueDescription: value ? `${value.type} ${JSON.stringify(value.value)}` : "missing value",
    });
    index = end;
  }
  return callSites;
}

function walkJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

function extractPrViewCallSitesFromDirectory(directory) {
  return walkJavaScriptFiles(directory).sort().flatMap((file) => (
    extractPrViewCallSites(fs.readFileSync(file, "utf-8"), file)
  ));
}

function comparePrViewCallSites(callSites, registry, fixturePath) {
  const accepted = new Set(Object.keys(registry));
  return callSites.flatMap((callSite) => {
    const location = `${callSite.file}:${callSite.line}`;
    if (callSite.fields === null) {
      return [`${location} has a non-literal gh pr view --json value (${callSite.valueDescription}); fixture: ${fixturePath}`];
    }
    if (!accepted.has(callSite.fields)) {
      return [`${location} uses unsupported gh pr view --json fields ${JSON.stringify(callSite.fields)}; fixture: ${fixturePath}`];
    }
    return [];
  });
}

module.exports = {
  comparePrViewCallSites,
  extractPrViewCallSites,
  extractPrViewCallSitesFromDirectory,
};
