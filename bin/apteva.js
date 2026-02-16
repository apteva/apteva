#!/usr/bin/env node

import { spawn, execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Parse command line arguments
const args = process.argv.slice(2);
let port = 4280;
let dataDir = null;
let configFile = null;
let showHelp = false;
let showVersion = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" || arg === "-p") {
    port = parseInt(args[++i]) || 4280;
  } else if (arg === "--data-dir" || arg === "-d") {
    dataDir = args[++i];
  } else if (arg === "--config" || arg === "-c") {
    configFile = args[++i];
  } else if (arg === "--help" || arg === "-h" || arg === "help") {
    showHelp = true;
  } else if (arg === "--version" || arg === "-v" || arg === "version") {
    showVersion = true;
  }
}

if (showVersion) {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  console.log(`apteva v${pkg.version}`);
  process.exit(0);
}

if (showHelp) {
  console.log(`
apteva - Run AI agents locally

USAGE:
  apteva [options]
  apteva <command>

COMMANDS:
  start             Start the agent server (default)
  version           Show version information
  help              Show this help message

OPTIONS:
  -p, --port <port>       Port to listen on (default: 4280)
  -d, --data-dir <dir>    Directory for data storage
  -c, --config <file>     Path to config file
  -h, --help              Show this help message
  -v, --version           Show version information

ENVIRONMENT VARIABLES:
  PORT                    Server port (default: 4280)
  DATA_DIR                Data directory
  ANTHROPIC_API_KEY       Anthropic (Claude) API key
  OPENAI_API_KEY          OpenAI API key
  GROQ_API_KEY            Groq API key
  GEMINI_API_KEY          Google Gemini API key
  XAI_API_KEY             xAI (Grok) API key
  FIREWORKS_API_KEY       Fireworks AI API key
  MOONSHOT_API_KEY        Moonshot AI API key
  TOGETHER_API_KEY        Together AI API key

EXAMPLES:
  apteva                          Start on default port (4280)
  apteva --port 8080              Start on port 8080
  apteva --data-dir ./my-data     Use custom data directory
  apteva --config ./config.json   Use config file

DOCUMENTATION:
  https://github.com/apteva/apteva
  https://apteva.com/docs
`);
  process.exit(0);
}

// ============ Find the server executable ============

// Build environment
const env = { ...process.env };
env.PORT = String(port);
if (dataDir) env.DATA_DIR = dataDir;
if (configFile) env.CONFIG_FILE = configFile;

// Strategy 1: Compiled platform binary (works without Bun)
function findCompiledBinary() {
  const platform = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform];
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!platform || !arch) return null;

  const packageName = `@apteva/apteva-${platform}-${arch}`;

  // Try require.resolve() first (most reliable for npm-installed packages)
  try {
    const binaryPath = require(packageName);
    if (existsSync(binaryPath)) return binaryPath;
  } catch {
    // Package not installed
  }

  // Try direct paths in node_modules
  const binaryName = process.platform === "win32" ? "apteva.exe" : "apteva";
  const directPaths = [
    join(__dirname, "..", "node_modules", packageName, binaryName),
    join(__dirname, "..", "..", packageName, binaryName),
  ];
  for (const p of directPaths) {
    if (existsSync(p)) return p;
  }

  // Try postinstall symlink
  const symlinkPath = join(__dirname, process.platform === "win32" ? "apteva-server.exe" : "apteva-server");
  if (existsSync(symlinkPath)) return symlinkPath;

  return null;
}

// Strategy 2: Source mode with Bun
function findSourceEntry() {
  const serverPath = join(__dirname, "..", "src", "server.ts");
  if (existsSync(serverPath)) return serverPath;
  return null;
}

function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Try compiled binary first
const compiledBinary = findCompiledBinary();
if (compiledBinary) {
  // Run the compiled binary directly — no Bun needed
  const child = spawn(compiledBinary, [], {
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => {
    console.error("Error starting apteva:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => process.exit(code || 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
} else {
  // Fall back to source mode
  const sourceEntry = findSourceEntry();

  if (sourceEntry && hasBun()) {
    // Run with Bun (development mode)
    const child = spawn("bun", ["--silent", sourceEntry], {
      env,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) => {
      console.error("Error starting apteva:", err.message);
      process.exit(1);
    });

    child.on("exit", (code) => process.exit(code || 0));
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  } else {
    // No binary, no Bun — show helpful error
    console.error("Error: Could not find apteva binary for your platform.");
    console.error("");
    console.error("Options:");
    console.error("  1. Install Bun (recommended for development):");
    console.error("     curl -fsSL https://bun.sh/install | bash        # macOS/Linux");
    console.error("     powershell -c \"irm bun.sh/install.ps1 | iex\"    # Windows");
    console.error("");
    console.error("  2. Reinstall apteva (to get the platform binary):");
    console.error("     npm install -g apteva");
    process.exit(1);
  }
}
