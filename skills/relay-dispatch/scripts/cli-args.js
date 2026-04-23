const {
  findUnknownFlags,
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

module.exports = { findUnknownFlags, getArg, getPositionals, hasFlag, modeLabel };
