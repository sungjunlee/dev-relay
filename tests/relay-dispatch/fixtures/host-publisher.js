"use strict";

const fs = require("fs");

const [publicationPath] = process.argv.slice(2);
if (!publicationPath) process.exit(2);

const publication = {
  pr_number: 901,
  repo: "fixture/dev-relay",
  head_ref: "fixture/crash-drill",
  base_ref: "main",
  head_sha: "1".repeat(40),
  created_by_relay: true,
};

let fd;
try {
  fd = fs.openSync(publicationPath, "wx", 0o600);
  fs.writeFileSync(fd, `${JSON.stringify(publication)}\n`, "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
} catch (error) {
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch {}
  }
  if (error.code !== "EEXIST") throw error;
  JSON.parse(fs.readFileSync(publicationPath, "utf8"));
}
