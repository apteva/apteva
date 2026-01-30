#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
let port = 4015;
let dataDir = null;
let configFile = null;
let showHelp = false;
let showVersion = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" || arg === "-p") {
    port = parseInt(args[++i]) || 4015;
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
  const pkg = await import("../package.json", { assert: { type: "json" } });
  console.log(`apteva v${pkg.default.version}`);
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
  -p, --port <port>       Port to listen on (default: 4015)
  -d, --data-dir <dir>    Directory for data storage
  -c, --config <file>     Path to config file
  -h, --help              Show this help message
  -v, --version           Show version information

ENVIRONMENT VARIABLES:
  PORT                    Server port (default: 4015)
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
  apteva                          Start on default port (4015)
  apteva --port 8080              Start on port 8080
  apteva --data-dir ./my-data     Use custom data directory
  apteva --config ./config.json   Use config file

DOCUMENTATION:
  https://github.com/apteva/apteva
  https://apteva.com/docs
`);
  process.exit(0);
}

// Find the server entry point
const serverPath = join(__dirname, "..", "src", "server.ts");
const distServerPath = join(__dirname, "..", "dist", "server.js");

let entryPoint;
if (existsSync(serverPath)) {
  entryPoint = serverPath;
} else if (existsSync(distServerPath)) {
  entryPoint = distServerPath;
} else {
  console.error("Error: Could not find server entry point");
  process.exit(1);
}

// Build environment
const env = { ...process.env };
env.PORT = String(port);
if (dataDir) env.DATA_DIR = dataDir;
if (configFile) env.CONFIG_FILE = configFile;

// Check if bun is available
const runtime = process.env.BUN_INSTALL ? "bun" : "node";

// Spawn the server
const child = spawn(runtime, ["run", entryPoint], {
  env,
  stdio: "inherit",
  shell: false,
});

child.on("error", (err) => {
  if (err.code === "ENOENT" && runtime === "bun") {
    // Fallback to node if bun not found
    const nodeChild = spawn("node", [entryPoint], {
      env,
      stdio: "inherit",
      shell: false,
    });
    nodeChild.on("error", (nodeErr) => {
      console.error("Error starting server:", nodeErr.message);
      process.exit(1);
    });
  } else {
    console.error("Error starting server:", err.message);
    process.exit(1);
  }
});

child.on("exit", (code) => {
  process.exit(code || 0);
});

// Handle termination
process.on("SIGINT", () => {
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
