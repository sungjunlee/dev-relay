"use strict";

const { readArg } = require("../cli-schema");

const flag = process.env.CLI_SCHEMA_TEST_FLAG;

if (!flag) {
  throw new Error("CLI_SCHEMA_TEST_FLAG is required");
}

const commandName = process.env.CLI_SCHEMA_TEST_COMMAND || undefined;
const fallback = Object.prototype.hasOwnProperty.call(process.env, "CLI_SCHEMA_TEST_FALLBACK")
  ? process.env.CLI_SCHEMA_TEST_FALLBACK
  : undefined;

try {
  const value = readArg(
    process.argv.slice(2),
    flag,
    fallback,
    commandName ? { commandName } : {}
  );
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error && error.name ? error.name : "Error",
    message: error && error.message ? error.message : String(error),
  }));
}
