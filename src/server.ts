import { type Server, type Subprocess } from "bun";
import { handleApiRequest } from "./routes/api";
import { serveStatic } from "./routes/static";
import { join } from "path";
import { initDatabase, AgentDB, ProviderKeysDB } from "./db";
import { ensureBinary, getBinaryPath, getBinaryStatus } from "./binary";

const PORT = parseInt(process.env.PORT || "4280");
const DATA_DIR = process.env.DATA_DIR || join(import.meta.dir, "../data");
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

// Reset all agents to stopped on startup (processes don't survive restart)
AgentDB.resetAllStatus();

// In-memory store for running agent processes only
export const agentProcesses: Map<string, Subprocess> = new Map();

// Binary path - can be overridden via environment variable
export const BINARY_PATH = process.env.AGENT_BINARY_PATH || getBinaryPath(BIN_DIR);

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
console.log(`
  ${c.orange}${c.bold}>_ APTEVA${c.reset}
  ${c.gray}Run AI agents locally${c.reset}
`);

// Check binary
process.stdout.write(`  ${c.darkGray}Binary${c.reset}    `);
const binaryResult = await ensureBinary(BIN_DIR);
if (!binaryResult.success) {
  console.log(`${c.orange}not available${c.reset}`);
} else {
  console.log(`${c.gray}ready${c.reset}`);
}

// Check database
process.stdout.write(`  ${c.darkGray}Agents${c.reset}    `);
console.log(`${c.gray}${AgentDB.count()} loaded${c.reset}`);

// Check providers
const configuredProviders = ProviderKeysDB.getConfiguredProviders();
process.stdout.write(`  ${c.darkGray}Providers${c.reset} `);
console.log(`${c.gray}${configuredProviders.length} configured${c.reset}`);

const server = Bun.serve({
  port: PORT,

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

export default server;
