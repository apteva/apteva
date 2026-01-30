import { type Server, type Subprocess } from "bun";
import { handleApiRequest } from "./routes/api";
import { serveStatic } from "./routes/static";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { initDatabase, AgentDB, ProviderKeysDB } from "./db";
import {
  ensureBinary,
  getBinaryPath,
  getBinaryStatus,
  getActualBinaryPath,
  initVersionTracking,
  checkForUpdates,
  getInstalledVersion,
  getAptevaVersion,
  downloadLatestBinary,
} from "./binary";

const PORT = parseInt(process.env.PORT || "4280");

// Use ~/.apteva for persistent data (survives npm updates)
const HOME_DATA_DIR = join(homedir(), ".apteva");
if (!existsSync(HOME_DATA_DIR)) {
  mkdirSync(HOME_DATA_DIR, { recursive: true });
}
const DATA_DIR = process.env.DATA_DIR || HOME_DATA_DIR;
const BIN_DIR = join(import.meta.dir, "../bin");

// Load .env file (silently)
const envPath = join(import.meta.dir, "../.env");
const envFile = Bun.file(envPath);
if (await envFile.exists()) {
  const envContent = await envFile.text();
  for (const line of envContent.split("\n")) {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
}

// Initialize database (silently)
initDatabase(DATA_DIR);

// Initialize version tracking
initVersionTracking(DATA_DIR);

// Reset all agents to stopped on startup (processes don't survive restart)
AgentDB.resetAllStatus();

// In-memory store for running agent processes only
export const agentProcesses: Map<string, Subprocess> = new Map();

// Binary path - can be overridden via environment variable, or found from npm/downloaded
export function getBinaryPathForAgent(): string {
  // Environment override takes priority
  if (process.env.AGENT_BINARY_PATH) {
    return process.env.AGENT_BINARY_PATH;
  }
  // Otherwise use npm package or downloaded binary
  return getActualBinaryPath(BIN_DIR) || getBinaryPath(BIN_DIR);
}

// Export for legacy compatibility
export const BINARY_PATH = getBinaryPathForAgent();

// Export binary status function for API
export { getBinaryStatus, BIN_DIR };

// Base port for spawned agents
export let nextAgentPort = 4100;

// Increment port counter
export function getNextPort(): number {
  return nextAgentPort++;
}

// ANSI color codes matching UI theme
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  orange: "\x1b[38;5;208m",
  gray: "\x1b[38;5;245m",
  darkGray: "\x1b[38;5;240m",
  blue: "\x1b[38;5;75m",
  underline: "\x1b[4m",
};

// OSC 8 hyperlink helper - creates clickable links in supported terminals
// Works in: iTerm2, Windows Terminal, GNOME Terminal 3.26+, VS Code terminal, Hyper, Kitty
// Falls back to plain text in unsupported terminals (macOS Terminal.app, older terminals)
function link(url: string, text?: string): string {
  const displayText = text || url;
  // Using \x1b\\ (ST - String Terminator) instead of \x07 (BEL) for broader compatibility
  return `\x1b]8;;${url}\x1b\\${displayText}\x1b]8;;\x1b\\`;
}


// Startup banner
const aptevaVersion = getAptevaVersion();
console.log(`
  ${c.orange}${c.bold}>_ apteva${c.reset} ${c.gray}v${aptevaVersion}${c.reset}
  ${c.gray}Run AI agents locally${c.reset}
`);

// Check binary - ensureBinary handles progress output when downloading
process.stdout.write(`  ${c.darkGray}Agent${c.reset}     `);
const binaryResult = await ensureBinary(BIN_DIR);
// ensureBinary prints its own status when downloading/failing
// We only need to print "ready" if binary already existed
if (binaryResult.success && !binaryResult.downloaded) {
  const installedVersion = getInstalledVersion();
  console.log(`${c.gray}v${installedVersion || "unknown"} ready${c.reset}`);
}

// Check for updates in background (don't block startup)
checkForUpdates().then(versions => {
  const updates: string[] = [];
  if (versions.apteva.updateAvailable) {
    updates.push(`apteva: v${versions.apteva.installed} → v${versions.apteva.latest}`);
  }
  if (versions.agent.updateAvailable) {
    updates.push(`agent: v${versions.agent.installed || "?"} → v${versions.agent.latest}`);
  }
  if (updates.length > 0) {
    console.log(`\n  ${c.orange}Updates available:${c.reset}`);
    updates.forEach(u => console.log(`  ${c.gray}• ${u}${c.reset}`));
    console.log(`  ${c.gray}Update from Settings or run: npx apteva@latest${c.reset}\n`);
  }
}).catch(() => {
  // Silently ignore version check failures
});

// Check database
process.stdout.write(`  ${c.darkGray}Agents${c.reset}    `);
console.log(`${c.gray}${AgentDB.count()} loaded${c.reset}`);

// Check providers
const configuredProviders = ProviderKeysDB.getConfiguredProviders();
process.stdout.write(`  ${c.darkGray}Providers${c.reset} `);
console.log(`${c.gray}${configuredProviders.length} configured${c.reset}`);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // Listen on all interfaces
  development: false, // Suppress "Started server" message

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API routes
    if (path.startsWith("/api/")) {
      const response = await handleApiRequest(req, path);
      // Add CORS headers to response
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Serve static files (React app)
    return serveStatic(req, path);
  },
});

const serverUrl = `http://localhost:${PORT}`;
console.log(`
  ${c.gray}Open${c.reset}      ${c.blue}${c.bold}${link(serverUrl)}${c.reset}
            ${c.darkGray}Click link or Cmd/Ctrl+C to copy${c.reset}
`);

// Note: Don't use "export default server" - it causes Bun to print "Started server" message
