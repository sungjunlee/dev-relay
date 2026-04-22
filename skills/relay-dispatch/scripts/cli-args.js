function getArg(args, flag, fallback = undefined, options = {}) {
  const reservedFlags = new Set(options.reservedFlags || []);
  const allowFlagLikeValue = options.allowFlagLikeValue === true;
  for (const variant of Array.isArray(flag) ? flag : [flag]) {
    const index = args.indexOf(variant);
    if (index === -1) continue;
    if (index + 1 >= args.length) return fallback;
    const value = args[index + 1];
    if ((!allowFlagLikeValue && value.startsWith("--")) || reservedFlags.has(value)) {
      return fallback;
    }
    return value;
  }
  return fallback;
}

const hasFlag = (args, flag) => (
  (Array.isArray(flag) ? flag : [flag]).some((variant) => args.includes(variant))
);

module.exports = { getArg, hasFlag };
