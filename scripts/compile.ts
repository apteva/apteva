#!/usr/bin/env bun
/**
 * Compile apteva server into standalone platform binaries.
 *
 * Usage:
 *   bun run scripts/compile.ts              # Build all platforms
 *   bun run scripts/compile.ts --single     # Build current platform only
 *   bun run scripts/compile.ts --skip-build # Skip frontend build
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, cpSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const DIST_BIN = join(ROOT, "dist-bin");
const DIST_DIR = join(ROOT, "dist");
const PKG = JSON.parse(await Bun.file(join(ROOT, "package.json")).text());
const VERSION = PKG.version;
const SCOPE = "@apteva";

// Platform targets
interface Target {
  name: string;       // e.g., "apteva-linux-x64"
  bunTarget: string;  // e.g., "bun-linux-x64"
  os: string;         // npm os field
  cpu: string;        // npm cpu field
  ext: string;        // binary extension
}

const ALL_TARGETS: Target[] = [
  { name: "apteva-linux-x64",     bunTarget: "bun-linux-x64",     os: "linux",  cpu: "x64",   ext: "" },
  { name: "apteva-linux-arm64",   bunTarget: "bun-linux-arm64",   os: "linux",  cpu: "arm64", ext: "" },
  { name: "apteva-darwin-arm64",  bunTarget: "bun-darwin-arm64",  os: "darwin", cpu: "arm64", ext: "" },
  { name: "apteva-darwin-x64",    bunTarget: "bun-darwin-x64",    os: "darwin", cpu: "x64",   ext: "" },
  { name: "apteva-win32-x64",    bunTarget: "bun-windows-x64",   os: "win32",  cpu: "x64",   ext: ".exe" },
];

// Parse args
const args = process.argv.slice(2);
const singlePlatform = args.includes("--single");
const skipBuild = args.includes("--skip-build");

// Determine targets
let targets = ALL_TARGETS;
if (singlePlatform) {
  const current = `${process.platform}-${process.arch}`;
  targets = ALL_TARGETS.filter(t => `${t.os}-${t.cpu}` === current);
  if (targets.length === 0) {
    console.error(`No target for current platform: ${current}`);
    process.exit(1);
  }
}

console.log(`\n  Compiling apteva v${VERSION}\n`);

// Step 1: Build frontend if needed
if (!skipBuild) {
  console.log("  [1/3] Building frontend...");
  await $`bun run build`.cwd(ROOT).quiet();
}

if (!existsSync(join(DIST_DIR, "index.html"))) {
  console.error("  Error: dist/index.html not found. Run 'bun run build' first.");
  process.exit(1);
}
console.log("  [1/3] Frontend ready");

// Step 2: Clean output
console.log("  [2/3] Preparing output...");
if (existsSync(DIST_BIN)) {
  rmSync(DIST_BIN, { recursive: true });
}
mkdirSync(DIST_BIN, { recursive: true });

// Step 3: Compile for each target
console.log(`  [3/3] Compiling ${targets.length} target(s)...\n`);

for (const target of targets) {
  const targetDir = join(DIST_BIN, target.name);
  mkdirSync(targetDir, { recursive: true });

  const binaryName = `apteva${target.ext}`;
  const outfile = join(targetDir, binaryName);

  process.stdout.write(`    ${target.name.padEnd(24)}`);

  try {
    // Compile server into standalone binary
    // The binary includes Bun runtime + bun:sqlite + all TS/JS source
    // Frontend dist/ is shipped alongside (not embedded)
    const proc = Bun.spawn([
      "bun", "build", "--compile",
      "--target", target.bunTarget,
      "--outfile", outfile,
      "--minify",
      join(ROOT, "src/server.ts"),
    ], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      console.log("FAILED");
      for (const line of stderr.split("\n").filter(Boolean)) {
        console.error(`      ${line}`);
      }
      continue;
    }

    // Copy dist/ into the platform package (for static file serving)
    const targetDist = join(targetDir, "dist");
    cpSync(DIST_DIR, targetDist, { recursive: true });

    console.log("OK");

    // Create platform package files
    // package.json with os/cpu filters — npm only installs matching platform
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify(
        {
          name: `${SCOPE}/${target.name}`,
          version: VERSION,
          description: `Apteva binary for ${target.os} ${target.cpu}`,
          os: [target.os],
          cpu: [target.cpu],
          main: "index.js",
          license: "Elastic-2.0",
          preferUnplugged: true,
        },
        null,
        2
      ) + "\n"
    );

    // index.js - exports the binary path (used by bin/apteva.js to find it)
    writeFileSync(
      join(targetDir, "index.js"),
      `const path = require('path');\nmodule.exports = path.join(__dirname, '${binaryName}');\n`
    );
  } catch (err: any) {
    console.log("FAILED");
    console.error(`      ${err?.message || err}`);
  }
}

// Summary
console.log("\n  Done! Output in dist-bin/\n");
const built = readdirSync(DIST_BIN);
for (const dir of built) {
  const targetDir = join(DIST_BIN, dir);
  const files = readdirSync(targetDir);
  const binary = files.find(f => f.startsWith("apteva") && !f.endsWith(".json") && !f.endsWith(".js"));
  if (binary) {
    const stat = Bun.file(join(targetDir, binary));
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`    ${dir.padEnd(24)} ${sizeMB} MB`);
  }
}
console.log("");
