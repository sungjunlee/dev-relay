const { spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const ENABLED = process.env.OPENCODE_INTEGRATION === "1";
const MODEL = process.env.OPENCODE_MODEL || "opencode-go/deepseek-v4-pro";

function runOpencode(args, options = {}) {
  return spawnSync("opencode", args, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: options.timeout || 120000,
  });
}

test("opencode live smoke runs the configured model", { skip: ENABLED ? false : "set OPENCODE_INTEGRATION=1 to run live opencode smoke" }, () => {
  const version = runOpencode(["--version"], { timeout: 10000 });
  assert.equal(version.status, 0, version.stderr || version.error?.message);

  const provider = MODEL.split("/")[0];
  assert.ok(provider, "OPENCODE_MODEL must use provider/model format");

  const models = runOpencode(["models", provider], { timeout: 30000 });
  assert.equal(models.status, 0, models.stderr || models.error?.message);
  assert.match(models.stdout, new RegExp(`(^|\\n)${MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`));

  const result = runOpencode([
    "run",
    "-m",
    MODEL,
    "Do not edit files. Reply exactly OPENCODE_LIVE_OK and nothing else.",
  ]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /OPENCODE_LIVE_OK/);
});
