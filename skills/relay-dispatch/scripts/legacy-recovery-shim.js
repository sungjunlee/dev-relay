"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const generation = require("./runtime-generation");

const COMMON_VALUE_FLAGS = ["--repo", "--run-id", "--manifest", "--reason"];
const COMMON_BOOLEAN_FLAGS = ["--dry-run", "--json", "--help", "-h"];

const COMMANDS = Object.freeze({
  "reconcile-run": {
    valueFlags: ["--repo", "--run-id", "--test-result-file"],
    booleanFlags: COMMON_BOOLEAN_FLAGS,
    defaultReason: "legacy reconcile-run compatibility shim",
    verificationFlag: "--test-result-file",
  },
  "recover-commit": {
    valueFlags: [
      ...COMMON_VALUE_FLAGS,
      "--pr-title", "--pr-body-file", "--test-command", "--test-result-file", "--test-exit-code",
    ],
    booleanFlags: ["--replace-placeholder-evidence", ...COMMON_BOOLEAN_FLAGS],
    retiredFlags: ["--pr-title", "--pr-body-file", "--test-command", "--test-exit-code", "--replace-placeholder-evidence"],
    verificationFlag: "--test-result-file",
    requireReason: true,
  },
  "recover-state": {
    valueFlags: [...COMMON_VALUE_FLAGS, "--to"],
    booleanFlags: [
      "--force", "--allow-same-head", "--require-pr-body-change", "--require-checks-green",
      ...COMMON_BOOLEAN_FLAGS,
    ],
    retiredFlags: [
      "--to", "--force", "--allow-same-head", "--require-pr-body-change", "--require-checks-green",
    ],
    requireReason: true,
  },
  "rebrand-evidence": {
    valueFlags: COMMON_VALUE_FLAGS,
    booleanFlags: ["--rebase-onto-base", ...COMMON_BOOLEAN_FLAGS],
    retiredFlags: ["--rebase-onto-base"],
    requireReason: true,
  },
  "publish-run": {
    valueFlags: ["--repo", "--run-id", "--manifest", "--branch"],
    booleanFlags: COMMON_BOOLEAN_FLAGS,
    retiredFlags: ["--branch"],
    defaultReason: "legacy publish-run compatibility shim",
  },
});

function cliOptions(spec) {
  const reservedFlags = [...new Set([...spec.valueFlags, ...spec.booleanFlags])];
  return {
    reservedFlags,
    booleanFlags: spec.booleanFlags,
    verbatimValueFlags: spec.valueFlags,
  };
}

function parseCli(argv, options) {
  const known = new Set(options.reservedFlags), bool = new Set(options.booleanFlags), verbatim = new Set(options.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0];
  argv.forEach((token, index) => { const flag = name(token); const value = argv[index + 1]; if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && value !== undefined) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const variants = (flag) => Array.isArray(flag) ? flag : [flag]; return { options, hasFlag: (flags) => variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flags, fallback) => { for (const flag of variants(flags)) for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (value === undefined) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
}

function usage(commandName) {
  return [
    `Usage: ${commandName}.js (--repo <path> --run-id <id> | --manifest <path>) [--dry-run] [--json]`,
    "",
    "Deprecated compatibility shim. It delegates to relay-recover inspect/recover.",
    "Use relay-recover.js directly for typed actions and idempotent recovery.",
  ].join("\n");
}

function assertSupportedFlags(cli, spec) {
  const retired = (spec.retiredFlags || []).filter((flag) => cli.hasFlag(flag));
  if (retired.length > 0) {
    throw new Error(
      `${retired.join(", ")} is not supported by the vNext compatibility shim; ` +
      "run relay-recover inspect and follow its typed recommended action",
    );
  }
}

function registeredArg(cli, flag) {
  return cli.options.reservedFlags.includes(flag) ? cli.getArg(flag) : undefined;
}

function canonicalLocator(cli) {
  const manifest = registeredArg(cli, "--manifest");
  const repo = registeredArg(cli, "--repo");
  const runId = registeredArg(cli, "--run-id");
  if (manifest) {
    if (repo || runId) throw new Error("--manifest is mutually exclusive with --repo/--run-id");
    const resolved = path.resolve(manifest);
    if (path.extname(resolved) !== ".md") throw new Error("--manifest must name a legacy .md manifest");
    return ["--run-dir", path.join(path.dirname(resolved), path.basename(resolved, ".md"))];
  }
  if (!runId) throw new Error("--run-id is required with --repo");
  return ["--repo", repo || ".", "--run-id", runId];
}

function recoveryReason(commandName, cli, spec) {
  const reason = String(registeredArg(cli, "--reason") || spec.defaultReason || "").trim();
  if (spec.requireReason && !reason) throw new Error("--reason is required");
  return reason;
}

function secureManifest(filePath) {
  const resolved = path.resolve(filePath), fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error("legacy manifest must be a bounded regular file");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error("legacy manifest changed while being observed");
    return { path: resolved, bytes };
  } finally { fs.closeSync(fd); }
}

function observationRepository(cli) {
  let candidate = registeredArg(cli, "--repo");
  let artifact = null;
  if (!candidate) {
    artifact = secureManifest(registeredArg(cli, "--manifest"));
    candidate = /^\s{2}repo_root:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(artifact.bytes.toString("utf8"))?.[1];
    if (!candidate) throw new Error("legacy manifest has no canonical repo_root for rollout observation");
  }
  const checkout = fs.realpathSync(path.resolve(candidate));
  const root = fs.realpathSync(execFileSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  let remote;
  try { remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { remote = `local/${path.basename(root)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return { identity: { checkoutRoot: root, remote: github ? `${github[1]}/${github[2]}` : remote }, artifact };
}

function translateLegacyRecovery(commandName, argv, { observe = true } = {}) {
  const spec = COMMANDS[commandName];
  if (!spec) throw new Error(`unknown legacy recovery command: ${commandName}`);
  const options = cliOptions(spec);
  const cli = parseCli(argv, options);
  if (cli.hasFlag(["--help", "-h"])) return { help: true, argv: [] };
  assertSupportedFlags(cli, spec);

  const dryRun = cli.hasFlag("--dry-run");
  const canonicalArgv = [dryRun ? "inspect" : "recover", ...canonicalLocator(cli)];
  if (!dryRun) {
    canonicalArgv.push("--reason", recoveryReason(commandName, cli, spec));
    const verificationFile = spec.verificationFlag && registeredArg(cli, spec.verificationFlag);
    if (verificationFile) canonicalArgv.push("--verification-file", verificationFile);
  }
  if (cli.hasFlag("--json")) canonicalArgv.push("--json");
  if (observe) {
    const observedAt = new Date().toISOString(), observation = observationRepository(cli), store = generation.initializeStore(observation.identity);
    if (observation.artifact) generation.recordLegacyArtifactRead({ store, surface: commandName, artifactName: path.basename(observation.artifact.path), artifactSha256: crypto.createHash("sha256").update(observation.artifact.bytes).digest("hex"), observedAt });
    generation.recordLegacySurfaceInvocation({ store, command: commandName, mode: dryRun ? "inspect" : "recover", observedAt });
  }
  return { help: false, argv: canonicalArgv };
}

module.exports = {
  COMMANDS,
  translateLegacyRecovery,
  usage,
};
