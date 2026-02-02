import { $ } from "bun";

const outdir = "./dist";

console.log("🔨 Building apteva...\n");

// Clean dist folder
await $`rm -rf ${outdir}`;
await $`mkdir -p ${outdir}`;

// Build React app with Bun bundler
console.log("📦 Bundling React app...");
const result = await Bun.build({
  entrypoints: ["./src/web/App.tsx"],
  outdir,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "external",
  naming: {
    entry: "[name].[hash].js",
    chunk: "[name].[hash].js",
    asset: "[name].[hash][ext]",
  },
});

if (!result.success) {
  console.error("❌ Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Get the output filename
const jsFile = result.outputs.find((o) => o.path.endsWith(".js"));
const jsFilename = jsFile ? jsFile.path.split("/").pop() : "App.js";

console.log(`   → ${jsFilename}`);

// Build Tailwind CSS
console.log("\n🎨 Building Tailwind CSS...");
await $`bunx tailwindcss -i ./src/web/styles.css -o ${outdir}/styles.css --minify`;

// Copy apteva-kit styles
console.log("\n📦 Copying apteva-kit styles...");
await $`cp ./node_modules/@apteva/apteva-kit/dist/styles.css ${outdir}/apteva-kit.css`;

// Copy icon
console.log("\n🎨 Copying icon...");
await $`cp ./src/web/icon.png ${outdir}/icon.png`;

// Create index.html with correct script reference
console.log("\n📄 Creating index.html...");
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apteva</title>
  <link rel="icon" type="image/png" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/apteva-kit.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/${jsFilename}"></script>
</body>
</html>`;

await Bun.write(`${outdir}/index.html`, html);

console.log("\n✅ Build complete!");
console.log(`   Output: ${outdir}/`);

// List output files
const files = await $`ls -lh ${outdir}`.text();
console.log("\n" + files);
