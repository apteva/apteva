import { type Server, type Subprocess } from "bun";
import { handleApiRequest } from "./routes/api";
import { handleAuthRequest } from "./routes/auth";
import { serveStatic } from "./routes/static";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { initDatabase, AgentDB, ProviderKeysDB, McpServerDB, ChannelDB, TelemetryDB, type McpServer, type Agent } from "./db";
import { authMiddleware, type AuthContext } from "./auth/middleware";
import { startMcpProcess } from "./mcp-client";
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

// ============ SSE Telemetry Broadcast ============
export interface TelemetryEvent {
  id: string;
  agent_id: string;
  timestamp: string;
  category: string;
  type: string;
  level: string;
  trace_id?: string;
  thread_id?: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}

class TelemetryBroadcaster {
  private clients: Set<ReadableStreamDefaultController<string>> = new Set();

  addClient(controller: ReadableStreamDefaultController<string>) {
    this.clients.add(controller);
    console.log(`[SSE] Client connected (${this.clients.size} total)`);
  }

  removeClient(controller: ReadableStreamDefaultController<string>) {
    this.clients.delete(controller);
    console.log(`[SSE] Client disconnected (${this.clients.size} remaining)`);
  }

  broadcast(events: TelemetryEvent[]) {
    if (this.clients.size === 0) return;

    const data = `data: ${JSON.stringify(events)}\n\n`;
    const failedClients: ReadableStreamDefaultController<string>[] = [];

    // Iterate over a copy to avoid modification during iteration
    for (const controller of Array.from(this.clients)) {
      try {
        controller.enqueue(data);
      } catch {
        failedClients.push(controller);
      }
    }

    // Remove failed clients after iteration
    for (const client of failedClients) {
      this.clients.delete(client);
      console.log(`[SSE] Removed failed client (${this.clients.size} remaining)`);
    }
  }

  get clientCount() {
    return this.clients.size;
  }
}

export const telemetryBroadcaster = new TelemetryBroadcaster();

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

// Clean up old telemetry events (keep last 30 days)
try {
  const deleted = TelemetryDB.deleteOlderThan(30);
  if (deleted > 0) console.log(`[db] Cleaned up ${deleted} telemetry events older than 30 days`);
} catch { /* ignore */ }

// Initialize version tracking
initVersionTracking(DATA_DIR);

// Get agents, MCP servers, and channels that were running before restart (for auto-restart)
const agentsToRestart = AgentDB.findRunning();
const mcpServersToRestart = McpServerDB.findRunning();
const channelsToRestart = ChannelDB.findRunning();

// Reset all agents and MCP servers to stopped on startup (processes don't survive restart)
AgentDB.resetAllStatus();
McpServerDB.resetAllStatus();
// Reset channels too (bot polling doesn't survive restart)
for (const ch of channelsToRestart) {
  ChannelDB.setStatus(ch.id, "stopped");
}

// Clean up orphaned processes on agent ports (targeted cleanup based on DB)
async function cleanupOrphanedProcesses(): Promise<void> {
  // Get all agents with assigned ports
  const agents = AgentDB.findAll();
  const assignedPorts = agents.map(a => a.port).filter((p): p is number => p !== null);

  if (assignedPorts.length === 0) return;

  // Check all ports in parallel
  const results = await Promise.allSettled(assignedPorts.map(async (port) => {
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(200) });
      if (!res.ok) return false;
      // Orphaned process - shut it down gracefully
      try {
        await fetch(`http://localhost:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(500) });
        await new Promise(r => setTimeout(r, 500));
      } catch {}
      // Force kill if still running
      try {
        const check = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(200) });
        if (check.ok) {
          const { execSync } = await import("child_process");
          execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null || true`, { stdio: "ignore" });
        }
      } catch {}
      return true;
    } catch {
      return false;
    }
  }));

  const cleaned = results.filter(r => r.status === "fulfilled" && r.value).length;
  if (cleaned > 0) {
    console.log(`  [cleanup] Stopped ${cleaned} orphaned agent process(es)`);
  }
}

// Run cleanup (must complete before auto-restart to avoid killing freshly started agents)
await cleanupOrphanedProcesses().catch(() => {});

// In-memory store for running agent processes (agent_id -> { process, port })
export const agentProcesses: Map<string, { proc: Subprocess; port: number }> = new Map();

// Track agents currently being started (to prevent race conditions)
export const agentsStarting: Set<string> = new Set();

// Graceful shutdown handler - stop all agent processes when server exits
// NOTE: We intentionally do NOT update DB status here — agents marked "running"
// in the DB will be auto-restarted on next boot via findRunning() + resetAllStatus().
async function shutdownAllAgents() {
  if (agentProcesses.size === 0) return;

  console.log(`\n  Stopping ${agentProcesses.size} running agent(s)...`);

  for (const [agentId, { proc, port }] of agentProcesses) {
    try {
      // Try graceful shutdown
      await fetch(`http://localhost:${port}/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});

      proc.kill();
    } catch {
      // Ignore errors during shutdown
    }
  }
  agentProcesses.clear();
}

// Handle process termination signals
let shuttingDown = false;
export function isShuttingDown(): boolean { return shuttingDown; }
async function shutdownAllChannels() {
  try {
    const { stopAllChannels } = await import("./channels");
    await stopAllChannels();
  } catch {
    // Ignore import/stop errors during shutdown
  }
}

process.on("SIGINT", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownAllChannels();
  await shutdownAllAgents();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownAllChannels();
  await shutdownAllAgents();
  process.exit(0);
});

// Binary path - can be overridden via environment variable, or found from npm/downloaded
export function getBinaryPathForAgent(): string {
  // Environment override takes priority
  if (process.env.AGENT_BINARY_PATH) {
    return process.env.AGENT_BINARY_PATH;
  }
  // Otherwise use downloaded or npm binary (getActualBinaryPath checks both)
  const actualPath = getActualBinaryPath(BIN_DIR);
  if (actualPath) {
    return actualPath;
  }
  // No binary found - return expected path for error messages
  return getBinaryPath(BIN_DIR);
}

// Export for legacy compatibility
export const BINARY_PATH = getBinaryPathForAgent();

// Export binary status function for API
export { getBinaryStatus, BIN_DIR };

// Base port for MCP server proxies (separate range from agents which use 4100-4199)
export let nextMcpPort = 4200;

// Check if a port is available by trying to connect to it
async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 100);
    try {
      await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return false; // Port responded, something is running there
    } catch (err: any) {
      clearTimeout(timeout);
      // Connection refused = port is available
      // Abort error = port is available (timeout means nothing responded)
      if (err?.code === "ECONNREFUSED" || err?.name === "AbortError") {
        return true;
      }
      return true; // Assume available if we get other errors
    }
  } catch {
    return true;
  }
}

// Get next available port for MCP servers (checking that nothing is using it)
export async function getNextPort(): Promise<number> {
  const maxAttempts = 100; // Prevent infinite loop
  for (let i = 0; i < maxAttempts; i++) {
    const port = nextMcpPort++;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
    console.log(`[port] Port ${port} in use, trying next...`);
  }
  throw new Error("Could not find available port after 100 attempts");
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
  idleTimeout: 255, // Max value - prevents SSE connections from timing out

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Dev mode route logging
    if (process.env.NODE_ENV !== "production" && path.startsWith("/api/")) {
      const params = url.search ? url.search : "";
      console.log(`[${req.method}] ${path}${params}`);
    }

    // CORS headers - configurable origins
    const origin = req.headers.get("Origin") || "";
    const allowedOrigins = process.env.CORS_ORIGINS?.split(",") || [];
    const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
    const allowOrigin = allowedOrigins.includes(origin) || isLocalhost || allowedOrigins.length === 0 ? origin || "*" : "";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Allow-Credentials": "true",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API routes
    if (path.startsWith("/api/")) {
      // Auth routes handled separately (before middleware)
      if (path.startsWith("/api/auth/")) {
        const response = await handleAuthRequest(req, path);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Health check endpoint (no auth required for Docker health checks)
      if (path === "/api/health") {
        const response = await handleApiRequest(req, path);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Apply auth middleware
      const { response: authResponse, context } = await authMiddleware(req, path);
      if (authResponse) {
        Object.entries(corsHeaders).forEach(([key, value]) => {
          authResponse.headers.set(key, value);
        });
        return authResponse;
      }

      // Pass auth context to API handler
      const response = await handleApiRequest(req, path, context);
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

// Auto-restart agents, MCP servers, and channels that were running before restart
const hasRestarts = agentsToRestart.length > 0 || mcpServersToRestart.length > 0 || channelsToRestart.length > 0;

if (hasRestarts) {
  // Restart in background to not block startup
  (async () => {
    // Import startAgentProcess dynamically to avoid circular dependency
    const { startAgentProcess } = await import("./routes/api/agent-utils");

    // Restart MCP servers first (agents may depend on them)
    if (mcpServersToRestart.length > 0) {
      console.log(`  ${c.darkGray}MCP${c.reset}       ${c.gray}Restarting ${mcpServersToRestart.length} server(s)...${c.reset}`);

      for (const server of mcpServersToRestart) {
        try {
          // Helper to substitute $ENV_VAR references with actual values
          const substituteEnvVars = (str: string, env: Record<string, string>): string => {
            return str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName) => {
              return env[varName] || '';
            });
          };

          let cmd: string[];
          const serverEnv = server.env || {};

          if (server.command) {
            cmd = server.command.split(" ");
            if (server.args) {
              const substitutedArgs = substituteEnvVars(server.args, serverEnv);
              cmd.push(...substitutedArgs.split(" "));
            }
          } else if (server.package) {
            cmd = ["npx", "-y", server.package];
            if (server.args) {
              const substitutedArgs = substituteEnvVars(server.args, serverEnv);
              cmd.push(...substitutedArgs.split(" "));
            }
          } else {
            console.log(`  ${c.gray}  ✗ ${server.name}: no command or package${c.reset}`);
            continue;
          }

          // Use permanently assigned port from DB, fallback to dynamic
          const port = server.port || await getNextPort();
          const result = await startMcpProcess(server.id, cmd, serverEnv, port);

          if (result.success) {
            McpServerDB.setStatus(server.id, "running", port);
            console.log(`  ${c.gray}  ✓ ${server.name} on :${port}${c.reset}`);
          } else {
            console.log(`  ${c.gray}  ✗ ${server.name}: ${result.error}${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.gray}  ✗ ${server.name}: ${err}${c.reset}`);
        }
      }
    }

    // Then restart agents - in parallel
    if (agentsToRestart.length > 0) {
      console.log(`  ${c.darkGray}Agents${c.reset}    ${c.gray}Restarting ${agentsToRestart.length} agent(s)...${c.reset}`);

      await Promise.allSettled(agentsToRestart.map(async (agent) => {
        try {
          const result = await startAgentProcess(agent, { silent: true });
          if (result.success) {
            console.log(`  ${c.gray}  ✓ ${agent.name} on :${result.port}${c.reset}`);
          } else {
            console.log(`  ${c.gray}  ✗ ${agent.name}: ${result.error}${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.gray}  ✗ ${agent.name}: ${err}${c.reset}`);
        }
      }));
    }

    // Restart channels (after agents, since channels depend on running agents)
    if (channelsToRestart.length > 0) {
      const { startChannel } = await import("./channels");
      console.log(`  ${c.darkGray}Channels${c.reset}  ${c.gray}Restarting ${channelsToRestart.length} channel(s)...${c.reset}`);

      await Promise.allSettled(channelsToRestart.map(async (channel) => {
        try {
          const result = await startChannel(channel.id);
          if (result.success) {
            console.log(`  ${c.gray}  ✓ ${channel.name} (${channel.type})${c.reset}`);
          } else {
            console.log(`  ${c.gray}  ✗ ${channel.name}: ${result.error}${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.gray}  ✗ ${channel.name}: ${err}${c.reset}`);
        }
      }));
    }
  })();
}

// Note: Don't use "export default server" - it causes Bun to print "Started server" message
