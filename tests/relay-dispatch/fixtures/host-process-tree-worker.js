"use strict";

const { spawn } = require("child_process");
const fs = require("fs");

const [pidPath, termMode = "ignore"] = process.argv.slice(2);
if (!pidPath) process.exit(2);

const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: "ignore",
});
if (termMode === "ignore") process.on("SIGTERM", () => {});
fs.writeFileSync(pidPath, `${JSON.stringify({ parent: process.pid, descendant: descendant.pid })}\n`, "utf8");
if (termMode === "normal-exit") {
  setTimeout(() => process.exit(0), 25);
}
setInterval(() => {}, 1000);
