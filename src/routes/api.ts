import { spawn } from "bun";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { agentProcesses, BINARY_PATH, getNextPort, getBinaryStatus, BIN_DIR } from "../server";
import { AgentDB, McpServerDB, generateId, type Agent, type AgentFeatures, type McpServer } from "../db";
import { ProviderKeys, Onboarding, getProvidersWithStatus, PROVIDERS, type ProviderId } from "../providers";
import { binaryExists } from "../binary";
import {
  startMcpProcess,
  stopMcpProcess,
  initializeMcpServer,
  listMcpTools,
  callMcpTool,
  getMcpProcess,
} from "../mcp-client";

// Data directory for agent instances (in ~/.apteva/agents/)
const AGENTS_DATA_DIR = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "agents")
  : join(homedir(), ".apteva", "agents");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Wait for agent to be healthy (with timeout)
async function waitForAgentHealth(port: number, maxAttempts = 30, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Build agent config from apteva agent data
// Note: POST /config expects flat structure WITHOUT "agent" wrapper
function buildAgentConfig(agent: Agent, providerKey: string) {
  const features = agent.features;

  // Get MCP server details for the agent's selected servers
  const mcpServers = (agent.mcp_servers || [])
    .map(id => McpServerDB.findById(id))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(s => {
      // For stdio-based servers (npm, github, custom with command), pass command config
      // so the agent container can spawn the process itself
      if (s.command) {
        // Parse command if it contains the executable + args as a string
        const cmdParts = s.command.split(/\s+/);
        const baseCommand = cmdParts;
        const extraArgs = s.args ? s.args.split(/\s+/) : [];
        return {
          name: s.name,
          type: "stdio" as const,
          command: [...baseCommand, ...extraArgs],
          env: s.env || {},
          enabled: true,
        };
      }
      // For HTTP-based servers, require them to be running in apteva
      if (s.status !== "running") {
        return null;
      }
      return {
        name: s.name,
        type: "http" as const,
        url: `http://localhost:${s.port}`,
        headers: {},
        enabled: true,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return {
    id: agent.id,
    name: agent.name,
    description: agent.system_prompt,
    llm: {
      provider: agent.provider,
      model: agent.model,
      max_tokens: 4000,
      temperature: 0.7,
      system_prompt: agent.system_prompt,
      vision: {
        enabled: features.vision,
        max_images: 20,
        max_image_size: 5242880,
        allowed_types: ["jpeg", "png", "gif", "webp"],
        resize_images: true,
        max_dimension: 1568,
        pdf: {
          enabled: features.vision,
          max_file_size: 33554432,
          max_pages: 100,
          allow_urls: true,
        },
      },
      parallel_tools: {
        enabled: true,
        max_concurrent: 10,
      },
    },
    tasks: {
      enabled: features.tasks,
      allow_scheduling: true,
      allow_recurring: true,
      max_tasks: 100,
      auto_execute: false,
    },
    scheduler: {
      enabled: features.tasks,
      interval: "1m",
      max_tasks: 100,
    },
    memory: {
      enabled: features.memory,
      embedding_model: "text-embedding-3-small",
      decision_model: "gpt-4o-mini",
      max_memories_per_query: 20,
      min_importance: 0.3,
      min_similarity: 0.3,
      auto_prune: true,
      max_memories: 10000,
      embedding_provider: "openai",
      auto_extract_memories: features.memory ? true : null,
      auto_ingest_files: true,
    },
    operator: {
      enabled: features.operator,
      virtual_browser: "http://localhost:8098",
      display_width: 1024,
      display_height: 768,
      max_actions_per_turn: 5,
    },
    mcp: {
      enabled: features.mcp,
      base_url: "http://localhost:3000/mcp",
      timeout: "30s",
      retry_count: 3,
      cache_ttl: "15m",
      servers: mcpServers,
    },
    realtime: {
      enabled: features.realtime,
      provider: "openai",
      model: "gpt-4o-realtime-preview",
      voice: "alloy",
    },
    context: {
      max_messages: 30,
      max_tokens: 0,
      keep_images: 5,
    },
    filesystem: {
      enabled: true,
      max_file_size: 10485760,
      max_total_size: 104857600,
      auto_extract: true,
      auto_cleanup: true,
      retention_days: 7,
    },
  };
}

// Push config to running agent
async function pushConfigToAgent(port: number, config: any): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { success: true };
    }
    const data = await res.json().catch(() => ({}));
    return { success: false, error: data.error || `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Transform DB agent to API response format (camelCase for frontend compatibility)
function toApiAgent(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    provider: agent.provider,
    systemPrompt: agent.system_prompt,
    status: agent.status,
    port: agent.port,
    features: agent.features,
    mcpServers: agent.mcp_servers,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

export async function handleApiRequest(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // GET /api/agents - List all agents
  if (path === "/api/agents" && method === "GET") {
    const agents = AgentDB.findAll();
    return json({ agents: agents.map(toApiAgent) });
  }

  // POST /api/agents - Create a new agent
  if (path === "/api/agents" && method === "POST") {
    try {
      const body = await req.json();
      const { name, model, provider, systemPrompt, features } = body;

      if (!name) {
        return json({ error: "Name is required" }, 400);
      }

      // Import DEFAULT_FEATURES from db.ts
      const { DEFAULT_FEATURES } = await import("../db");

      const agent = AgentDB.create({
        id: generateId(),
        name,
        model: model || "claude-sonnet-4-5",
        provider: provider || "anthropic",
        system_prompt: systemPrompt || "You are a helpful assistant.",
        features: features || DEFAULT_FEATURES,
        mcp_servers: body.mcpServers || [],
      });

      return json({ agent: toApiAgent(agent) }, 201);
    } catch (e) {
      console.error("Create agent error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/agents/:id - Get a specific agent
  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === "GET") {
    const agent = AgentDB.findById(agentMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }
    return json({ agent: toApiAgent(agent) });
  }

  // PUT /api/agents/:id - Update an agent
  if (agentMatch && method === "PUT") {
    const agent = AgentDB.findById(agentMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<Agent> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.model !== undefined) updates.model = body.model;
      if (body.provider !== undefined) updates.provider = body.provider;
      if (body.systemPrompt !== undefined) updates.system_prompt = body.systemPrompt;
      if (body.features !== undefined) updates.features = body.features;
      if (body.mcpServers !== undefined) updates.mcp_servers = body.mcpServers;

      const updated = AgentDB.update(agentMatch[1], updates);

      // If agent is running, push the new config
      if (updated && updated.status === "running" && updated.port) {
        const providerKey = ProviderKeys.getDecrypted(updated.provider);
        if (providerKey) {
          const config = buildAgentConfig(updated, providerKey);
          const configResult = await pushConfigToAgent(updated.port, config);
          if (!configResult.success) {
            console.error(`Failed to push config to running agent: ${configResult.error}`);
          }
        }
      }

      return json({ agent: updated ? toApiAgent(updated) : null });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/agents/:id - Delete an agent
  if (agentMatch && method === "DELETE") {
    const agent = AgentDB.findById(agentMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    // Stop the agent if running
    const proc = agentProcesses.get(agentMatch[1]);
    if (proc) {
      proc.kill();
      agentProcesses.delete(agentMatch[1]);
    }

    AgentDB.delete(agentMatch[1]);
    return json({ success: true });
  }

  // POST /api/agents/:id/start - Start an agent
  const startMatch = path.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (startMatch && method === "POST") {
    const agent = AgentDB.findById(startMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    // Check if binary exists
    if (!binaryExists(BIN_DIR)) {
      return json({ error: "Agent binary not available. The binary will be downloaded automatically when available, or you can set AGENT_BINARY_PATH environment variable." }, 400);
    }

    // Check if already running
    if (agentProcesses.has(agent.id)) {
      return json({ error: "Agent already running" }, 400);
    }

    // Get the API key for the agent's provider
    const providerKey = ProviderKeys.getDecrypted(agent.provider);
    if (!providerKey) {
      return json({ error: `No API key configured for provider: ${agent.provider}. Please add your API key in Settings.` }, 400);
    }

    // Get provider config for env var name
    const providerConfig = PROVIDERS[agent.provider as ProviderId];
    if (!providerConfig) {
      return json({ error: `Unknown provider: ${agent.provider}` }, 400);
    }

    // Assign port
    const port = getNextPort();

    // Spawn the agent binary
    try {
      // Create data directory for this agent
      const agentDataDir = join(AGENTS_DATA_DIR, agent.id);
      if (!existsSync(agentDataDir)) {
        mkdirSync(agentDataDir, { recursive: true });
      }

      console.log(`Starting agent ${agent.name} on port ${port}...`);
      console.log(`  Provider: ${agent.provider}`);
      console.log(`  Data dir: ${agentDataDir}`);

      // Build environment with provider key
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        PORT: String(port),
        DATA_DIR: agentDataDir,
        [providerConfig.envVar]: providerKey,
      };

      const proc = spawn({
        cmd: [BINARY_PATH],
        env,
        stdout: "ignore",
        stderr: "ignore",
      });

      agentProcesses.set(agent.id, proc);

      // Wait for agent to be healthy
      console.log(`  Waiting for agent to be ready...`);
      const isHealthy = await waitForAgentHealth(port);
      if (!isHealthy) {
        console.error(`  Agent failed to start (health check timeout)`);
        proc.kill();
        agentProcesses.delete(agent.id);
        return json({ error: "Agent failed to start (health check timeout)" }, 500);
      }

      // Push configuration to the agent
      console.log(`  Pushing configuration...`);
      const config = buildAgentConfig(agent, providerKey);
      const configResult = await pushConfigToAgent(port, config);
      if (!configResult.success) {
        console.error(`  Failed to configure agent: ${configResult.error}`);
        // Agent is running but not configured - still usable but log warning
      } else {
        console.log(`  Configuration applied successfully`);
      }

      // Update status in database
      const updated = AgentDB.setStatus(agent.id, "running", port);

      console.log(`Agent ${agent.name} started on port ${port} (pid: ${proc.pid})`);
      return json({ agent: updated ? toApiAgent(updated) : null, message: `Agent started on port ${port}` });
    } catch (err) {
      console.error(`Failed to start agent: ${err}`);
      return json({ error: `Failed to start agent: ${err}` }, 500);
    }
  }

  // POST /api/agents/:id/stop - Stop an agent
  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const agent = AgentDB.findById(stopMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const proc = agentProcesses.get(agent.id);
    if (proc) {
      console.log(`Stopping agent ${agent.name} (pid: ${proc.pid})...`);
      proc.kill();
      agentProcesses.delete(agent.id);
    }

    const updated = AgentDB.setStatus(agent.id, "stopped");
    return json({ agent: updated ? toApiAgent(updated) : null, message: "Agent stopped" });
  }

  // POST /api/agents/:id/chat - Proxy chat to agent binary with streaming
  const chatMatch = path.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (chatMatch && method === "POST") {
    const agent = AgentDB.findById(chatMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const body = await req.json();

      // Proxy to the agent's /chat endpoint
      const agentUrl = `http://localhost:${agent.port}/chat`;
      const response = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      // Stream the response back
      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      // Return streaming response with proper headers
      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (err) {
      console.error(`Chat proxy error: ${err}`);
      return json({ error: `Failed to proxy chat: ${err}` }, 500);
    }
  }

  // GET /api/providers - List supported providers and models with key status
  if (path === "/api/providers" && method === "GET") {
    const providers = getProvidersWithStatus();
    return json({ providers });
  }

  // ==================== ONBOARDING ====================

  // GET /api/onboarding/status - Check onboarding status
  if (path === "/api/onboarding/status" && method === "GET") {
    return json(Onboarding.getStatus());
  }

  // POST /api/onboarding/complete - Mark onboarding as complete
  if (path === "/api/onboarding/complete" && method === "POST") {
    Onboarding.complete();
    return json({ success: true });
  }

  // POST /api/onboarding/reset - Reset onboarding (for testing)
  if (path === "/api/onboarding/reset" && method === "POST") {
    Onboarding.reset();
    return json({ success: true });
  }

  // ==================== API KEYS ====================

  // GET /api/keys - List all configured provider keys (without actual keys)
  if (path === "/api/keys" && method === "GET") {
    return json({ keys: ProviderKeys.getAll() });
  }

  // POST /api/keys/:provider - Save an API key for a provider
  const saveKeyMatch = path.match(/^\/api\/keys\/([^/]+)$/);
  if (saveKeyMatch && method === "POST") {
    const providerId = saveKeyMatch[1];

    // Validate provider exists
    if (!PROVIDERS[providerId as ProviderId]) {
      return json({ error: "Unknown provider" }, 400);
    }

    try {
      const body = await req.json();
      const { key } = body;

      if (!key) {
        return json({ error: "API key is required" }, 400);
      }

      const result = await ProviderKeys.save(providerId, key);
      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      return json({ success: true, message: "API key saved successfully" });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/keys/:provider - Remove an API key
  if (saveKeyMatch && method === "DELETE") {
    const providerId = saveKeyMatch[1];
    const deleted = ProviderKeys.delete(providerId);
    return json({ success: deleted });
  }

  // POST /api/keys/:provider/test - Test an API key
  const testKeyMatch = path.match(/^\/api\/keys\/([^/]+)\/test$/);
  if (testKeyMatch && method === "POST") {
    const providerId = testKeyMatch[1];

    // Validate provider exists
    if (!PROVIDERS[providerId as ProviderId]) {
      return json({ error: "Unknown provider" }, 400);
    }

    try {
      const body = await req.json().catch(() => ({}));
      const { key } = body as { key?: string };

      // Test with provided key or stored key
      const result = await ProviderKeys.test(providerId, key);
      return json(result);
    } catch (e) {
      return json({ error: "Test failed" }, 500);
    }
  }

  // GET /api/stats - Get statistics
  if (path === "/api/stats" && method === "GET") {
    return json({
      totalAgents: AgentDB.count(),
      runningAgents: AgentDB.countRunning(),
    });
  }

  // GET /api/binary - Get binary status
  if (path === "/api/binary" && method === "GET") {
    return json(getBinaryStatus(BIN_DIR));
  }

  // GET /api/health - Health check
  if (path === "/api/health") {
    const binaryStatus = getBinaryStatus(BIN_DIR);
    return json({
      status: "ok",
      timestamp: new Date().toISOString(),
      agents: {
        total: AgentDB.count(),
        running: AgentDB.countRunning(),
      },
      binary: {
        available: binaryStatus.exists,
        platform: binaryStatus.platform,
        arch: binaryStatus.arch,
      }
    });
  }

  // ==================== TASKS ====================

  // Helper to fetch from a running agent
  async function fetchFromAgent(port: number, endpoint: string): Promise<any> {
    try {
      const response = await fetch(`http://localhost:${port}${endpoint}`, {
        headers: { "Accept": "application/json" },
      });
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch {
      return null;
    }
  }

  // GET /api/tasks - Get all tasks from all running agents
  if (path === "/api/tasks" && method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";

    const runningAgents = AgentDB.findAll().filter(a => a.status === "running" && a.port);
    const allTasks: any[] = [];

    for (const agent of runningAgents) {
      const data = await fetchFromAgent(agent.port!, `/tasks?status=${status}`);
      if (data?.tasks) {
        // Add agent info to each task
        for (const task of data.tasks) {
          allTasks.push({
            ...task,
            agentId: agent.id,
            agentName: agent.name,
          });
        }
      }
    }

    // Sort by created_at descending
    allTasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return json({ tasks: allTasks, count: allTasks.length });
  }

  // GET /api/agents/:id/tasks - Get tasks from a specific agent
  const agentTasksMatch = path.match(/^\/api\/agents\/([^/]+)\/tasks$/);
  if (agentTasksMatch && method === "GET") {
    const agentId = agentTasksMatch[1];
    const agent = AgentDB.findById(agentId);

    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";

    const data = await fetchFromAgent(agent.port, `/tasks?status=${status}`);
    if (!data) {
      return json({ error: "Failed to fetch tasks from agent" }, 500);
    }

    return json(data);
  }

  // GET /api/dashboard - Get dashboard statistics
  if (path === "/api/dashboard" && method === "GET") {
    const agents = AgentDB.findAll();
    const runningAgents = agents.filter(a => a.status === "running" && a.port);

    let totalTasks = 0;
    let pendingTasks = 0;
    let completedTasks = 0;
    let runningTasks = 0;

    for (const agent of runningAgents) {
      const data = await fetchFromAgent(agent.port!, "/tasks?status=all");
      if (data?.tasks) {
        totalTasks += data.tasks.length;
        for (const task of data.tasks) {
          if (task.status === "pending") pendingTasks++;
          else if (task.status === "completed") completedTasks++;
          else if (task.status === "running") runningTasks++;
        }
      }
    }

    return json({
      agents: {
        total: agents.length,
        running: runningAgents.length,
      },
      tasks: {
        total: totalTasks,
        pending: pendingTasks,
        running: runningTasks,
        completed: completedTasks,
      },
      providers: {
        configured: ProviderKeys.getConfiguredProviders().length,
      },
    });
  }

  // GET /api/version - Get current and latest version
  if (path === "/api/version" && method === "GET") {
    try {
      // Get current version from package.json
      const pkg = await import("../../package.json");
      const currentVersion = pkg.version;

      // Check npm registry for latest version
      let latestVersion = currentVersion;
      let updateAvailable = false;

      try {
        const response = await fetch("https://registry.npmjs.org/apteva/latest", {
          headers: { "Accept": "application/json" },
        });
        if (response.ok) {
          const data = await response.json();
          latestVersion = data.version;
          updateAvailable = latestVersion !== currentVersion;
        }
      } catch {
        // Failed to check, assume current is latest
      }

      return json({
        current: currentVersion,
        latest: latestVersion,
        updateAvailable,
        updateCommand: "npm update -g apteva",
      });
    } catch {
      return json({ error: "Failed to check version" }, 500);
    }
  }

  // ============ MCP Server API ============

  // GET /api/mcp/servers - List all MCP servers
  if (path === "/api/mcp/servers" && method === "GET") {
    const servers = McpServerDB.findAll();
    return json({ servers });
  }

  // POST /api/mcp/servers - Create/install a new MCP server
  if (path === "/api/mcp/servers" && method === "POST") {
    try {
      const body = await req.json();
      const { name, type, package: pkg, command, args, env } = body;

      if (!name) {
        return json({ error: "Name is required" }, 400);
      }

      const server = McpServerDB.create({
        id: generateId(),
        name,
        type: type || "npm",
        package: pkg || null,
        command: command || null,
        args: args || null,
        env: env || {},
      });

      return json({ server }, 201);
    } catch (e) {
      console.error("Create MCP server error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/mcp/servers/:id - Get a specific MCP server
  const mcpServerMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (mcpServerMatch && method === "GET") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }
    return json({ server });
  }

  // PUT /api/mcp/servers/:id - Update an MCP server
  if (mcpServerMatch && method === "PUT") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<McpServer> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.type !== undefined) updates.type = body.type;
      if (body.package !== undefined) updates.package = body.package;
      if (body.command !== undefined) updates.command = body.command;
      if (body.args !== undefined) updates.args = body.args;
      if (body.env !== undefined) updates.env = body.env;

      const updated = McpServerDB.update(mcpServerMatch[1], updates);
      return json({ server: updated });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/mcp/servers/:id - Delete an MCP server
  if (mcpServerMatch && method === "DELETE") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Stop if running
    if (server.status === "running") {
      // TODO: Stop the server process
    }

    McpServerDB.delete(mcpServerMatch[1]);
    return json({ success: true });
  }

  // POST /api/mcp/servers/:id/start - Start an MCP server
  const mcpStartMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
  if (mcpStartMatch && method === "POST") {
    const server = McpServerDB.findById(mcpStartMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    if (server.status === "running") {
      return json({ error: "MCP server already running" }, 400);
    }

    // Determine command to run
    let cmd: string[];
    if (server.command) {
      // Custom command
      cmd = server.command.split(" ");
      if (server.args) {
        cmd.push(...server.args.split(" "));
      }
    } else if (server.package) {
      // npm package - use npx
      cmd = ["npx", "-y", server.package];
      if (server.args) {
        cmd.push(...server.args.split(" "));
      }
    } else {
      return json({ error: "No command or package specified" }, 400);
    }

    console.log(`Starting MCP server ${server.name}...`);
    console.log(`  Command: ${cmd.join(" ")}`);

    // Start the MCP process with stdio pipes
    const result = await startMcpProcess(server.id, cmd, server.env || {});

    if (!result.success) {
      console.error(`Failed to start MCP server: ${result.error}`);
      return json({ error: `Failed to start: ${result.error}` }, 500);
    }

    // Update status (port is now just for display, stdio is used for communication)
    const port = getNextPort(); // Just for identification
    const updated = McpServerDB.setStatus(server.id, "running", port);

    return json({ server: updated, message: "MCP server started" });
  }

  // POST /api/mcp/servers/:id/stop - Stop an MCP server
  const mcpStopMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
  if (mcpStopMatch && method === "POST") {
    const server = McpServerDB.findById(mcpStopMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Stop the MCP process
    stopMcpProcess(server.id);

    const updated = McpServerDB.setStatus(server.id, "stopped");
    return json({ server: updated, message: "MCP server stopped" });
  }

  // GET /api/mcp/servers/:id/tools - List tools from an MCP server
  const mcpToolsMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (mcpToolsMatch && method === "GET") {
    const server = McpServerDB.findById(mcpToolsMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Check if process is running
    const mcpProcess = getMcpProcess(server.id);
    if (!mcpProcess) {
      return json({ error: "MCP server is not running" }, 400);
    }

    try {
      const serverInfo = await initializeMcpServer(server.id);
      const tools = await listMcpTools(server.id);

      return json({
        serverInfo,
        tools,
      });
    } catch (err) {
      console.error(`Failed to list MCP tools: ${err}`);
      return json({ error: `Failed to communicate with MCP server: ${err}` }, 500);
    }
  }

  // POST /api/mcp/servers/:id/tools/:toolName/call - Call a tool on an MCP server
  const mcpToolCallMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/([^/]+)\/call$/);
  if (mcpToolCallMatch && method === "POST") {
    const server = McpServerDB.findById(mcpToolCallMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Check if process is running
    const mcpProcess = getMcpProcess(server.id);
    if (!mcpProcess) {
      return json({ error: "MCP server is not running" }, 400);
    }

    const toolName = decodeURIComponent(mcpToolCallMatch[2]);

    try {
      const body = await req.json();
      const args = body.arguments || {};

      const result = await callMcpTool(server.id, toolName, args);

      return json({ result });
    } catch (err) {
      console.error(`Failed to call MCP tool: ${err}`);
      return json({ error: `Failed to call tool: ${err}` }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}
