#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const VERSION = "0.5.0";
const BIN_DIR = path.join(__dirname, "bin");
const GITHUB_ORG = "apteva";

const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_MAP = {
  x64: "amd64",
  arm64: "arm64",
};

const platform = PLATFORM_MAP[os.platform()];
const arch = ARCH_MAP[os.arch()];

if (!platform || !arch) {
  console.error(`Unsupported platform: ${os.platform()}-${os.arch()}`);
  process.exit(1);
}

const ext = platform === "windows" ? ".exe" : "";

const binaries = [
  { repo: "server", name: `apteva-server${ext}` },
  { repo: "core", name: `apteva-core${ext}` },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          fs.chmodSync(dest, 0o755);
          resolve();
        });
      }).on("error", reject);
    };
    follow(url);
  });
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  for (const bin of binaries) {
    const dest = path.join(BIN_DIR, bin.name);
    if (fs.existsSync(dest)) {
      console.log(`  ${bin.name} already exists, skipping`);
      continue;
    }

    const url = `https://github.com/${GITHUB_ORG}/${bin.repo}/releases/download/v${VERSION}/${bin.name}-${platform}-${arch}${ext}`;
    console.log(`  Downloading ${bin.name} for ${platform}-${arch}...`);

    try {
      await download(url, dest);
      console.log(`  ${bin.name} installed`);
    } catch (err) {
      console.error(`  Failed to download ${bin.name}: ${err.message}`);
      console.error(`  URL: ${url}`);
      console.error(`  You can build from source: https://github.com/${GITHUB_ORG}/${bin.repo}`);
    }
  }
}

main().catch((err) => {
  console.error("Installation failed:", err.message);
  process.exit(1);
});
