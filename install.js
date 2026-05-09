#!/usr/bin/env node
"use strict";

// install.js — npm postinstall hook.
//
// Downloads the platform tarball for `apteva@<VERSION>` from
// GitHub releases and unpacks it into ~/.apteva/versions/<VERSION>/.
// Sets up the symlink chain
//
//   ~/.apteva/bin/current      → ../versions/<VERSION>
//   ~/.apteva/bin/apteva       → current/apteva
//   ~/.apteva/bin/apteva-server → current/apteva-server
//   ~/.apteva/bin/apteva-core  → current/apteva-core
//
// so cli.js (and `apteva update`'s atomic-flip path, and any systemd
// unit that points at ~/.apteva/bin/apteva-server) all resolve to
// the right binary regardless of which version is "active".
//
// Pre-v0.12, the layout was ~/.apteva/bin/<v>/<binaries> and the
// install dir held its own copies. We still drop copies into the
// install dir as a defensive fallback — cli.js prefers the symlink
// path but falls back to __dirname for environments where home
// isn't writable (CI, restricted containers, etc).

const os = require("os");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");

const VERSION = require("./package.json").version;
const REPO = "apteva/apteva";
const DIR = __dirname;

const PLATFORM_MAP = { linux: "linux", darwin: "darwin", win32: "windows" };
const ARCH_MAP = { x64: "amd64", arm64: "arm64" };

// Path helpers — mirror layout.go in the apteva CLI. Kept in sync
// by hand; both files are short and the shape is fixed.
const APTEVA_HOME = process.env.APTEVA_HOME || path.join(os.homedir(), ".apteva");
const VERSIONS_DIR = path.join(APTEVA_HOME, "versions");
const BIN_DIR = path.join(APTEVA_HOME, "bin");
const RELEASES_DIR = path.join(APTEVA_HOME, "releases");
const VERSION_DIR = path.join(VERSIONS_DIR, VERSION);
const CURRENT_LINK = path.join(BIN_DIR, "current");

const BIN_NAMES = ["apteva", "apteva-server", "apteva-core"];

function download(url) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? https : http;
      mod
        .get(url, { headers: { "User-Agent": "apteva-npm" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return follow(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        })
        .on("error", reject);
    };
    follow(url, 0);
  });
}

// pointSymlinks (re)creates the bin/ symlink chain pointing at
// VERSION_DIR. Idempotent — running it twice is a no-op. Mirrors
// the Go-side pointSymlinks() in apteva/layout.go; we duplicate it
// here so npm's postinstall doesn't need a Go runtime.
function pointSymlinks() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // current → ../versions/<VERSION>. Relative target keeps the
  // tree portable (move ~/.apteva to a different host home and it
  // still resolves).
  const relTarget = path.join("..", "versions", VERSION);
  const tmp = CURRENT_LINK + ".tmp";
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(relTarget, tmp);
  // POSIX-atomic rename onto current.
  fs.renameSync(tmp, CURRENT_LINK);

  // Per-binary shims: bin/<name> → current/<name>. Replace if
  // already present — old shims pointing at a since-deleted version
  // dir would fail to resolve.
  for (const name of BIN_NAMES) {
    const dst = path.join(BIN_DIR, name);
    try { fs.unlinkSync(dst); } catch {}
    fs.symlinkSync(path.join("current", name), dst);
  }
}

async function main() {
  const platform = PLATFORM_MAP[os.platform()];
  const arch = ARCH_MAP[os.arch()];
  if (!platform || !arch) {
    console.error(`apteva: unsupported platform ${os.platform()}-${os.arch()}`);
    process.exit(1);
  }
  const ext = platform === "windows" ? ".exe" : "";

  // If versions/<VERSION>/ already has our binaries (cached from
  // a prior npx install of the same version), just point the
  // symlinks and stash a defensive copy in DIR. No download.
  const cachedAptevaBin = path.join(VERSION_DIR, `apteva${ext}`);
  if (fs.existsSync(cachedAptevaBin)) {
    if (platform !== "windows") {
      try { pointSymlinks(); } catch (e) { /* non-fatal */ }
    }
    for (const name of BIN_NAMES) {
      const src = path.join(VERSION_DIR, `${name}${ext}`);
      const dst = path.join(DIR, `${name}${ext}`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        if (platform !== "windows") fs.chmodSync(dst, 0o755);
      }
    }
    console.log(`apteva: v${VERSION} loaded from ~/.apteva/versions/${VERSION}/`);
    return;
  }

  const tarName = `apteva-${VERSION}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${tarName}`;

  console.log(`apteva: downloading v${VERSION} for ${platform}-${arch}...`);

  try {
    const buffer = await download(url);

    // Stash the tarball in releases/ so future flake-recovery
    // paths can reuse it without re-downloading.
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    const releasePath = path.join(RELEASES_DIR, tarName);
    fs.writeFileSync(releasePath, buffer);

    console.log(`apteva: extracting (${(buffer.length / 1024 / 1024).toFixed(1)} MB)...`);
    fs.mkdirSync(VERSION_DIR, { recursive: true });
    execSync(`tar -xzf "${releasePath}" -C "${VERSION_DIR}"`, { stdio: "pipe" });

    if (platform !== "windows") {
      for (const name of BIN_NAMES) {
        const bin = path.join(VERSION_DIR, name);
        if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
      }
    }

    // Set up the symlink chain pointing at this version. Skip on
    // Windows where symlinks need elevated privileges.
    if (platform !== "windows") {
      try { pointSymlinks(); }
      catch (e) {
        console.warn(`apteva: symlink setup failed: ${e.message}`);
        console.warn("(falling back to per-package install dir; updates won't work without symlinks)");
      }
    }

    // Defensive copy into the npm package install dir so cli.js's
    // fallback path works when ~/.apteva isn't usable.
    for (const name of BIN_NAMES) {
      const src = path.join(VERSION_DIR, `${name}${ext}`);
      const dst = path.join(DIR, `${name}${ext}`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        if (platform !== "windows") fs.chmodSync(dst, 0o755);
      }
    }

    console.log(`apteva: installed to ~/.apteva/versions/${VERSION}/`);
    console.log("apteva: ready. (run 'apteva' to start, or 'apteva service install' for a background service)");
  } catch (err) {
    console.error(`apteva: binary download failed: ${err.message}`);
    console.error("");
    console.error("Falling back to local Go build...");

    // Fallback: build from source if Go is available.
    try {
      execSync("go version", { stdio: "pipe" });
      console.log("apteva: building from source...");
      execSync("go build -o apteva .", { cwd: DIR, stdio: "inherit" });
      console.log("apteva: built from source.");
    } catch {
      console.error("apteva: no pre-built binary and Go not installed.");
      console.error(`Download manually: https://github.com/${REPO}/releases/tag/v${VERSION}`);
      process.exit(1);
    }
  }
}

main();
