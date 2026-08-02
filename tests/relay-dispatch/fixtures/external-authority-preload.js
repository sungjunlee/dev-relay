"use strict";

const fs = require("node:fs");

if (process.env.RELAY_TEST_EXTERNAL_AUTHORITY === "1") {
  const accessSync = fs.accessSync;
  process.geteuid = () => 99999;
  fs.accessSync = (target, mode) => {
    if (mode === fs.constants.W_OK) {
      const error = new Error(`test external authority is not writable: ${target}`);
      error.code = "EACCES";
      throw error;
    }
    return accessSync(target, mode);
  };
}
