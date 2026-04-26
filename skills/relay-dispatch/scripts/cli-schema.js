"use strict";

class CliSchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliSchemaError";
    this.details = details;
  }
}

const MODE_PARSED = "parsed";
const MODE_VERBATIM = "verbatim";

const BOOLEAN = "boolean";
const VALUE = "value";

const FLAGS = [
  { flag: "--all", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--artifact-path", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied artifact path being reconciled; keep the literal argv token." },
  { flag: "--branch", aliases: ["-b"], kind: VALUE, mode: MODE_VERBATIM, valueName: "<name>", rationale: "Git branch names are operator-supplied and may legally begin with --." },
  { flag: "--by-acting-reviewer", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--by-actor", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--by-role", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--contract-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied artifact path; keep the literal argv token." },
  { flag: "--copy", kind: VALUE, mode: MODE_VERBATIM, valueName: "<file,...>", rationale: "Operator-supplied file list; keep the literal argv token." },
  { flag: "--diff-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied fixture path; keep the literal argv token." },
  { flag: "--done-criteria-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied anchor path; keep the literal argv token." },
  { flag: "--dry-run", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--executor", aliases: ["-e"], kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Closed selector; flag-like following tokens should mean the value is missing." },
  { flag: "--force", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--force-finalize-nonready", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--head-sha", kind: VALUE, mode: MODE_PARSED, valueName: "<sha>", rationale: "Structured SHA field; flag-like following tokens should mean the value is missing." },
  { flag: "--help", aliases: ["-h"], kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--issue", kind: VALUE, mode: MODE_PARSED, valueName: "<N>", rationale: "Numeric selector; flag-like following tokens should mean the value is missing." },
  { flag: "--json", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--last-reviewed-sha", kind: VALUE, mode: MODE_PARSED, valueName: "<sha>", rationale: "Structured SHA field; flag-like following tokens should mean the value is missing." },
  { flag: "--leaf-id", kind: VALUE, mode: MODE_PARSED, valueName: "<id>", rationale: "Structured relay-intake identifier; flag-like following tokens should mean the value is missing." },
  { flag: "--manifest", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied manifest path; keep the literal argv token." },
  { flag: "--max-rounds", kind: VALUE, mode: MODE_PARSED, valueName: "<n>", rationale: "Numeric policy field; flag-like following tokens should mean the value is missing." },
  { flag: "--merge-method", kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Closed merge selector; flag-like following tokens should mean the value is missing." },
  { flag: "--model", aliases: ["-m"], kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Model selector; flag-like following tokens should mean the value is missing." },
  { flag: "--model-hints", kind: VALUE, mode: MODE_PARSED, valueName: "<spec>", rationale: "Structured phase=model spec; flag-like following tokens should mean the value is missing." },
  { flag: "--network-access", kind: VALUE, mode: MODE_PARSED, valueName: "<mode>", allowedValues: ["disabled", "enabled"], rationale: "Closed executor network selector; flag-like following tokens should mean the value is missing." },
  { flag: "--next-action", kind: VALUE, mode: MODE_VERBATIM, valueName: "<name>", rationale: "Operator-supplied manifest text; keep the literal argv token." },
  { flag: "--no-cleanup", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--no-comment", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--no-issue-close", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--older-than", kind: VALUE, mode: MODE_PARSED, valueName: "<hours>", rationale: "Numeric threshold; flag-like following tokens should mean the value is missing." },
  { flag: "--out-dir", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied output directory path; keep the literal argv token." },
  { flag: "--pin", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--planner", kind: VALUE, mode: MODE_PARSED, valueName: "<name>", allowedValues: ["codex", "claude"], rationale: "Planner adapter selector; flag-like following tokens should mean the value is missing." },
  { flag: "--post-comment", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--pr", kind: VALUE, mode: MODE_PARSED, valueName: "<number>", rationale: "Numeric PR selector; flag-like following tokens should mean the value is missing." },
  { flag: "--pr-body-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied PR body path; keep the literal argv token." },
  { flag: "--pr-number", kind: VALUE, mode: MODE_PARSED, valueName: "<n>", rationale: "Numeric manifest field; flag-like following tokens should mean the value is missing." },
  { flag: "--pr-title", kind: VALUE, mode: MODE_VERBATIM, valueName: "<text>", rationale: "Operator-supplied PR title; preserve free text and embedded flag-like tokens." },
  { flag: "--prepare-only", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--print", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--project-only", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--prompt", aliases: ["-p"], kind: VALUE, mode: MODE_VERBATIM, valueName: "<text>", rationale: "Operator-supplied prompt text; keep the literal argv token." },
  { flag: "--prompt-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied prompt path; keep the literal argv token." },
  { flag: "--reason", kind: VALUE, mode: MODE_VERBATIM, valueName: "<text>", rationale: "Audit reason text must be recorded exactly and must not be blank." },
  { flag: "--reasoning", kind: VALUE, mode: MODE_PARSED, valueName: "<level>",
    allowedValues: ["none", "minimal", "low", "medium", "high", "xhigh"],
    rationale: "Codex reasoning_effort override; closed selector over codex CLI levels." },
  { flag: "--register", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--repeated-issue-count", kind: VALUE, mode: MODE_PARSED, valueName: "<n>", rationale: "Numeric review field; flag-like following tokens should mean the value is missing." },
  { flag: "--repo", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied repository path; keep the literal argv token." },
  { flag: "--request-id", kind: VALUE, mode: MODE_PARSED, valueName: "<id>", rationale: "Structured relay-intake identifier; flag-like following tokens should mean the value is missing." },
  { flag: "--review-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied verdict path; keep the literal argv token." },
  { flag: "--reviewer", kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Reviewer adapter selector; flag-like following tokens should mean the value is missing." },
  { flag: "--reviewer-model", kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Reviewer model selector; flag-like following tokens should mean the value is missing." },
  { flag: "--reviewer-script", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied adapter path; keep the literal argv token." },
  { flag: "--rounds", kind: VALUE, mode: MODE_PARSED, valueName: "<n>", rationale: "Numeric review field; flag-like following tokens should mean the value is missing." },
  { flag: "--rubric-file", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied rubric path; keep the literal argv token." },
  { flag: "--rubric-grandfathered", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Retired presence flag; no value is consumed." },
  { flag: "--runs-dir", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied runs directory path; keep the literal argv token." },
  { flag: "--run-id", kind: VALUE, mode: MODE_PARSED, valueName: "<id>", rationale: "Structured relay run identifier; flag-like following tokens should mean the value is missing." },
  { flag: "--sandbox", kind: VALUE, mode: MODE_PARSED, valueName: "<mode>", rationale: "Closed sandbox selector; flag-like following tokens should mean the value is missing." },
  { flag: "--skip", kind: VALUE, mode: MODE_VERBATIM, valueName: "<reason>", rationale: "Audit skip reason must be recorded exactly and must not be blank." },
  { flag: "--skip-merge", kind: BOOLEAN, mode: MODE_PARSED, rationale: "Presence flag; no value is consumed." },
  { flag: "--skip-review", kind: VALUE, mode: MODE_VERBATIM, valueName: "<reason>", rationale: "Audit skip reason must be recorded exactly and must not be blank." },
  { flag: "--stale-hours", kind: VALUE, mode: MODE_PARSED, valueName: "<hours>", rationale: "Numeric threshold; flag-like following tokens should mean the value is missing." },
  { flag: "--state", kind: VALUE, mode: MODE_PARSED, valueName: "<state>", rationale: "Closed manifest state selector; flag-like following tokens should mean the value is missing." },
  { flag: "--test-command", kind: VALUE, mode: MODE_VERBATIM, valueName: "<cmd>", rationale: "Execution evidence must preserve the operator-supplied command token exactly." },
  { flag: "--timeout", kind: VALUE, mode: MODE_PARSED, valueName: "<seconds>", rationale: "Numeric timeout; flag-like following tokens should mean the value is missing." },
  { flag: "--title", aliases: ["-t"], kind: VALUE, mode: MODE_VERBATIM, valueName: "<text>", rationale: "Operator-supplied thread title; keep the literal argv token." },
  { flag: "--to", kind: VALUE, mode: MODE_PARSED, valueName: "<state>", rationale: "Closed recovery state selector; flag-like following tokens should mean the value is missing." },
  { flag: "--topic", kind: VALUE, mode: MODE_VERBATIM, valueName: "<name>", rationale: "Operator-supplied topic text used to derive a branch; keep the literal argv token." },
  { flag: "--verdict", kind: VALUE, mode: MODE_PARSED, valueName: "<name>", rationale: "Closed review verdict selector; flag-like following tokens should mean the value is missing." },
  { flag: "--window-days", kind: VALUE, mode: MODE_PARSED, valueName: "<N>", rationale: "Numeric scan window; flag-like following tokens should mean the value is missing." },
  { flag: "--worktree-path", kind: VALUE, mode: MODE_VERBATIM, valueName: "<path>", rationale: "Operator-supplied worktree path; keep the literal argv token." },
  { flag: "--writer-pr", kind: VALUE, mode: MODE_PARSED, valueName: "<number>", rationale: "Numeric PR selector for the writer PR; flag-like following tokens should mean the value is missing." },
];

const COMMAND_FLAGS = {
  "analyze-flip-flop-pattern": [
    "--print", "--post-comment", "--issue", "--window-days", "--runs-dir", "--help",
  ],
  "cleanup-worktrees": [
    "--repo", "--older-than", "--all", "--dry-run", "--json", "--help",
  ],
  "close-run": [
    "--repo", "--run-id", "--reason", "--dry-run", "--json", "--help",
  ],
  "create-worktree": [
    "--branch", "--title", "--topic", "--worktree-path", "--copy",
    "--pin", "--register", "--dry-run", "--json", "--help",
  ],
  dispatch: [
    "--branch", "--run-id", "--manifest", "--prompt", "--prompt-file", "--executor",
    "--model", "--model-hints", "--sandbox", "--network-access", "--copy", "--timeout", "--reasoning", "--rubric-file",
    "--test-command", "--rubric-grandfathered", "--request-id", "--leaf-id",
    "--done-criteria-file", "--register", "--no-cleanup", "--dry-run", "--json", "--help",
  ],
  "finalize-run": [
    "--repo", "--run-id", "--manifest", "--branch", "--pr", "--merge-method",
    "--skip-review", "--force-finalize-nonready", "--reason", "--skip-merge",
    "--no-issue-close", "--dry-run", "--json", "--help",
  ],
  "gate-check": [
    "--skip", "--dry-run", "--json", "--help",
  ],
  "invoke-reviewer-claude": [
    "--repo", "--prompt-file", "--model", "--json", "--help",
  ],
  "invoke-reviewer-codex": [
    "--repo", "--prompt-file", "--model", "--json", "--help",
  ],
  "plan-runner": [
    "--issue", "--planner", "--repo", "--runs-dir", "--out-dir", "--json", "--help",
  ],
  "persist-request": [
    "--repo", "--contract-file", "--json", "--help",
  ],
  "probe-executor-env": [
    "--executor", "--timeout", "--project-only", "--json", "--help",
  ],
  "recover-state": [
    "--repo", "--run-id", "--manifest", "--to", "--reason", "--force", "--dry-run", "--json", "--help",
  ],
  "recover-commit": [
    "--repo", "--run-id", "--manifest", "--reason", "--pr-title", "--pr-body-file",
    "--dry-run", "--json", "--help",
  ],
  "relay-reconcile-artifact": [
    "--repo", "--run-id", "--manifest", "--branch", "--pr",
    "--artifact-path", "--writer-pr", "--reason", "--skip-review",
    "--json", "--help",
  ],
  "reliability-report": [
    "--repo", "--stale-hours", "--json", "--by-actor", "--by-role", "--by-acting-reviewer", "--help",
  ],
  "review-runner": [
    "--repo", "--run-id", "--branch", "--pr", "--manifest", "--done-criteria-file",
    "--diff-file", "--review-file", "--reviewer", "--reviewer-script",
    "--reviewer-model", "--prepare-only", "--no-comment", "--json", "--help",
  ],
  "update-manifest-state": [
    "--manifest", "--repo", "--run-id", "--branch", "--state", "--next-action",
    "--pr-number", "--head-sha", "--rounds", "--verdict", "--last-reviewed-sha",
    "--max-rounds", "--repeated-issue-count", "--dry-run", "--json", "--help",
  ],
};

const flagByPrimary = new Map();
const aliasToPrimary = new Map();

for (const entry of FLAGS) {
  if (entry.mode !== MODE_PARSED && entry.mode !== MODE_VERBATIM) {
    throw new Error(`Invalid CLI flag mode for ${entry.flag}: ${entry.mode}`);
  }
  if (flagByPrimary.has(entry.flag)) {
    throw new Error(`Duplicate CLI flag registration: ${entry.flag}`);
  }
  flagByPrimary.set(entry.flag, Object.freeze({ ...entry, aliases: Object.freeze(entry.aliases || []) }));
  for (const token of [entry.flag, ...(entry.aliases || [])]) {
    if (aliasToPrimary.has(token)) {
      throw new Error(`Duplicate CLI flag token registration: ${token}`);
    }
    aliasToPrimary.set(token, entry.flag);
  }
}

for (const [commandName, flags] of Object.entries(COMMAND_FLAGS)) {
  for (const flag of flags) {
    if (!flagByPrimary.has(flag)) {
      throw new Error(`Command ${commandName} references unregistered flag ${flag}`);
    }
  }
}

function normalizeFlagList(flag) {
  return Array.isArray(flag) ? flag : [flag];
}

function primaryFor(flag) {
  return aliasToPrimary.get(flag) || null;
}

function getDefinition(flag) {
  const primary = primaryFor(flag);
  return primary ? flagByPrimary.get(primary) : null;
}

function assertRegistered(flag, commandName = null) {
  const primary = primaryFor(flag);
  if (!primary) {
    throw new CliSchemaError(`Unregistered CLI flag: ${flag}`, { flag, commandName });
  }
  if (commandName) {
    const allowed = commandAllowedFlags(commandName);
    if (!allowed.has(primary)) {
      throw new CliSchemaError(`Flag ${flag} is not registered for ${commandName}`, {
        flag,
        primary,
        commandName,
      });
    }
  }
  return primary;
}

function commandAllowedFlags(commandName) {
  if (!commandName) return new Set(flagByPrimary.keys());
  const flags = COMMAND_FLAGS[commandName];
  if (!flags) {
    throw new CliSchemaError(`Unknown CLI command schema: ${commandName}`, { commandName });
  }
  return new Set(flags);
}

function commandReservedTokens(commandName = null, extraReservedFlags = []) {
  const allowed = commandAllowedFlags(commandName);
  const reserved = new Set(extraReservedFlags || []);
  for (const primary of allowed) {
    const definition = flagByPrimary.get(primary);
    reserved.add(definition.flag);
    for (const alias of definition.aliases) reserved.add(alias);
  }
  return reserved;
}

function primaryFromToken(token) {
  const exact = primaryFor(token);
  if (exact) return { primary: exact, inline: false };
  const separator = String(token).indexOf("=");
  if (separator === -1) return { primary: null, inline: false };
  const primary = primaryFor(String(token).slice(0, separator));
  return { primary, inline: !!primary };
}

function consumesNextValue(args, index, definition, commandName = null, extraReservedFlags = []) {
  const token = args[index];
  if (definition.kind === BOOLEAN) return false;
  if (String(token).startsWith(`${definition.flag}=`)) return false;
  if (definition.aliases.some((alias) => String(token).startsWith(`${alias}=`))) return false;
  if (index + 1 >= args.length) return false;

  const value = args[index + 1];
  if (definition.mode === MODE_PARSED) {
    const reserved = commandReservedTokens(commandName, extraReservedFlags);
    if (String(value).startsWith("--") || reserved.has(value)) return false;
  }
  return true;
}

function consumedValueIndices(args, commandName = null, extraReservedFlags = []) {
  const allowed = commandAllowedFlags(commandName);
  const consumed = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const { primary } = primaryFromToken(args[index]);
    if (!primary || !allowed.has(primary)) continue;
    const definition = flagByPrimary.get(primary);
    if (consumesNextValue(args, index, definition, commandName, extraReservedFlags)) {
      consumed.add(index + 1);
      index += 1;
    }
  }
  return consumed;
}

function findOccurrence(args, flag, options = {}) {
  const consumed = consumedValueIndices(args, options.commandName, options.reservedFlags);
  for (const variant of normalizeFlagList(flag)) {
    assertRegistered(variant);
    for (let index = 0; index < args.length; index += 1) {
      if (consumed.has(index)) continue;
      const token = args[index];
      if (token === variant) {
        return { index, variant, inline: false, hasValue: index + 1 < args.length, value: args[index + 1] };
      }
      if (token.startsWith(`${variant}=`)) {
        return { index, variant, inline: true, hasValue: true, value: token.slice(variant.length + 1) };
      }
    }
  }
  return null;
}

function schemaDefault(definition, fallback) {
  return fallback !== undefined ? fallback : definition.default;
}

function validateValue(definition, value) {
  if (definition.mode === MODE_VERBATIM && String(value).trim() === "") {
    throw new CliSchemaError(`${definition.flag} requires a non-empty value`, {
      flag: definition.flag,
      mode: definition.mode,
      value,
    });
  }
  if (definition.allowedValues && !definition.allowedValues.includes(value)) {
    throw new CliSchemaError(`${definition.flag} must be one of: ${definition.allowedValues.join(", ")}`, {
      flag: definition.flag,
      mode: definition.mode,
      value,
    });
  }
  return value;
}

function readArg(args, flag, fallback = undefined, options = {}) {
  const variants = normalizeFlagList(flag);
  const primaries = variants.map((variant) => assertRegistered(variant, options.commandName));
  const firstPrimary = primaries[0];
  if (!primaries.every((primary) => primary === firstPrimary)) {
    throw new CliSchemaError(`Flag variants must point to the same schema entry: ${variants.join(", ")}`, {
      flag: variants,
      commandName: options.commandName,
    });
  }

  const definition = flagByPrimary.get(firstPrimary);
  if (definition.kind === BOOLEAN) {
    throw new CliSchemaError(`${definition.flag} is a presence flag and does not accept a value`, {
      flag: definition.flag,
      commandName: options.commandName,
    });
  }

  const occurrence = findOccurrence(args, flag, options);
  if (!occurrence) return schemaDefault(definition, fallback);
  if (!occurrence.hasValue) return schemaDefault(definition, fallback);

  const value = occurrence.value;
  if (definition.mode === MODE_PARSED) {
    const reserved = commandReservedTokens(options.commandName, options.reservedFlags);
    if (String(value).startsWith("--") || reserved.has(value)) {
      return schemaDefault(definition, fallback);
    }
  }

  return validateValue(definition, value);
}

function hasFlag(args, flag, options = {}) {
  const consumed = consumedValueIndices(args, options.commandName, options.reservedFlags);
  for (const variant of normalizeFlagList(flag)) {
    assertRegistered(variant, options.commandName);
    if (args.some((token, index) => !consumed.has(index) && (token === variant || token.startsWith(`${variant}=`)))) {
      return true;
    }
  }
  return false;
}

function createCliReader(commandName, args) {
  commandAllowedFlags(commandName);
  return {
    get(flag, fallback) {
      return readArg(args, flag, fallback, { commandName });
    },
    has(flag) {
      return hasFlag(args, flag, { commandName });
    },
    positionals() {
      return getPositionals(args, commandName);
    },
  };
}

function getPositionals(args, commandName = null) {
  const allowed = commandAllowedFlags(commandName);
  const consumed = consumedValueIndices(args, commandName);
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const token = args[index];
    const { primary, inline } = primaryFromToken(token);
    if (primary && allowed.has(primary)) {
      const definition = flagByPrimary.get(primary);
      if (!inline && consumesNextValue(args, index, definition, commandName)) {
        index += 1;
      }
      continue;
    }
    if (!String(token).startsWith("-")) positionals.push(token);
  }
  return positionals;
}

function findUnknownFlags(args, commandName = null) {
  const allowed = commandAllowedFlags(commandName);
  const consumed = consumedValueIndices(args, commandName);
  const unknown = [];
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const token = args[index];
    if (!String(token).startsWith("-")) continue;
    const { primary } = primaryFromToken(token);
    if (!primary || !allowed.has(primary)) unknown.push(token);
  }
  return unknown;
}

function getFlagMode(flag) {
  const definition = getDefinition(flag);
  if (!definition) {
    throw new CliSchemaError(`Unregistered CLI flag: ${flag}`, { flag });
  }
  return definition.mode;
}

function modeLabel(flag) {
  return `[${getFlagMode(flag)}]`;
}

function getFlagAuditRows() {
  return [...flagByPrimary.values()]
    .map((definition) => ({
      flag: [definition.flag, ...definition.aliases].join(", "),
      mode: definition.mode,
      rationale: definition.rationale,
    }))
    .sort((left, right) => left.flag.localeCompare(right.flag));
}

function formatFlagAuditMarkdown() {
  return [
    "| flag | mode | rationale |",
    "|---|---|---|",
    ...getFlagAuditRows().map((row) => `| \`${row.flag}\` | \`${row.mode}\` | ${row.rationale} |`),
  ].join("\n");
}

module.exports = {
  BOOLEAN,
  CliSchemaError,
  COMMAND_FLAGS,
  FLAGS,
  MODE_PARSED,
  MODE_VERBATIM,
  VALUE,
  createCliReader,
  findUnknownFlags,
  formatFlagAuditMarkdown,
  getDefinition,
  getFlagAuditRows,
  getFlagMode,
  getPositionals,
  hasFlag,
  modeLabel,
  readArg,
};
