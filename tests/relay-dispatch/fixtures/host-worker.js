"use strict";

const fs = require("fs");

const [markerPath, delayMs = "10"] = process.argv.slice(2);
if (!markerPath) process.exit(2);
fs.appendFileSync(markerPath, `started:${process.pid}\n`, "utf8");
setTimeout(() => {
  fs.appendFileSync(markerPath, `completed:${process.pid}\n`, "utf8");
  process.exit(0);
}, Number(delayMs));
