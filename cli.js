#!/usr/bin/env node
"use strict";

// cli.js — npm shim. The user runs `apteva` (or `npx apteva`); npm
// resolves it to this file via package.json's "bin" field, and we
// hand off to the Go binary.
//
// Path resolution order:
//
//   1. ~/.apteva/bin/apteva — the load-bearing symlink chain that
//      `apteva update` flips. Preferred so `apteva update` followed
//      by re-running `apteva` actually picks up the new version
//      (vs running the stale __dirname copy from npm's install).
//
//   2. __dirname/apteva — the defensive copy install.js drops into
//      npm's package install dir. Fallback for environments where
//      ~/.apteva can't host symlinks (CI, restricted containers,
//      Windows without elevated privileges).
//
// APTEVA_SERVER_BIN / APTEVA_CORE_BIN propagate to the Go process
// so its findServerBinary / findCoreBinary helpers prefer the
// symlinked siblings rather than re-resolving against $PATH.

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ext = os.platform() === "win32" ? ".exe" : "";
const DIR = __dirname;
const APTEVA_HOME = process.env.APTEVA_HOME || path.join(os.homedir(), ".apteva");
const SYMLINKED_BIN_DIR = path.join(APTEVA_HOME, "bin");

function resolveBin(name) {
  const linked = path.join(SYMLINKED_BIN_DIR, `${name}${ext}`);
  // Use the symlink path even if the target is missing — when
  // present, it's the canonical "active version" pointer that
  // `apteva update` rewrites. fs.existsSync follows symlinks, so
  // we get a positive hit only when the entire chain resolves.
  if (fs.existsSync(linked)) return linked;
  // Fallback: the per-package copy install.js dropped here.
  const local = path.join(DIR, `${name}${ext}`);
  if (fs.existsSync(local)) return local;
  return null;
}

const aptevaBin = resolveBin("apteva");
const serverBin = resolveBin("apteva-server");
const coreBin = resolveBin("apteva-core");

if (!aptevaBin) {
  console.error("apteva: binary not found — symlinks at ~/.apteva/bin/ and the npm install dir are both empty.");
  console.error("Try: npm install -g apteva");
  process.exit(1);
}
if (!serverBin) {
  console.error(`apteva: warning - server binary not found`);
}
if (!coreBin) {
  console.error(`apteva: warning - core binary not found`);
}

const result = spawnSync(aptevaBin, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    APTEVA_SERVER_BIN: serverBin || "",
    APTEVA_CORE_BIN: coreBin || "",
  },
});

if (result.error) {
  console.error(`apteva: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status || 0);
