"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const host = require("../../../skills/relay-dispatch/scripts/host");
const store = require("../../../skills/relay-dispatch/scripts/run-store");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), cut = config.cut;
const die = () => process.kill(process.pid, "SIGKILL");
if (cut === "pending") { const real = host.retainReviewerCleanup; host.retainReviewerCleanup = (...args) => { const value = real(...args); die(); return value; }; }
if (cut === "credential") { const real = fs.writeFileSync; fs.writeFileSync = (...args) => { const value = real(...args); if (String(args[0]).includes("reviewer-credentials") && String(args[0]).endsWith("auth.json")) die(); return value; }; }
if (cut === "pre_spawn") { const real = host.sandboxInvocation.verifyRuntimeFiles; let first = true; host.sandboxInvocation.verifyRuntimeFiles = (...args) => { const value = real(...args); if (first) { first = false; die(); } return value; }; }
if (cut === "before_cleanup") { const real = host.retainReviewerCleanup; host.retainReviewerCleanup = (...args) => { const value = real(...args); return { ...value, complete: die }; }; }
const source = cut === "spawned" ? "setInterval(()=>{},1000)" : "process.stdout.write(JSON.stringify({ok:true}))";
if (cut === "spawned") { const killer = spawn(process.execPath, ["-e", `setTimeout(()=>process.kill(${process.pid},'SIGKILL'),500)`], { detached: true, stdio: "ignore" }); killer.unref(); }
store.invokeIndependentReviewer({ runDir: config.runDir, request: config.request, timeoutMs: 5_000,
  credentialRequest: config.credentials, buildInvocation: ({ cwd }) => ({ command: process.execPath, args: ["-e", source], cwd,
    runtimeDependencies: { executableParent: 1, interpreterParent: null }, networkAccess: "disabled" }),
  parseOutcome: ({ exitCode, stdoutPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed", output: JSON.parse(fs.readFileSync(stdoutPath, "utf8")) }) });
