#!/usr/bin/env bun
/**
 * Publish compiled platform binaries and main package to npm.
 *
 * Usage:
 *   bun run scripts/publish-binaries.ts              # Publish all
 *   bun run scripts/publish-binaries.ts --dry-run    # Dry run (no actual publish)
 *   bun run scripts/publish-binaries.ts --tag beta   # Publish with tag
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const DIST_BIN = join(ROOT, "dist-bin");
const PKG = JSON.parse(await Bun.file(join(ROOT, "package.json")).text());
const VERSION = PKG.version;

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagIdx = args.indexOf("--tag");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : "latest";

if (!existsSync(DIST_BIN)) {
  console.error("Error: dist-bin/ not found. Run 'bun run compile' first.");
  process.exit(1);
}

const platforms = readdirSync(DIST_BIN).filter(d => d.startsWith("apteva-"));
if (platforms.length === 0) {
  console.error("Error: No platform builds found in dist-bin/");
  process.exit(1);
}

console.log(`\n  Publishing apteva v${VERSION} (tag: ${tag})${dryRun ? " [DRY RUN]" : ""}\n`);

// Step 1: Publish platform packages
console.log("  [1/2] Publishing platform binaries...\n");

let allOk = true;
for (const platform of platforms) {
  const dir = join(DIST_BIN, platform);
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) continue;

  process.stdout.write(`    @apteva/${platform.padEnd(24)}`);

  try {
    const npmArgs = ["publish", "--access", "public", "--tag", tag];
    if (dryRun) npmArgs.push("--dry-run");

    await $`npm ${npmArgs}`.cwd(dir).quiet();
    console.log("OK");
  } catch (err: any) {
    // Check if it's just "already published" (not a real error)
    const msg = err?.message || String(err);
    if (msg.includes("already been published") || msg.includes("EPUBLISHCONFLICT")) {
      console.log("SKIP (already published)");
    } else {
      console.log("FAILED");
      console.error(`      ${msg.split("\n")[0]}`);
      allOk = false;
    }
  }
}

// Step 2: Publish main package
console.log("\n  [2/2] Publishing main package...\n");
process.stdout.write(`    apteva@${VERSION.padEnd(20)}`);

try {
  const npmArgs = ["publish", "--access", "public", "--tag", tag];
  if (dryRun) npmArgs.push("--dry-run");

  await $`npm ${npmArgs}`.cwd(ROOT).quiet();
  console.log("OK");
} catch (err: any) {
  const msg = err?.message || String(err);
  if (msg.includes("already been published") || msg.includes("EPUBLISHCONFLICT")) {
    console.log("SKIP (already published)");
  } else {
    console.log("FAILED");
    console.error(`      ${msg.split("\n")[0]}`);
    allOk = false;
  }
}

console.log("");
if (allOk) {
  console.log(`  Done! Published apteva v${VERSION}`);
} else {
  console.log("  Done with errors. Check output above.");
  process.exit(1);
}
console.log("");
