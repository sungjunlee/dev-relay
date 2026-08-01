#!/usr/bin/env node

const path = require("path");
const { spawnSync } = require("child_process");

const CORE_SCRIPT = path.resolve(__dirname, "..", "..", "relay-dispatch", "scripts", "relay-config.js");
const result = spawnSync(process.execPath, [CORE_SCRIPT, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(`Error: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
