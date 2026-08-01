"use strict";

const path = require("path");
const hostPath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/host.js");
const host = require(hostPath);
host.launchLocalSupervisor = () => process.kill(process.pid, "SIGKILL");
