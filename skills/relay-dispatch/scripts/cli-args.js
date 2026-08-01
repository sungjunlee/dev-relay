"use strict";

// This is intentionally a parser, not a command registry.  Every CLI owns
// its KNOWN_FLAGS and passes them in `reservedFlags`; this module only keeps
// the argv bookkeeping consistent (including values that look like flags).

const BOUND_GET_ARG = "getArg";
const BOUND_HAS_FLAG = "hasFlag";

function normalizeFlagList(flag) {
  return Array.isArray(flag) ? flag : [flag];
}

function tokenFlagName(token) {
  const text = String(token);
  const separator = text.indexOf("=");
  return separator === -1 ? text : text.slice(0, separator);
}

function requireKnownFlags(options = {}) {
  if (!Array.isArray(options.reservedFlags) || options.reservedFlags.length === 0) {
    throw new Error("CLI parser requires entrypoint-local reservedFlags");
  }
  if (!Array.isArray(options.booleanFlags)) {
    throw new Error("CLI parser requires entrypoint-local booleanFlags");
  }
  if (!Array.isArray(options.verbatimValueFlags)) {
    throw new Error("CLI parser requires entrypoint-local verbatimValueFlags");
  }
  const known = new Set(options.reservedFlags);
  for (const flag of [...options.booleanFlags, ...options.verbatimValueFlags]) {
    if (!known.has(flag)) {
      throw new Error(`CLI taxonomy references unknown flag: ${flag}`);
    }
  }
  for (const flag of options.booleanFlags) {
    if (options.verbatimValueFlags.includes(flag)) {
      throw new Error(`CLI flag cannot be both boolean and verbatim value: ${flag}`);
    }
  }
  return known;
}

function assertKnownFlag(flag, options = {}) {
  const known = requireKnownFlags(options);
  for (const variant of normalizeFlagList(flag)) {
    if (!known.has(variant)) {
      throw new Error(`Flag ${variant} is not registered for this CLI`);
    }
  }
}

function isBooleanFlag(flag, options = {}) {
  return new Set(options.booleanFlags || []).has(flag);
}

function isVerbatimFlag(flag, options = {}) {
  return new Set(options.verbatimValueFlags || []).has(flag);
}

function valueIndices(args, options = {}) {
  const known = requireKnownFlags(options);
  const consumed = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const token = String(args[index]);
    const flag = tokenFlagName(token);
    if (!known.has(flag) || isBooleanFlag(flag, options) || token.includes("=")) continue;
    const value = args[index + 1];
    if (value === undefined) continue;
    if (!isVerbatimFlag(flag, options) && (String(value).startsWith("--") || known.has(String(value)))) continue;
    consumed.add(index + 1);
    index += 1;
  }
  return consumed;
}

function readArg(args, flag, fallback = undefined, options = {}) {
  assertKnownFlag(flag, options);
  const known = requireKnownFlags(options);
  const consumed = valueIndices(args, options);
  for (const variant of normalizeFlagList(flag)) {
    if (isBooleanFlag(variant, options)) {
      throw new Error(`Flag ${variant} is a presence flag and does not accept a value`);
    }
    for (let index = 0; index < args.length; index += 1) {
      if (consumed.has(index)) continue;
      const token = String(args[index]);
      if (token === variant) {
        const value = args[index + 1];
        if (value === undefined) return fallback;
        if (!isVerbatimFlag(variant, options) && (String(value).startsWith("--") || known.has(String(value)))) return fallback;
        if (isVerbatimFlag(variant, options) && !String(value).trim()) {
          throw new Error(`${variant} requires a non-empty value`);
        }
        return value;
      }
      if (token.startsWith(`${variant}=`)) {
        const value = token.slice(variant.length + 1);
        if (!isVerbatimFlag(variant, options) && (value.startsWith("--") || known.has(value))) return fallback;
        if (isVerbatimFlag(variant, options) && !value.trim()) {
          throw new Error(`${variant} requires a non-empty value`);
        }
        return value;
      }
    }
  }
  return fallback;
}

function schemaHasFlag(args, flag, options = {}) {
  assertKnownFlag(flag, options);
  const consumed = valueIndices(args, options);
  return normalizeFlagList(flag).some((variant) => args.some((token, index) => {
    const text = String(token);
    return !consumed.has(index) && (text === variant || text.startsWith(`${variant}=`));
  }));
}

function getPositionals(args, options = {}) {
  const known = requireKnownFlags(options);
  const consumed = valueIndices(args, options);
  return args.filter((token, index) => {
    if (consumed.has(index)) return false;
    const text = String(token);
    return !text.startsWith("-") && !known.has(tokenFlagName(text));
  });
}

function findUnknownFlags(args, knownFlagsOrOptions) {
  const options = knownFlagsOrOptions;
  const known = requireKnownFlags(options);
  const consumed = valueIndices(args, options);
  return args.filter((token, index) => {
    if (consumed.has(index)) return false;
    const text = String(token);
    return text.startsWith("-") && !known.has(tokenFlagName(text));
  });
}

function modeLabel(flag, options = {}) {
  assertKnownFlag(flag, options);
  return isBooleanFlag(flag, options) ? "[boolean]" : "[value]";
}

function bindCliArgs(args, options = {}) {
  requireKnownFlags(options);
  const boundOptions = { ...options };
  return {
    [BOUND_GET_ARG](flag, fallback) {
      return readArg(args, flag, fallback, boundOptions);
    },
    [BOUND_HAS_FLAG](flag) {
      return schemaHasFlag(args, flag, boundOptions);
    },
    options: boundOptions,
  };
}

module.exports = {
  bindCliArgs,
  findUnknownFlags,
  getPositionals,
  modeLabel,
  readArg,
  schemaHasFlag,
};
