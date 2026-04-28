const {
  COMMAND_FLAGS,
  findUnknownFlags,
  getDefinition,
  getPositionals,
  hasFlag: schemaHasFlag,
  modeLabel,
  readArg,
} = require("./cli-schema");

function getArg(args, flag, fallback = undefined, options = {}) {
  return readArg(args, flag, fallback, options);
}

function hasFlag(args, flag, options = {}) {
  return schemaHasFlag(args, flag, options);
}

function normalizeFlagList(flag) {
  return Array.isArray(flag) ? flag : [flag];
}

function tokenFlagName(token) {
  const text = String(token);
  const separator = text.indexOf("=");
  return separator === -1 ? text : text.slice(0, separator);
}

function commandHasSchema(commandName) {
  return !commandName || Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, commandName);
}

function canUseSchema(flag, options = {}) {
  return commandHasSchema(options.commandName)
    && normalizeFlagList(flag).every((variant) => getDefinition(variant));
}

function isBooleanFlag(flag) {
  const definition = getDefinition(flag);
  if (definition) return definition.kind === "boolean";
  return flag === "--json" || flag === "--help" || flag === "-h";
}

function assertReservedFallbackFlag(flag, options = {}) {
  const reserved = new Set(options.reservedFlags || []);
  for (const variant of normalizeFlagList(flag)) {
    if (!reserved.has(variant)) {
      throw new Error(`Flag ${variant} is not registered for ${options.commandName || "CLI"}`);
    }
  }
}

// Compatibility path for CLIs that declare reservedFlags before they have a
// full cli-schema command entry. Schema-backed commands still use readArg/hasFlag.
function reservedValueIndices(args, reservedFlags = []) {
  const reserved = new Set(reservedFlags || []);
  const consumed = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const token = args[index];
    const flag = tokenFlagName(token);
    if (!reserved.has(flag) || isBooleanFlag(flag) || String(token).includes("=")) continue;
    const value = args[index + 1];
    if (value !== undefined && !String(value).startsWith("--")) {
      consumed.add(index + 1);
      index += 1;
    }
  }
  return consumed;
}

function reservedGetArg(args, flag, fallback = undefined, options = {}) {
  assertReservedFallbackFlag(flag, options);
  const consumed = reservedValueIndices(args, options.reservedFlags);
  for (const variant of normalizeFlagList(flag)) {
    for (let index = 0; index < args.length; index += 1) {
      if (consumed.has(index)) continue;
      const token = args[index];
      if (token === variant) {
        const value = args[index + 1];
        if (value === undefined || String(value).startsWith("--")) return fallback;
        return value;
      }
      if (String(token).startsWith(`${variant}=`)) {
        return String(token).slice(variant.length + 1);
      }
    }
  }
  return fallback;
}

function reservedHasFlag(args, flag, options = {}) {
  assertReservedFallbackFlag(flag, options);
  const consumed = reservedValueIndices(args, options.reservedFlags);
  for (const variant of normalizeFlagList(flag)) {
    if (args.some((token, index) => !consumed.has(index) && (
      token === variant || String(token).startsWith(`${variant}=`)
    ))) {
      return true;
    }
  }
  return false;
}

function findReservedUnknownFlags(args, reservedFlags = []) {
  const reserved = new Set(reservedFlags || []);
  const consumed = reservedValueIndices(args, reservedFlags);
  const unknown = [];
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) continue;
    const token = args[index];
    if (!String(token).startsWith("-")) continue;
    const flag = tokenFlagName(token);
    if (!reserved.has(flag)) unknown.push(token);
  }
  return unknown;
}

function findUnknownCliFlags(args, commandNameOrReservedFlags = null) {
  if (Array.isArray(commandNameOrReservedFlags)) {
    return findReservedUnknownFlags(args, commandNameOrReservedFlags);
  }
  return findUnknownFlags(args, commandNameOrReservedFlags);
}

function bindCliArgs(args, options = {}) {
  const boundOptions = { ...options };
  return {
    getArg(flag, fallback) {
      if (canUseSchema(flag, boundOptions)) {
        return getArg(args, flag, fallback, boundOptions);
      }
      return reservedGetArg(args, flag, fallback, boundOptions);
    },
    hasFlag(flag) {
      if (canUseSchema(flag, boundOptions)) {
        return hasFlag(args, flag, boundOptions);
      }
      return reservedHasFlag(args, flag, boundOptions);
    },
    options: boundOptions,
  };
}

module.exports = {
  bindCliArgs,
  findUnknownFlags: findUnknownCliFlags,
  getArg,
  getPositionals,
  hasFlag,
  modeLabel,
};
