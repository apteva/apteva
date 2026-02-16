#!/usr/bin/env node
/**
 * Postinstall script for apteva npm package.
 * Detects platform and creates a symlink to the compiled binary
 * from the matching @apteva/apteva-{platform}-{arch} package.
 *
 * This runs with plain Node.js — no Bun required.
 */

import { existsSync, symlinkSync, unlinkSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "bin");
const require = createRequire(import.meta.url);

// Map Node.js platform/arch to our package naming
const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
};

const ARCH_MAP = {
  x64: "x64",
  arm64: "arm64",
};

function main() {
  const platform = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];

  if (!platform || !arch) {
    console.log(`apteva: No binary available for ${process.platform}-${process.arch}`);
    console.log("apteva: You can still run with Bun: bun apteva");
    process.exit(0);
  }

  const packageName = `@apteva/apteva-${platform}-${arch}`;

  // Try to find the platform binary package
  let binaryPath;
  try {
    binaryPath = require(packageName);
  } catch {
    // Package not installed (npm skips optionalDeps that don't match platform)
    // Also try direct path resolution
    const directPaths = [
      join(ROOT, "node_modules", packageName, platform === "win32" ? "apteva.exe" : "apteva"),
      join(ROOT, "..", packageName, platform === "win32" ? "apteva.exe" : "apteva"),
    ];

    for (const p of directPaths) {
      if (existsSync(p)) {
        binaryPath = p;
        break;
      }
    }
  }

  if (!binaryPath || !existsSync(binaryPath)) {
    // No compiled binary — that's OK, user can run with Bun
    process.exit(0);
  }

  // Ensure bin directory exists
  mkdirSync(BIN_DIR, { recursive: true });

  const targetName = process.platform === "win32" ? "apteva-server.exe" : "apteva-server";
  const targetPath = join(BIN_DIR, targetName);

  // Remove existing link/file
  try {
    unlinkSync(targetPath);
  } catch {
    // Doesn't exist, that's fine
  }

  // Create symlink (or copy on Windows)
  try {
    if (process.platform === "win32") {
      copyFileSync(binaryPath, targetPath);
    } else {
      symlinkSync(binaryPath, targetPath);
      chmodSync(binaryPath, 0o755);
    }
  } catch (err) {
    // Symlink may fail on some systems — try copy as fallback
    try {
      copyFileSync(binaryPath, targetPath);
      chmodSync(targetPath, 0o755);
    } catch {
      // Silent fail — bin/apteva.js will find the binary via require() at runtime
      process.exit(0);
    }
  }
}

main();
