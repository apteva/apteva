#!/usr/bin/env node
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ext = os.platform() === "win32" ? ".exe" : "";
const DIR = __dirname;

const aptevaBin = path.join(DIR, `apteva${ext}`);
const serverBin = path.join(DIR, `apteva-server${ext}`);
const coreBin = path.join(DIR, `apteva-core${ext}`);

if (!fs.existsSync(aptevaBin)) {
  console.error("apteva: binary not found. Try reinstalling: npm install -g apteva");
  process.exit(1);
}

const result = spawnSync(aptevaBin, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    APTEVA_SERVER_BIN: serverBin,
    APTEVA_CORE_BIN: coreBin,
  },
});

if (result.error) {
  console.error(`apteva: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status || 0);
