#!/usr/bin/env node

const fs = require("fs");
const { executeAdvisoryRequest } = require("./review-runner/advisory");

function main() {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error("advisory-worker requires a request JSON path");
  }
  const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
  executeAdvisoryRequest(request);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
