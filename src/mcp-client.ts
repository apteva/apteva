// MCP Client for communicating with MCP servers
// Supports both stdio (subprocess) and HTTP transports
// Includes HTTP proxy to expose stdio servers over HTTP for agents

import { spawn, serve, type Subprocess, type Server } from "bun";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string; // base64 for images
  mimeType?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

interface ToolsListResult {
  tools: McpTool[];
  nextCursor?: string;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

// ============ Stdio MCP Client ============

interface McpProcess {
  proc: Subprocess;
  initialized: boolean;
  serverInfo: { name: string; version: string } | null;
  requestId: number;
  buffer: string;
  httpServer?: Server;  // HTTP proxy server
  httpPort?: number;    // Port the HTTP proxy is running on
}

// Store running MCP processes
const mcpProcesses = new Map<string, McpProcess>();

// Mutex for serializing stdio requests (one at a time per process)
const requestLocks = new Map<string, Promise<void>>();

async function withLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending request to complete
  while (requestLocks.has(serverId)) {
    await requestLocks.get(serverId);
  }

  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  requestLocks.set(serverId, lockPromise);

  try {
    return await fn();
  } finally {
    requestLocks.delete(serverId);
    resolve!();
  }
}

export function getMcpProcess(serverId: string): McpProcess | undefined {
  return mcpProcesses.get(serverId);
}

export async function startMcpProcess(
  serverId: string,
  command: string[],
  env: Record<string, string> = {},
  httpPort?: number
): Promise<{ success: boolean; error?: string; port?: number }> {
  // Stop existing process if any
  stopMcpProcess(serverId);

  try {
    const proc = spawn({
      cmd: command,
      env: { ...process.env as Record<string, string>, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const entry: McpProcess = {
      proc,
      initialized: false,
      serverInfo: null,
      requestId: 0,
      buffer: "",
    };

    mcpProcesses.set(serverId, entry);

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if process is still running
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      mcpProcesses.delete(serverId);
      return { success: false, error: `Process exited: ${stderr || "unknown error"}` };
    }

    // Start HTTP proxy server if port specified (retry once if port busy from previous process)
    if (httpPort) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const httpServer = startHttpProxy(serverId, httpPort);
          entry.httpServer = httpServer;
          entry.httpPort = httpPort;
          console.log(`[MCP] HTTP proxy for ${serverId} started on port ${httpPort}`);
          break;
        } catch (err: any) {
          if (err?.code === "EADDRINUSE" && attempt < 2) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          console.error(`[MCP] Failed to start HTTP proxy for ${serverId}:`, err);
        }
      }
    }

    return { success: true, port: httpPort };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Start HTTP proxy server that forwards requests to stdio process
function startHttpProxy(serverId: string, port: number): Server {
  return serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS headers
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
      };

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      // Only accept POST to /mcp
      if (req.method !== "POST" || (url.pathname !== "/mcp" && url.pathname !== "/")) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const body = await req.json() as JsonRpcRequest;

        // Forward to stdio process with lock to serialize requests
        const result = await withLock(serverId, async () => {
          return await sendRequestRaw(serverId, body.method, body.params, body.id);
        });

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 0,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return new Response(JSON.stringify(errorResponse), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    },
  });
}

// Raw request that returns full JSON-RPC response (for proxy use)
async function sendRequestRaw(
  serverId: string,
  method: string,
  params?: unknown,
  requestId?: number
): Promise<JsonRpcResponse> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) {
    throw new Error("MCP process not running");
  }

  const id = requestId ?? ++entry.requestId;
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  const requestLine = JSON.stringify(request) + "\n";

  // Write to stdin
  entry.proc.stdin.write(requestLine);
  entry.proc.stdin.flush();

  // Read response from stdout with timeout
  return await readJsonRpcResponse(entry, id, 30000);
}

export function stopMcpProcess(serverId: string): void {
  const entry = mcpProcesses.get(serverId);
  if (entry) {
    // Stop HTTP proxy server first
    if (entry.httpServer) {
      try {
        entry.httpServer.stop();
        console.log(`[MCP] HTTP proxy for ${serverId} stopped`);
      } catch {
        // Ignore stop errors
      }
    }
    // Kill the stdio process
    try {
      entry.proc.kill();
    } catch {
      // Ignore kill errors
    }
    mcpProcesses.delete(serverId);
  }
}

// Get the HTTP proxy URL for an MCP server
export function getMcpProxyUrl(serverId: string): string | null {
  const entry = mcpProcesses.get(serverId);
  if (entry?.httpPort) {
    return `http://localhost:${entry.httpPort}/mcp`;
  }
  return null;
}

async function sendRequest(serverId: string, method: string, params?: unknown): Promise<unknown> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) {
    throw new Error("MCP process not running");
  }

  const id = ++entry.requestId;
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  const requestLine = JSON.stringify(request) + "\n";

  // Write to stdin (Bun's FileSink has write() directly)
  entry.proc.stdin.write(requestLine);
  entry.proc.stdin.flush();

  // Read response from stdout with timeout
  const response = await readJsonRpcResponse(entry, id, 30000);

  if (response.error) {
    throw new Error(`MCP Error ${response.error.code}: ${response.error.message}`);
  }

  return response.result;
}

async function readJsonRpcResponse(
  entry: McpProcess,
  expectedId: number,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const startTime = Date.now();

  // Initialize buffer if not exists
  if (!entry.buffer) {
    entry.buffer = "";
  }

  while (Date.now() - startTime < timeoutMs) {
    // Check buffer first for complete lines
    const lines = entry.buffer.split("\n");
    entry.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id === expectedId) {
          return response;
        }
        // Ignore responses with different IDs (could be notifications)
      } catch {
        // Not valid JSON, continue
      }
    }

    // Read more data from stdout
    const reader = entry.proc.stdout.getReader();
    try {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.min(1000, timeoutMs - (Date.now() - startTime)))
        ),
      ]);

      if (value) {
        entry.buffer += decoder.decode(value, { stream: true });
      }

      if (done && !value) {
        // Process might have exited
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      reader.releaseLock();
    }
  }

  throw new Error("Timeout waiting for MCP response");
}

async function sendNotification(serverId: string, method: string, params?: unknown): Promise<void> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) return;

  const notification = {
    jsonrpc: "2.0",
    method,
    params,
  };

  const notificationLine = JSON.stringify(notification) + "\n";

  try {
    entry.proc.stdin.write(notificationLine);
    entry.proc.stdin.flush();
  } catch {
    // Ignore notification errors
  }
}

export async function initializeMcpServer(serverId: string): Promise<{ name: string; version: string }> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) {
    throw new Error("MCP process not running");
  }

  if (entry.initialized && entry.serverInfo) {
    return entry.serverInfo;
  }

  const result = await sendRequest(serverId, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      roots: { listChanged: true },
    },
    clientInfo: {
      name: "apteva",
      version: "1.0.0",
    },
  }) as InitializeResult;

  entry.serverInfo = result.serverInfo;
  entry.initialized = true;

  // Send initialized notification
  await sendNotification(serverId, "notifications/initialized");

  return entry.serverInfo;
}

export async function listMcpTools(serverId: string): Promise<McpTool[]> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) {
    throw new Error("MCP process not running");
  }

  if (!entry.initialized) {
    await initializeMcpServer(serverId);
  }

  const result = await sendRequest(serverId, "tools/list") as ToolsListResult;
  return result.tools || [];
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<McpToolCallResult> {
  const entry = mcpProcesses.get(serverId);
  if (!entry) {
    throw new Error("MCP process not running");
  }

  if (!entry.initialized) {
    await initializeMcpServer(serverId);
  }

  const result = await sendRequest(serverId, "tools/call", {
    name: toolName,
    arguments: args,
  }) as McpToolCallResult;

  return result;
}

// ============ HTTP MCP Client (for remote servers) ============

export class HttpMcpClient {
  private url: string;
  private headers: Record<string, string>;
  private sessionId: string | null = null;
  private initialized = false;
  private requestId = 0;
  private serverInfo: { name: string; version: string } | null = null;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private async doRequest(method: string, params?: unknown): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method,
      params,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("text/event-stream")) {
      return this.handleSSEResponse(response);
    }

    const data = await response.json() as JsonRpcResponse;

    if (data.error) {
      throw new Error(`MCP Error ${data.error.code}: ${data.error.message}`);
    }

    return data.result;
  }

  private async handleSSEResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6)) as JsonRpcResponse;
        if (data.error) {
          throw new Error(`MCP Error ${data.error.code}: ${data.error.message}`);
        }
        return data.result;
      }
    }

    throw new Error("No data in SSE response");
  }

  async initialize(): Promise<{ name: string; version: string }> {
    if (this.initialized && this.serverInfo) {
      return this.serverInfo;
    }

    const result = await this.doRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        roots: { listChanged: true },
      },
      clientInfo: {
        name: "apteva",
        version: "1.0.0",
      },
    }) as InitializeResult;

    this.serverInfo = result.serverInfo;
    this.initialized = true;

    return this.serverInfo;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.doRequest("tools/list") as ToolsListResult;
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.doRequest("tools/call", {
      name,
      arguments: args,
    }) as McpToolCallResult;

    return result;
  }
}

// Cache for HTTP MCP clients
const httpClientCache = new Map<string, HttpMcpClient>();

export function getHttpMcpClient(url: string, headers: Record<string, string> = {}): HttpMcpClient {
  const cacheKey = `${url}:${JSON.stringify(headers)}`;

  let client = httpClientCache.get(cacheKey);
  if (!client) {
    client = new HttpMcpClient(url, headers);
    httpClientCache.set(cacheKey, client);
  }

  return client;
}

export function clearHttpMcpClientCache(): void {
  httpClientCache.clear();
}
