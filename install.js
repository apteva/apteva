#!/usr/bin/env node
"use strict";

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

async function main() {
  const platform = PLATFORM_MAP[os.platform()];
  const arch = ARCH_MAP[os.arch()];
  if (!platform || !arch) {
    console.error(`apteva: unsupported platform ${os.platform()}-${os.arch()}`);
    process.exit(1);
  }

  const tarName = `apteva-${VERSION}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${tarName}`;

  console.log(`apteva: downloading ${platform}-${arch} binaries...`);

  try {
    const buffer = await download(url);
    const tmpFile = path.join(DIR, "_download.tar.gz");
    fs.writeFileSync(tmpFile, buffer);

    console.log(`apteva: extracting (${(buffer.length / 1024 / 1024).toFixed(1)} MB)...`);
    execSync(`tar -xzf "${tmpFile}" -C "${DIR}"`, { stdio: "pipe" });
    fs.unlinkSync(tmpFile);

    // Make binaries executable
    if (platform !== "windows") {
      for (const name of ["apteva", "apteva-server", "apteva-core"]) {
        const bin = path.join(DIR, name);
        if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
      }
    }

    console.log("apteva: installed successfully.");
  } catch (err) {
    console.error(`apteva: binary download failed: ${err.message}`);
    console.error("");
    console.error("Falling back to local Go build...");

    // Fallback: build from source if Go is available
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
