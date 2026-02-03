import { spawn } from "bun";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, rmSync } from "fs";
import { agentProcesses, agentsStarting, BINARY_PATH, getNextPort, getBinaryStatus, BIN_DIR, telemetryBroadcaster, type TelemetryEvent } from "../server";
import { AgentDB, McpServerDB, TelemetryDB, UserDB, ProjectDB, SkillDB, generateId, getMultiAgentConfig, type Agent, type AgentFeatures, type McpServer, type Project, type Skill } from "../db";
import { ProviderKeys, Onboarding, getProvidersWithStatus, PROVIDERS, type ProviderId } from "../providers";
import { createUser, hashPassword, validatePassword } from "../auth";
import type { AuthContext } from "../auth/middleware";
import {
  binaryExists,
  checkForUpdates,
  getInstalledVersion,
  getAptevaVersion,
  downloadLatestBinary,
  installViaNpm,
} from "../binary";
import {
  startMcpProcess,
  stopMcpProcess,
  initializeMcpServer,
  listMcpTools,
  callMcpTool,
  getMcpProcess,
  getMcpProxyUrl,
  getHttpMcpClient,
} from "../mcp-client";
import { openApiSpec } from "../openapi";
import { getProvider, getProviderIds, registerProvider } from "../integrations";
import { ComposioProvider } from "../integrations/composio";
import { SkillsmpProvider, parseSkillMd, type SkillsmpSkill } from "../integrations/skillsmp";

// Register integration providers
registerProvider(ComposioProvider);

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

const isDev = process.env.NODE_ENV !== "production";
function debug(...args: unknown[]) {
  if (isDev) console.log("[api]", ...args);
}

// Wait for agent to be healthy (with timeout)
// Note: /health endpoint is whitelisted in agent, no auth needed
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

// Check if a port is free by trying to connect
async function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => {
      resolve(false); // Port in use
    });
    server.once("listening", () => {
      server.close();
      resolve(true); // Port is free
    });
    server.listen(port, "127.0.0.1");
  });
}

// Make authenticated request to agent
async function agentFetch(
  agentId: string,
  port: number,
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const apiKey = AgentDB.getApiKey(agentId);
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  return fetch(`http://localhost:${port}${endpoint}`, {
    ...options,
    headers,
  });
}

// Build agent config from apteva agent data
// Note: POST /config expects flat structure WITHOUT "agent" wrapper
function buildAgentConfig(agent: Agent, providerKey: string) {
  const features = agent.features;

  // Get MCP server details for the agent's selected servers
  const mcpServers: Array<{ name: string; type: "http"; url: string; headers: Record<string, string>; enabled: boolean }> = [];

  // Get skill definitions for the agent's selected skills
  const skillDefinitions: Array<{
    name: string;
    description: string;
    instructions: string;
    icon: string;
    category: string;
    tags: string[];
    tools: string[];
    enabled: boolean;
  }> = [];

  for (const skillId of agent.skills || []) {
    const skill = SkillDB.findById(skillId);
    if (!skill || !skill.enabled) continue;

    skillDefinitions.push({
      name: skill.name,
      description: skill.description,
      instructions: skill.content,
      icon: "",
      category: "",
      tags: [],
      tools: skill.allowed_tools || [],
      enabled: true,
    });
  }

  for (const id of agent.mcp_servers || []) {
    const server = McpServerDB.findById(id);
    if (!server) continue;

    if (server.type === "http" && server.url) {
      // Remote HTTP server (Composio, Smithery, or custom)
      mcpServers.push({
        name: server.name,
        type: "http",
        url: server.url,
        headers: server.headers || {},
        enabled: true,
      });
    } else if (server.status === "running" && server.port) {
      // Local MCP server (npm, github, custom)
      mcpServers.push({
        name: server.name,
        type: "http",
        url: `http://localhost:${server.port}/mcp`,
        headers: {},
        enabled: true,
      });
    }
  }

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
      tools: [], // Clear any old tool whitelist - agent uses all registered tools
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
    telemetry: {
      enabled: true,
      endpoint: `http://localhost:${process.env.PORT || 4280}/api/telemetry`,
      batch_size: 1,
      flush_interval: 1, // Every 1 second
      categories: [], // Empty = all categories
    },
    skills: {
      enabled: skillDefinitions.length > 0,
      definitions: skillDefinitions,
    },
    agents: (() => {
      const multiAgentConfig = getMultiAgentConfig(features, agent.project_id);
      const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4280}`;
      return {
        enabled: multiAgentConfig.enabled,
        mode: multiAgentConfig.mode || "worker",
        group: multiAgentConfig.group || agent.project_id || undefined,
        // This agent's reachable URL for peer communication
        url: `http://localhost:${agent.port}`,
        // Discovery endpoint to find peer agents in the same group
        discovery_url: `${baseUrl}/api/discovery/agents`,
      };
    })(),
  };
}

// Push config to running agent
// Push config to running agent (with authentication)
async function pushConfigToAgent(agentId: string, port: number, config: any): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await agentFetch(agentId, port, "/config", {
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

// Push skills to running agent via /skills endpoint (not config)
async function pushSkillsToAgent(agentId: string, port: number, skills: Array<{
  name: string;
  description: string;
  instructions: string;
  icon?: string;
  category?: string;
  tags?: string[];
  tools?: string[];
  enabled: boolean;
}>): Promise<{ success: boolean; error?: string }> {
  if (skills.length === 0) {
    return { success: true };
  }

  try {
    // Push each skill - try PUT first (update), then POST (create) if not found
    for (const skill of skills) {
      // First try PUT to update existing skill
      let res = await agentFetch(agentId, port, "/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skill),
        signal: AbortSignal.timeout(5000),
      });

      // If skill doesn't exist (404), create it with POST
      if (res.status === 404) {
        res = await agentFetch(agentId, port, "/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skill),
          signal: AbortSignal.timeout(5000),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error(`[pushSkillsToAgent] Failed to push skill ${skill.name}:`, data.error || res.status);
      }
    }

    // Enable skills globally via POST /skills/status
    const statusRes = await agentFetch(agentId, port, "/skills/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
      signal: AbortSignal.timeout(5000),
    });

    if (!statusRes.ok) {
      const data = await statusRes.json().catch(() => ({}));
      return { success: false, error: data.error || `HTTP ${statusRes.status}` };
    }

    console.log(`[pushSkillsToAgent] Pushed ${skills.length} skill(s) to agent`);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Exported helper to start an agent process (used by API route and auto-restart)
export async function startAgentProcess(
  agent: Agent,
  options: { silent?: boolean; cleanData?: boolean } = {}
): Promise<{ success: boolean; port?: number; error?: string }> {
  const { silent = false, cleanData = false } = options;

  // Check if binary exists
  if (!binaryExists(BIN_DIR)) {
    return { success: false, error: "Agent binary not available" };
  }

  // Check if already running (process map)
  if (agentProcesses.has(agent.id)) {
    return { success: false, error: "Agent already running" };
  }

  // Check if already being started (race condition prevention)
  if (agentsStarting.has(agent.id)) {
    return { success: false, error: "Agent is already starting" };
  }

  // Mark as starting
  agentsStarting.add(agent.id);

  // Get the API key for the agent's provider
  const providerKey = ProviderKeys.getDecrypted(agent.provider);
  if (!providerKey) {
    agentsStarting.delete(agent.id);
    return { success: false, error: `No API key for provider: ${agent.provider}` };
  }

  // Get provider config for env var name
  const providerConfig = PROVIDERS[agent.provider as ProviderId];
  if (!providerConfig) {
    agentsStarting.delete(agent.id);
    return { success: false, error: `Unknown provider: ${agent.provider}` };
  }

  // Use agent's permanently assigned port
  const port = agent.port;
  if (!port) {
    agentsStarting.delete(agent.id);
    return { success: false, error: "Agent has no assigned port" };
  }

  // Get or create API key for the agent
  const agentApiKey = AgentDB.ensureApiKey(agent.id);
  if (!agentApiKey) {
    agentsStarting.delete(agent.id);
    return { success: false, error: "Failed to get/create agent API key" };
  }

  try {
    // Check if something is already running on this port (orphaned process)
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        // Something is running - try to shut it down
        if (!silent) {
          console.log(`  Port ${port} in use, stopping orphaned process...`);
        }
        try {
          await fetch(`http://localhost:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) });
        } catch {
          // Shutdown failed - process might not support it
        }
        // Wait longer for port to be released
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch {
      // No HTTP response - but port might still be bound by zombie process
    }

    // Double-check port is actually free by trying to connect
    const isPortFree = await checkPortFree(port);
    if (!isPortFree) {
      if (!silent) {
        console.log(`  Port ${port} still in use, trying to kill process...`);
      }
      // Try to kill process using the port (Linux/Mac)
      try {
        const { execSync } = await import("child_process");
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
        await new Promise(r => setTimeout(r, 1000));
      } catch {
        // Ignore errors
      }

      // Final check
      const stillInUse = !(await checkPortFree(port));
      if (stillInUse) {
        agentsStarting.delete(agent.id);
        return { success: false, error: `Port ${port} is still in use` };
      }
    }

    // Handle data directory
    const agentDataDir = join(AGENTS_DATA_DIR, agent.id);
    if (cleanData && existsSync(agentDataDir)) {
      // Clean old data if requested
      rmSync(agentDataDir, { recursive: true, force: true });
      if (!silent) {
        console.log(`  Cleaned old data directory`);
      }
    }
    if (!existsSync(agentDataDir)) {
      mkdirSync(agentDataDir, { recursive: true });
    }

    if (!silent) {
      console.log(`Starting agent ${agent.name} on port ${port}...`);
      console.log(`  Provider: ${agent.provider}`);
      console.log(`  Data dir: ${agentDataDir}`);
    }

    // Build environment with provider key and agent API key
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(port),
      DATA_DIR: agentDataDir,
      AGENT_API_KEY: agentApiKey,
      [providerConfig.envVar]: providerKey,
    };

    const proc = spawn({
      cmd: [BINARY_PATH],
      env,
      stdout: "inherit",
      stderr: "inherit",
    });

    // Store process with port for tracking
    agentProcesses.set(agent.id, { proc, port });

    // Wait for agent to be healthy
    if (!silent) {
      console.log(`  Waiting for agent to be ready...`);
    }
    const isHealthy = await waitForAgentHealth(port);
    if (!isHealthy) {
      if (!silent) {
        console.error(`  Agent failed to start (health check timeout)`);
      }
      proc.kill();
      agentProcesses.delete(agent.id);
      agentsStarting.delete(agent.id);
      return { success: false, error: "Health check timeout" };
    }

    // Push configuration to the agent
    if (!silent) {
      console.log(`  Pushing configuration...`);
    }
    const config = buildAgentConfig(agent, providerKey);
    const configResult = await pushConfigToAgent(agent.id, port, config);
    if (!configResult.success) {
      if (!silent) {
        console.error(`  Failed to configure agent: ${configResult.error}`);
      }
      // Agent is running but not configured - still usable but log warning
    } else if (!silent) {
      console.log(`  Configuration applied successfully`);
    }

    // Push skills via /skills endpoint (separate from config)
    if (config.skills?.definitions?.length > 0) {
      const skillsResult = await pushSkillsToAgent(agent.id, port, config.skills.definitions);
      if (!skillsResult.success && !silent) {
        console.error(`  Failed to push skills: ${skillsResult.error}`);
      } else if (!silent) {
        console.log(`  Skills pushed successfully (${config.skills.definitions.length} skills)`);
      }
    }

    // Update status in database (port is already set, just update status)
    AgentDB.setStatus(agent.id, "running");

    if (!silent) {
      console.log(`Agent ${agent.name} started on port ${port} (pid: ${proc.pid})`);
    }

    agentsStarting.delete(agent.id);
    return { success: true, port };
  } catch (err) {
    agentsStarting.delete(agent.id);
    if (!silent) {
      console.error(`Failed to start agent: ${err}`);
    }
    return { success: false, error: String(err) };
  }
}

// Transform DB agent to API response format (camelCase for frontend compatibility)
function toApiAgent(agent: Agent) {
  // Look up MCP server details
  const mcpServerDetails = (agent.mcp_servers || [])
    .map(id => McpServerDB.findById(id))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      status: s.status,
      port: s.port,
      url: s.url, // Include URL for HTTP servers
    }));

  // Look up skill details
  const skillDetails = (agent.skills || [])
    .map(id => SkillDB.findById(id))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      enabled: s.enabled,
    }));

  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    provider: agent.provider,
    systemPrompt: agent.system_prompt,
    status: agent.status,
    port: agent.port,
    features: agent.features,
    mcpServers: agent.mcp_servers, // Keep IDs for backwards compatibility
    mcpServerDetails, // Include full details
    skills: agent.skills, // Skill IDs
    skillDetails, // Include full details
    projectId: agent.project_id,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

// Transform DB project to API response format
function toApiProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    color: project.color,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

export async function handleApiRequest(req: Request, path: string, authContext?: AuthContext): Promise<Response> {
  const method = req.method;
  const user = authContext?.user;

  // GET /api/health - Health check endpoint (no auth required, handled before middleware in server.ts)
  if (path === "/api/health" && method === "GET") {
    const agentCount = AgentDB.count();
    const runningAgents = AgentDB.findRunning().length;
    return json({
      status: "ok",
      version: getAptevaVersion(),
      agents: { total: agentCount, running: runningAgents },
    });
  }

  // GET /api/openapi - OpenAPI spec (no auth required)
  if (path === "/api/openapi" && method === "GET") {
    return json(openApiSpec);
  }

  // GET /api/agents - List all agents
  if (path === "/api/agents" && method === "GET") {
    const agents = AgentDB.findAll();
    return json({ agents: agents.map(toApiAgent) });
  }

  // POST /api/agents - Create a new agent
  if (path === "/api/agents" && method === "POST") {
    try {
      const body = await req.json();
      const { name, model, provider, systemPrompt, features, projectId } = body;

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
        skills: body.skills || [],
        project_id: projectId || null,
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

  // GET /api/agents/:id/api-key - Get agent API key (dev mode only)
  const agentApiKeyMatch = path.match(/^\/api\/agents\/([^/]+)\/api-key$/);
  if (agentApiKeyMatch && method === "GET") {
    if (!isDev) {
      return json({ error: "Only available in development mode" }, 403);
    }
    const agent = AgentDB.findById(agentApiKeyMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }
    const apiKey = AgentDB.getApiKey(agent.id);
    return json({ apiKey });
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
      if (body.skills !== undefined) updates.skills = body.skills;
      if (body.projectId !== undefined) updates.project_id = body.projectId;

      const updated = AgentDB.update(agentMatch[1], updates);

      // If agent is running, push the new config and skills
      if (updated && updated.status === "running" && updated.port) {
        const providerKey = ProviderKeys.getDecrypted(updated.provider);
        if (providerKey) {
          const config = buildAgentConfig(updated, providerKey);
          const configResult = await pushConfigToAgent(updated.id, updated.port, config);
          if (!configResult.success) {
            console.error(`Failed to push config to running agent: ${configResult.error}`);
          }
          // Push skills via /skills endpoint
          if (config.skills?.definitions?.length > 0) {
            const skillsResult = await pushSkillsToAgent(updated.id, updated.port, config.skills.definitions);
            if (!skillsResult.success) {
              console.error(`Failed to push skills to running agent: ${skillsResult.error}`);
            }
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
    const agentId = agentMatch[1];
    const agent = AgentDB.findById(agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    // Stop the agent if running
    const agentProc = agentProcesses.get(agentId);
    if (agentProc) {
      agentProc.proc.kill();
      agentProcesses.delete(agentId);
    }

    // Delete agent's telemetry data
    TelemetryDB.deleteByAgent(agentId);

    // Delete agent's data directory (contains threads, messages, etc.)
    const agentDataDir = join(AGENTS_DATA_DIR, agentId);
    if (existsSync(agentDataDir)) {
      try {
        rmSync(agentDataDir, { recursive: true, force: true });
        console.log(`Deleted agent data directory: ${agentDataDir}`);
      } catch (err) {
        console.error(`Failed to delete agent data directory: ${err}`);
      }
    }

    AgentDB.delete(agentId);
    return json({ success: true });
  }

  // GET /api/agents/:id/api-key - Get the agent's API key (masked)
  const apiKeyGetMatch = path.match(/^\/api\/agents\/([^/]+)\/api-key$/);
  if (apiKeyGetMatch && method === "GET") {
    const agent = AgentDB.findById(apiKeyGetMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const apiKey = AgentDB.getApiKey(agent.id);
    if (!apiKey) {
      return json({ error: "No API key found for this agent" }, 404);
    }

    // Return masked key (show only first 8 chars)
    const masked = apiKey.substring(0, 8) + "..." + apiKey.substring(apiKey.length - 4);
    return json({
      apiKey: masked,
      hasKey: true,
    });
  }

  // POST /api/agents/:id/api-key - Regenerate the agent's API key
  if (apiKeyGetMatch && method === "POST") {
    const agent = AgentDB.findById(apiKeyGetMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const newKey = AgentDB.regenerateApiKey(agent.id);
    if (!newKey) {
      return json({ error: "Failed to regenerate API key" }, 500);
    }

    // Return the full new key (only time it's fully visible)
    return json({
      apiKey: newKey,
      message: "API key regenerated. This is the only time the full key will be shown.",
    });
  }

  // POST /api/agents/:id/start - Start an agent
  const startMatch = path.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (startMatch && method === "POST") {
    const agent = AgentDB.findById(startMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const result = await startAgentProcess(agent);
    if (!result.success) {
      return json({ error: result.error }, 400);
    }

    const updated = AgentDB.findById(agent.id);
    return json({ agent: updated ? toApiAgent(updated) : null, message: `Agent started on port ${result.port}` });
  }

  // POST /api/agents/:id/stop - Stop an agent
  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const agent = AgentDB.findById(stopMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const agentProc = agentProcesses.get(agent.id);
    if (agentProc) {
      console.log(`Stopping agent ${agent.name} (pid: ${agentProc.proc.pid})...`);
      agentProc.proc.kill();
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

      // Proxy to the agent's /chat endpoint with authentication
      const response = await agentFetch(agent.id, agent.port, "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  // ==================== THREAD & MESSAGE PROXY ====================

  // GET /api/agents/:id/threads - List threads for an agent
  const threadsListMatch = path.match(/^\/api\/agents\/([^/]+)\/threads$/);
  if (threadsListMatch && method === "GET") {
    const agent = AgentDB.findById(threadsListMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const response = await agentFetch(agent.id, agent.port, "/threads", {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Threads list proxy error: ${err}`);
      return json({ error: `Failed to fetch threads: ${err}` }, 500);
    }
  }

  // POST /api/agents/:id/threads - Create a new thread
  if (threadsListMatch && method === "POST") {
    const agent = AgentDB.findById(threadsListMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const body = await req.json().catch(() => ({}));
      const response = await agentFetch(agent.id, agent.port, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data, 201);
    } catch (err) {
      console.error(`Thread create proxy error: ${err}`);
      return json({ error: `Failed to create thread: ${err}` }, 500);
    }
  }

  // GET /api/agents/:id/threads/:threadId - Get a specific thread
  const threadDetailMatch = path.match(/^\/api\/agents\/([^/]+)\/threads\/([^/]+)$/);
  if (threadDetailMatch && method === "GET") {
    const agent = AgentDB.findById(threadDetailMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const threadId = threadDetailMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/threads/${threadId}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Thread detail proxy error: ${err}`);
      return json({ error: `Failed to fetch thread: ${err}` }, 500);
    }
  }

  // DELETE /api/agents/:id/threads/:threadId - Delete a thread
  if (threadDetailMatch && method === "DELETE") {
    const agent = AgentDB.findById(threadDetailMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const threadId = threadDetailMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/threads/${threadId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      return json({ success: true });
    } catch (err) {
      console.error(`Thread delete proxy error: ${err}`);
      return json({ error: `Failed to delete thread: ${err}` }, 500);
    }
  }

  // GET /api/agents/:id/threads/:threadId/messages - Get messages in a thread
  const threadMessagesMatch = path.match(/^\/api\/agents\/([^/]+)\/threads\/([^/]+)\/messages$/);
  if (threadMessagesMatch && method === "GET") {
    const agent = AgentDB.findById(threadMessagesMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const threadId = threadMessagesMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/threads/${threadId}/messages`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Thread messages proxy error: ${err}`);
      return json({ error: `Failed to fetch messages: ${err}` }, 500);
    }
  }

  // ==================== MEMORY PROXY ====================

  // GET /api/agents/:id/memories - List memories for an agent
  const memoriesMatch = path.match(/^\/api\/agents\/([^/]+)\/memories$/);
  if (memoriesMatch && method === "GET") {
    const agent = AgentDB.findById(memoriesMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const url = new URL(req.url);
      const threadId = url.searchParams.get("thread_id") || "";
      const endpoint = `/memories${threadId ? `?thread_id=${threadId}` : ""}`;
      const response = await agentFetch(agent.id, agent.port, endpoint, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Memories list proxy error: ${err}`);
      return json({ error: `Failed to fetch memories: ${err}` }, 500);
    }
  }

  // DELETE /api/agents/:id/memories - Clear all memories for an agent
  if (memoriesMatch && method === "DELETE") {
    const agent = AgentDB.findById(memoriesMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const response = await agentFetch(agent.id, agent.port, "/memories", { method: "DELETE" });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      return json({ success: true });
    } catch (err) {
      console.error(`Memories clear proxy error: ${err}`);
      return json({ error: `Failed to clear memories: ${err}` }, 500);
    }
  }

  // DELETE /api/agents/:id/memories/:memoryId - Delete a specific memory
  const memoryDeleteMatch = path.match(/^\/api\/agents\/([^/]+)\/memories\/([^/]+)$/);
  if (memoryDeleteMatch && method === "DELETE") {
    const agent = AgentDB.findById(memoryDeleteMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const memoryId = memoryDeleteMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/memories/${memoryId}`, { method: "DELETE" });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      return json({ success: true });
    } catch (err) {
      console.error(`Memory delete proxy error: ${err}`);
      return json({ error: `Failed to delete memory: ${err}` }, 500);
    }
  }

  // ==================== FILES PROXY ====================

  // GET /api/agents/:id/files - List files for an agent
  const filesMatch = path.match(/^\/api\/agents\/([^/]+)\/files$/);
  if (filesMatch && method === "GET") {
    const agent = AgentDB.findById(filesMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const url = new URL(req.url);
      const params = new URLSearchParams();
      if (url.searchParams.get("thread_id")) params.set("thread_id", url.searchParams.get("thread_id")!);
      if (url.searchParams.get("limit")) params.set("limit", url.searchParams.get("limit")!);

      const endpoint = `/files${params.toString() ? `?${params}` : ""}`;
      const response = await agentFetch(agent.id, agent.port, endpoint, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Files list proxy error: ${err}`);
      return json({ error: `Failed to fetch files: ${err}` }, 500);
    }
  }

  // GET /api/agents/:id/files/:fileId - Get a specific file
  const fileGetMatch = path.match(/^\/api\/agents\/([^/]+)\/files\/([^/]+)$/);
  if (fileGetMatch && method === "GET") {
    const agent = AgentDB.findById(fileGetMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const fileId = fileGetMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/files/${fileId}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`File get proxy error: ${err}`);
      return json({ error: `Failed to fetch file: ${err}` }, 500);
    }
  }

  // DELETE /api/agents/:id/files/:fileId - Delete a specific file
  if (fileGetMatch && method === "DELETE") {
    const agent = AgentDB.findById(fileGetMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const fileId = fileGetMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/files/${fileId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      return json({ success: true });
    } catch (err) {
      console.error(`File delete proxy error: ${err}`);
      return json({ error: `Failed to delete file: ${err}` }, 500);
    }
  }

  // GET /api/agents/:id/files/:fileId/download - Download a file
  const fileDownloadMatch = path.match(/^\/api\/agents\/([^/]+)\/files\/([^/]+)\/download$/);
  if (fileDownloadMatch && method === "GET") {
    const agent = AgentDB.findById(fileDownloadMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const fileId = fileDownloadMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/files/${fileId}/download`);

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      // Pass through the file response
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
          "Content-Disposition": response.headers.get("Content-Disposition") || "attachment",
          "Content-Length": response.headers.get("Content-Length") || "",
        },
      });
    } catch (err) {
      console.error(`File download proxy error: ${err}`);
      return json({ error: `Failed to download file: ${err}` }, 500);
    }
  }

  // ==================== DISCOVERY/PEERS PROXY ====================

  // GET /api/discovery/agents - Central discovery endpoint for agents to find peers
  // Called by agent binaries to discover other agents in the same group
  if (path === "/api/discovery/agents" && method === "GET") {
    const group = url.searchParams.get("group");
    const excludeId = url.searchParams.get("exclude") || req.headers.get("X-Agent-ID");

    // Find all running agents in the same group
    const allAgents = AgentDB.findAll();
    const peers = allAgents
      .filter(a => {
        // Must be running with a port
        if (a.status !== "running" || !a.port) return false;
        // Exclude the requesting agent
        if (excludeId && a.id === excludeId) return false;
        // Must have multi-agent enabled
        const agentConfig = getMultiAgentConfig(a.features, a.project_id);
        if (!agentConfig.enabled) return false;
        // If group specified, must match
        if (group) {
          const peerGroup = agentConfig.group || a.project_id;
          if (peerGroup !== group) return false;
        }
        return true;
      })
      .map(a => {
        const agentConfig = getMultiAgentConfig(a.features, a.project_id);
        return {
          id: a.id,
          name: a.name,
          url: `http://localhost:${a.port}`,
          mode: agentConfig.mode || "worker",
          group: agentConfig.group || a.project_id,
        };
      });

    return json({ agents: peers });
  }

  // GET /api/agents/:id/peers - Get discovered peer agents
  const peersMatch = path.match(/^\/api\/agents\/([^/]+)\/peers$/);
  if (peersMatch && method === "GET") {
    const agent = AgentDB.findById(peersMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const response = await agentFetch(agent.id, agent.port, "/discovery/agents", {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }

      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`Peers list proxy error: ${err}`);
      return json({ error: `Failed to fetch peers: ${err}` }, 500);
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

  // POST /api/onboarding/user - Create first user during onboarding
  // This endpoint only works when no users exist (enforced by middleware)
  if (path === "/api/onboarding/user" && method === "POST") {
    debug("POST /api/onboarding/user");
    // Double-check no users exist
    if (UserDB.hasUsers()) {
      debug("Users already exist");
      return json({ error: "Users already exist" }, 403);
    }

    try {
      const body = await req.json();
      debug("Onboarding body:", JSON.stringify(body));
      const { username, password, email } = body;

      if (!username || !password) {
        debug("Missing username or password");
        return json({ error: "Username and password are required" }, 400);
      }

      // Create first user as admin
      debug("Creating user:", username);
      const result = await createUser({
        username,
        password,
        email: email || undefined, // Optional, for password recovery
        role: "admin",
      });
      debug("Create user result:", result.success, result.error);

      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      return json({
        success: true,
        user: {
          id: result.user!.id,
          username: result.user!.username,
          role: result.user!.role,
        },
      }, 201);
    } catch (e) {
      debug("Onboarding error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // ==================== USER MANAGEMENT (Admin only) ====================

  // GET /api/users - List all users
  if (path === "/api/users" && method === "GET") {
    const users = UserDB.findAll().map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    }));
    return json({ users });
  }

  // POST /api/users - Create a new user
  if (path === "/api/users" && method === "POST") {
    try {
      const body = await req.json();
      const { username, password, email, role } = body;

      if (!username || !password) {
        return json({ error: "Username and password are required" }, 400);
      }

      const result = await createUser({
        username,
        password,
        email: email || undefined,
        role: role || "user",
      });

      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      return json({
        user: {
          id: result.user!.id,
          username: result.user!.username,
          email: result.user!.email,
          role: result.user!.role,
          createdAt: result.user!.created_at,
        },
      }, 201);
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/users/:id - Get a specific user
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }
    return json({
      user: {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role,
        createdAt: targetUser.created_at,
        lastLoginAt: targetUser.last_login_at,
      },
    });
  }

  // PUT /api/users/:id - Update a user
  if (userMatch && method === "PUT") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Parameters<typeof UserDB.update>[1] = {};

      if (body.email !== undefined) updates.email = body.email;
      if (body.role !== undefined) {
        // Prevent removing last admin
        if (targetUser.role === "admin" && body.role !== "admin") {
          if (UserDB.countAdmins() <= 1) {
            return json({ error: "Cannot remove the last admin" }, 400);
          }
        }
        updates.role = body.role;
      }
      if (body.password !== undefined) {
        const validation = validatePassword(body.password);
        if (!validation.valid) {
          return json({ error: validation.errors.join(". ") }, 400);
        }
        updates.password_hash = await hashPassword(body.password);
      }

      const updated = UserDB.update(userMatch[1], updates);
      return json({
        user: updated ? {
          id: updated.id,
          username: updated.username,
          email: updated.email,
          role: updated.role,
          createdAt: updated.created_at,
          lastLoginAt: updated.last_login_at,
        } : null,
      });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/users/:id - Delete a user
  if (userMatch && method === "DELETE") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }

    // Prevent deleting yourself
    if (user && targetUser.id === user.id) {
      return json({ error: "Cannot delete your own account" }, 400);
    }

    // Prevent deleting last admin
    if (targetUser.role === "admin" && UserDB.countAdmins() <= 1) {
      return json({ error: "Cannot delete the last admin" }, 400);
    }

    UserDB.delete(userMatch[1]);
    return json({ success: true });
  }

  // ==================== PROJECTS ====================

  // GET /api/projects - List all projects
  if (path === "/api/projects" && method === "GET") {
    const projects = ProjectDB.findAll();
    const agentCounts = ProjectDB.getAgentCounts();
    return json({
      projects: projects.map(p => ({
        ...toApiProject(p),
        agentCount: agentCounts.get(p.id) || 0,
      })),
      unassignedCount: agentCounts.get(null) || 0,
    });
  }

  // POST /api/projects - Create a new project
  if (path === "/api/projects" && method === "POST") {
    try {
      const body = await req.json();
      const { name, description, color } = body;

      if (!name) {
        return json({ error: "Name is required" }, 400);
      }

      const project = ProjectDB.create({
        name,
        description: description || null,
        color: color || "#6366f1",
      });

      return json({ project: toApiProject(project) }, 201);
    } catch (e) {
      console.error("Create project error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/projects/:id - Get a specific project
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }
    const agents = AgentDB.findByProject(project.id);
    return json({
      project: toApiProject(project),
      agents: agents.map(toApiAgent),
    });
  }

  // PUT /api/projects/:id - Update a project
  if (projectMatch && method === "PUT") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<Project> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.color !== undefined) updates.color = body.color;

      const updated = ProjectDB.update(projectMatch[1], updates);
      return json({ project: updated ? toApiProject(updated) : null });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/projects/:id - Delete a project
  if (projectMatch && method === "DELETE") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }

    ProjectDB.delete(projectMatch[1]);
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

  // GET /api/version - Check agent binary version info
  if (path === "/api/version" && method === "GET") {
    const versionInfo = await checkForUpdates();
    return json(versionInfo);
  }

  // POST /api/version/update - Download/install latest agent binary
  if (path === "/api/version/update" && method === "POST") {
    // Get all running agents to restart later
    const runningAgents = AgentDB.findAll().filter(a => a.status === "running");
    const agentsToRestart = runningAgents.map(a => a.id);

    // Stop all running agents
    for (const agent of runningAgents) {
      const agentProc = agentProcesses.get(agent.id);
      if (agentProc) {
        console.log(`Stopping agent ${agent.name} for update...`);
        agentProc.proc.kill();
        agentProcesses.delete(agent.id);
      }
      AgentDB.setStatus(agent.id, "stopped");
    }

    // Try npm install first, fall back to direct download
    let result = await installViaNpm();
    if (!result.success) {
      // Fall back to direct download
      result = await downloadLatestBinary(BIN_DIR);
    }

    if (!result.success) {
      return json({ success: false, error: result.error }, 500);
    }

    // Restart agents that were running
    const restartResults: { id: string; name: string; success: boolean; error?: string }[] = [];
    for (const agentId of agentsToRestart) {
      const agent = AgentDB.findById(agentId);
      if (agent) {
        console.log(`Restarting agent ${agent.name} after update...`);
        const startResult = await startAgentProcess(agent);
        restartResults.push({
          id: agent.id,
          name: agent.name,
          success: startResult.success,
          error: startResult.error,
        });
      }
    }

    return json({
      success: true,
      version: result.version,
      restarted: restartResults,
    });
  }

  // GET /api/health - Health check
  if (path === "/api/health") {
    const binaryStatus = getBinaryStatus(BIN_DIR);
    const installedVersion = getInstalledVersion();
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
        version: installedVersion,
      }
    });
  }

  // ==================== TASKS ====================

  // Helper to fetch from a running agent (with authentication)
  async function fetchFromAgent(agentId: string, port: number, endpoint: string): Promise<any> {
    try {
      const response = await agentFetch(agentId, port, endpoint, {
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
      const data = await fetchFromAgent(agent.id, agent.port!, `/tasks?status=${status}`);
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

    const data = await fetchFromAgent(agent.id, agent.port, `/tasks?status=${status}`);
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
      const data = await fetchFromAgent(agent.id, agent.port!, "/tasks?status=all");
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

  // GET /api/mcp/registry - Search MCP registry for available servers
  if (path === "/api/mcp/registry" && method === "GET") {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || "";
    const limit = url.searchParams.get("limit") || "20";

    try {
      const registryUrl = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(search)}&limit=${limit}`;
      const res = await fetch(registryUrl);
      if (!res.ok) {
        return json({ error: "Failed to fetch registry" }, 500);
      }
      const data = await res.json();

      // Transform to simpler format - dedupe by name
      const seen = new Set<string>();
      const servers = (data.servers || [])
        .map((item: any) => {
          const s = item.server;
          const pkg = s.packages?.find((p: any) => p.registryType === "npm");
          const remote = s.remotes?.[0];

          // Extract a short display name from the full name
          // e.g., "ai.smithery/smithery-ai-github" -> "github"
          // e.g., "io.github.user/my-server" -> "my-server"
          const fullName = s.name || "";
          const shortName = fullName.split("/").pop()?.replace(/-mcp$/, "").replace(/^mcp-/, "") || fullName;

          return {
            id: fullName, // Use full name as unique ID
            name: shortName,
            fullName: fullName,
            description: s.description,
            version: s.version,
            repository: s.repository?.url,
            npmPackage: pkg?.identifier || null,
            remoteUrl: remote?.url || null,
            transport: pkg?.transport?.type || (remote ? "http" : "stdio"),
          };
        })
        .filter((s: any) => {
          // Dedupe by fullName
          if (seen.has(s.fullName)) return false;
          seen.add(s.fullName);
          // Only show servers with npm package or remote URL
          return s.npmPackage || s.remoteUrl;
        });

      return json({ servers });
    } catch (e) {
      return json({ error: "Failed to search registry" }, 500);
    }
  }

  // ============ Generic Integration Providers ============
  // These endpoints work with any registered provider (composio, smithery, etc.)

  // GET /api/integrations/providers - List available integration providers
  if (path === "/api/integrations/providers" && method === "GET") {
    const providerIds = getProviderIds();
    const providers = providerIds.map(id => {
      const provider = getProvider(id);
      const hasKey = !!ProviderKeys.getDecrypted(id);
      return {
        id,
        name: provider?.name || id,
        connected: hasKey,
      };
    });
    return json({ providers });
  }

  // GET /api/integrations/:provider/apps - List available apps from a provider
  const appsMatch = path.match(/^\/api\/integrations\/([^/]+)\/apps$/);
  if (appsMatch && method === "GET") {
    const providerId = appsMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecrypted(providerId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured`, apps: [] }, 200);
    }

    try {
      const apps = await provider.listApps(apiKey);
      return json({ apps });
    } catch (e) {
      console.error(`Failed to list apps from ${providerId}:`, e);
      return json({ error: "Failed to fetch apps" }, 500);
    }
  }

  // GET /api/integrations/:provider/connected - List user's connected accounts
  const connectedMatch = path.match(/^\/api\/integrations\/([^/]+)\/connected$/);
  if (connectedMatch && method === "GET") {
    const providerId = connectedMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecrypted(providerId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured`, accounts: [] }, 200);
    }

    // Use Apteva user ID as the entity ID for the provider
    const userId = user?.id || "default";

    try {
      const accounts = await provider.listConnectedAccounts(apiKey, userId);
      return json({ accounts });
    } catch (e) {
      console.error(`Failed to list connected accounts from ${providerId}:`, e);
      return json({ error: "Failed to fetch connected accounts" }, 500);
    }
  }

  // POST /api/integrations/:provider/connect - Initiate connection (OAuth or API Key)
  const connectMatch = path.match(/^\/api\/integrations\/([^/]+)\/connect$/);
  if (connectMatch && method === "POST") {
    const providerId = connectMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecrypted(providerId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const body = await req.json();
      const { appSlug, redirectUrl, credentials } = body;

      if (!appSlug) {
        return json({ error: "appSlug is required" }, 400);
      }

      // Use Apteva user ID as the entity ID
      const userId = user?.id || "default";

      // Default redirect URL back to our integrations page
      const callbackUrl = redirectUrl || `http://localhost:${process.env.PORT || 4280}/mcp?tab=hosted&connected=${appSlug}`;

      const result = await provider.initiateConnection(apiKey, userId, appSlug, callbackUrl, credentials);
      return json(result);
    } catch (e) {
      console.error(`Failed to initiate connection for ${providerId}:`, e);
      return json({ error: `Failed to initiate connection: ${e}` }, 500);
    }
  }

  // GET /api/integrations/:provider/connection/:id - Check connection status
  const connectionStatusMatch = path.match(/^\/api\/integrations\/([^/]+)\/connection\/([^/]+)$/);
  if (connectionStatusMatch && method === "GET") {
    const providerId = connectionStatusMatch[1];
    const connectionId = connectionStatusMatch[2];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecrypted(providerId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const connection = await provider.getConnectionStatus(apiKey, connectionId);
      if (!connection) {
        return json({ error: "Connection not found" }, 404);
      }
      return json({ connection });
    } catch (e) {
      console.error(`Failed to get connection status:`, e);
      return json({ error: "Failed to get connection status" }, 500);
    }
  }

  // DELETE /api/integrations/:provider/connection/:id - Disconnect/revoke
  const disconnectMatch = path.match(/^\/api\/integrations\/([^/]+)\/connection\/([^/]+)$/);
  if (disconnectMatch && method === "DELETE") {
    const providerId = disconnectMatch[1];
    const connectionId = disconnectMatch[2];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecrypted(providerId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const success = await provider.disconnect(apiKey, connectionId);
      return json({ success });
    } catch (e) {
      console.error(`Failed to disconnect:`, e);
      return json({ error: "Failed to disconnect" }, 500);
    }
  }

  // ============ Composio-Specific Routes (MCP Configs) ============

  // GET /api/integrations/composio/configs - List Composio MCP configs
  if (path === "/api/integrations/composio/configs" && method === "GET") {
    const apiKey = ProviderKeys.getDecrypted("composio");
    if (!apiKey) {
      return json({ error: "Composio API key not configured", configs: [] }, 200);
    }

    try {
      const res = await fetch("https://backend.composio.dev/api/v3/mcp/servers?limit=50", {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("Composio API error:", res.status, text);
        return json({ error: "Failed to fetch Composio configs" }, 500);
      }

      const data = await res.json();

      // Transform to our format (no user_id in URLs - that's provided when adding)
      const configs = (data.items || data.servers || []).map((item: any) => ({
        id: item.id,
        name: item.name || item.id,
        toolkits: item.toolkits || item.apps || [],
        toolsCount: item.toolsCount || item.tools?.length || 0,
        createdAt: item.createdAt || item.created_at,
      }));

      return json({ configs });
    } catch (e) {
      console.error("Composio fetch error:", e);
      return json({ error: "Failed to connect to Composio" }, 500);
    }
  }

  // GET /api/integrations/composio/configs/:id - Get single Composio config details
  const composioConfigMatch = path.match(/^\/api\/integrations\/composio\/configs\/([^/]+)$/);
  if (composioConfigMatch && method === "GET") {
    const configId = composioConfigMatch[1];
    const apiKey = ProviderKeys.getDecrypted("composio");
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const res = await fetch(`https://backend.composio.dev/api/v3/mcp/${configId}`, {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        return json({ error: "Config not found" }, 404);
      }

      const data = await res.json();
      return json({
        config: {
          id: data.id,
          name: data.name || data.id,
          toolkits: data.toolkits || data.apps || [],
          tools: data.tools || [],
        },
      });
    } catch (e) {
      return json({ error: "Failed to fetch config" }, 500);
    }
  }

  // POST /api/integrations/composio/configs/:id/add - Add a Composio config as an MCP server
  // Fetches the mcp_url directly from Composio API
  const composioAddMatch = path.match(/^\/api\/integrations\/composio\/configs\/([^/]+)\/add$/);
  if (composioAddMatch && method === "POST") {
    const configId = composioAddMatch[1];
    const apiKey = ProviderKeys.getDecrypted("composio");
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      // Fetch config details from Composio to get the name and mcp_url
      const res = await fetch(`https://backend.composio.dev/api/v3/mcp/${configId}`, {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Failed to fetch Composio MCP config:", errText);
        return json({ error: "Failed to fetch MCP config from Composio" }, 400);
      }

      const data = await res.json();
      const configName = data.name || `composio-${configId.slice(0, 8)}`;
      const mcpUrl = data.mcp_url;
      const authConfigIds = data.auth_config_ids || [];
      const serverInstanceCount = data.server_instance_count || 0;

      if (!mcpUrl) {
        return json({ error: "MCP config does not have a URL" }, 400);
      }

      // Get user_id from connected accounts for this auth config
      const { createMcpServerInstance, getUserIdForAuthConfig } = await import("../integrations/composio");
      let userId: string | null = null;

      if (authConfigIds.length > 0) {
        userId = await getUserIdForAuthConfig(apiKey, authConfigIds[0]);

        // Create server instance if none exists
        if (serverInstanceCount === 0 && userId) {
          const instance = await createMcpServerInstance(apiKey, configId, userId);
          if (instance) {
            console.log(`Created server instance for user ${userId} on server ${configId}`);
          }
        }
      }

      // Append user_id to mcp_url for authentication
      const mcpUrlWithUser = userId
        ? `${mcpUrl}?user_id=${encodeURIComponent(userId)}`
        : mcpUrl;

      // Check if already exists (match by config ID in URL)
      const existing = McpServerDB.findAll().find(
        s => s.source === "composio" && s.url?.includes(configId)
      );
      if (existing) {
        return json({ server: existing, message: "Server already exists" });
      }

      // Create the MCP server entry with user_id in URL
      const server = McpServerDB.create({
        id: generateId(),
        name: configName,
        type: "http",
        package: null,
        command: null,
        args: null,
        env: {},
        url: mcpUrlWithUser,
        headers: { "x-api-key": apiKey },
        source: "composio",
      });

      return json({ server, message: "Server added successfully" });
    } catch (e) {
      console.error("Failed to add Composio config:", e);
      return json({ error: "Failed to add Composio config" }, 500);
    }
  }

  // POST /api/integrations/composio/configs - Create a new MCP config from connected app
  if (path === "/api/integrations/composio/configs" && method === "POST") {
    const apiKey = ProviderKeys.getDecrypted("composio");
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const body = await req.json();
      const { name, toolkitSlug, authConfigId } = body;

      if (!name || !toolkitSlug) {
        return json({ error: "name and toolkitSlug are required" }, 400);
      }

      // If authConfigId not provided, find it from the toolkit
      let configId = authConfigId;
      if (!configId) {
        const { getAuthConfigForToolkit } = await import("../integrations/composio");
        configId = await getAuthConfigForToolkit(apiKey, toolkitSlug);
        if (!configId) {
          return json({ error: `No auth config found for ${toolkitSlug}. Make sure you have connected this app first.` }, 400);
        }
      }

      // Create MCP server in Composio
      const { createMcpServer, createMcpServerInstance, getUserIdForAuthConfig } = await import("../integrations/composio");
      const mcpServer = await createMcpServer(apiKey, name, [configId]);

      if (!mcpServer) {
        return json({ error: "Failed to create MCP config" }, 500);
      }

      // Create server instance for the user who has the connected account
      const userId = await getUserIdForAuthConfig(apiKey, configId);
      if (userId) {
        const instance = await createMcpServerInstance(apiKey, mcpServer.id, userId);
        if (!instance) {
          console.warn(`Created MCP server but failed to create instance for user ${userId}`);
        }
      }

      // Append user_id to mcp_url for authentication
      const mcpUrlWithUser = userId
        ? `${mcpServer.mcpUrl}?user_id=${encodeURIComponent(userId)}`
        : mcpServer.mcpUrl;

      return json({
        config: {
          id: mcpServer.id,
          name: mcpServer.name,
          toolkits: mcpServer.toolkits,
          mcpUrl: mcpUrlWithUser,
          allowedTools: mcpServer.allowedTools,
          userId,
        },
      }, 201);
    } catch (e: any) {
      console.error("Failed to create Composio MCP config:", e);
      return json({ error: e.message || "Failed to create MCP config" }, 500);
    }
  }

  // DELETE /api/integrations/composio/configs/:id - Delete a Composio MCP config
  if (composioConfigMatch && method === "DELETE") {
    const configId = composioConfigMatch[1];
    const apiKey = ProviderKeys.getDecrypted("composio");
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const { deleteMcpServer } = await import("../integrations/composio");
      const success = await deleteMcpServer(apiKey, configId);
      if (!success) {
        return json({ error: "Failed to delete MCP config" }, 500);
      }
      return json({ success: true });
    } catch (e) {
      console.error("Failed to delete Composio config:", e);
      return json({ error: "Failed to delete MCP config" }, 500);
    }
  }

  // POST /api/mcp/servers - Create/install a new MCP server
  if (path === "/api/mcp/servers" && method === "POST") {
    try {
      const body = await req.json();
      const { name, type, package: pkg, command, args, env, url, headers, source } = body;

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
        url: url || null,
        headers: headers || {},
        source: source || null,
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
    // Helper to substitute $ENV_VAR references with actual values
    const substituteEnvVars = (str: string, env: Record<string, string>): string => {
      return str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName) => {
        return env[varName] || '';
      });
    };

    let cmd: string[];
    const serverEnv = server.env || {};

    if (server.command) {
      // Custom command - substitute env vars in args
      cmd = server.command.split(" ");
      if (server.args) {
        const substitutedArgs = substituteEnvVars(server.args, serverEnv);
        cmd.push(...substitutedArgs.split(" "));
      }
    } else if (server.package) {
      // npm package - use npx
      cmd = ["npx", "-y", server.package];
      if (server.args) {
        const substitutedArgs = substituteEnvVars(server.args, serverEnv);
        cmd.push(...substitutedArgs.split(" "));
      }
    } else {
      return json({ error: "No command or package specified" }, 400);
    }

    // Get a port for the HTTP proxy
    const port = await getNextPort();

    console.log(`Starting MCP server ${server.name}...`);
    console.log(`  Command: ${cmd.join(" ")}`);
    console.log(`  HTTP proxy: http://localhost:${port}/mcp`);

    // Start the MCP process with stdio pipes + HTTP proxy
    const result = await startMcpProcess(server.id, cmd, server.env || {}, port);

    if (!result.success) {
      console.error(`Failed to start MCP server: ${result.error}`);
      return json({ error: `Failed to start: ${result.error}` }, 500);
    }

    // Update status with the HTTP proxy port
    const updated = McpServerDB.setStatus(server.id, "running", port);

    return json({
      server: updated,
      message: "MCP server started",
      proxyUrl: `http://localhost:${port}/mcp`,
    });
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

    // HTTP servers use remote HTTP transport
    if (server.type === "http" && server.url) {
      try {
        const httpClient = getHttpMcpClient(server.url, server.headers || {});
        const serverInfo = await httpClient.initialize();
        const tools = await httpClient.listTools();

        return json({
          serverInfo,
          tools,
        });
      } catch (err) {
        console.error(`Failed to list HTTP MCP tools: ${err}`);
        return json({ error: `Failed to communicate with MCP server: ${err}` }, 500);
      }
    }

    // Stdio servers require a running process
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

    const toolName = decodeURIComponent(mcpToolCallMatch[2]);

    // HTTP servers use remote HTTP transport
    if (server.type === "http" && server.url) {
      try {
        const body = await req.json();
        const args = body.arguments || {};

        const httpClient = getHttpMcpClient(server.url, server.headers || {});
        const result = await httpClient.callTool(toolName, args);

        return json({ result });
      } catch (err) {
        console.error(`Failed to call HTTP MCP tool: ${err}`);
        return json({ error: `Failed to call tool: ${err}` }, 500);
      }
    }

    // Stdio servers require a running process
    const mcpProcess = getMcpProcess(server.id);
    if (!mcpProcess) {
      return json({ error: "MCP server is not running" }, 400);
    }

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

  // ============ Skills Endpoints ============

  // GET /api/skills - List all skills
  if (path === "/api/skills" && method === "GET") {
    const skills = SkillDB.findAll();
    return json({ skills });
  }

  // POST /api/skills - Create a new skill
  if (path === "/api/skills" && method === "POST") {
    try {
      const body = await req.json();
      const { name, description, content, version, license, compatibility, metadata, allowed_tools, source, source_url, enabled } = body;

      if (!name || !description || !content) {
        return json({ error: "name, description, and content are required" }, 400);
      }

      // Validate name format (lowercase, hyphens only)
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(name)) {
        return json({ error: "name must be lowercase letters, numbers, and hyphens only" }, 400);
      }

      if (SkillDB.exists(name)) {
        return json({ error: "A skill with this name already exists" }, 400);
      }

      const skill = SkillDB.create({
        name,
        description,
        content,
        version: version || "1.0.0",
        license: license || null,
        compatibility: compatibility || null,
        metadata: metadata || {},
        allowed_tools: allowed_tools || [],
        source: source || "local",
        source_url: source_url || null,
        enabled: enabled !== false,
      });

      return json({ skill }, 201);
    } catch (err) {
      console.error("Failed to create skill:", err);
      return json({ error: `Failed to create skill: ${err}` }, 500);
    }
  }

  // GET /api/skills/:id - Get a skill
  const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch && method === "GET") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }
    return json({ skill });
  }

  // PUT /api/skills/:id - Update a skill
  if (skillMatch && method === "PUT") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<Skill> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.content !== undefined) updates.content = body.content;
      if (body.license !== undefined) updates.license = body.license;
      if (body.compatibility !== undefined) updates.compatibility = body.compatibility;
      if (body.metadata !== undefined) updates.metadata = body.metadata;
      if (body.allowed_tools !== undefined) updates.allowed_tools = body.allowed_tools;
      if (body.enabled !== undefined) updates.enabled = body.enabled;

      // Auto-increment version if content changed
      if (body.content !== undefined && body.content !== skill.content) {
        const [major, minor, patch] = (skill.version || "1.0.0").split(".").map(Number);
        updates.version = `${major}.${minor}.${patch + 1}`;
      } else if (body.version !== undefined) {
        updates.version = body.version;
      }

      const updated = SkillDB.update(skillMatch[1], updates);

      // Push updated skill to all running agents that have it
      const agentsWithSkill = AgentDB.findBySkill(skillMatch[1]);
      const runningAgents = agentsWithSkill.filter(a => a.status === "running" && a.port);

      for (const agent of runningAgents) {
        try {
          const providerKey = ProviderKeys.getDecrypted(agent.provider);
          if (providerKey) {
            const config = buildAgentConfig(agent, providerKey);
            await pushConfigToAgent(agent.id, agent.port!, config);
            // Push skills via /skills endpoint
            if (config.skills?.definitions?.length > 0) {
              await pushSkillsToAgent(agent.id, agent.port!, config.skills.definitions);
            }
            console.log(`Pushed skill update to agent ${agent.name}`);
          }
        } catch (err) {
          console.error(`Failed to push skill update to agent ${agent.name}:`, err);
        }
      }

      return json({ skill: updated, agents_updated: runningAgents.length });
    } catch (err) {
      console.error("Failed to update skill:", err);
      return json({ error: `Failed to update skill: ${err}` }, 500);
    }
  }

  // DELETE /api/skills/:id - Delete a skill
  if (skillMatch && method === "DELETE") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    SkillDB.delete(skillMatch[1]);
    return json({ success: true });
  }

  // POST /api/skills/:id/toggle - Toggle skill enabled/disabled
  const skillToggleMatch = path.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (skillToggleMatch && method === "POST") {
    const skill = SkillDB.findById(skillToggleMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    const updated = SkillDB.setEnabled(skillToggleMatch[1], !skill.enabled);
    return json({ skill: updated });
  }

  // POST /api/skills/import - Import a skill from SKILL.md content
  if (path === "/api/skills/import" && method === "POST") {
    try {
      const body = await req.json();
      const { content, source, source_url } = body;

      if (!content) {
        return json({ error: "content is required" }, 400);
      }

      const parsed = parseSkillMd(content);
      if (!parsed) {
        return json({ error: "Invalid SKILL.md format. Must have YAML frontmatter with name and description." }, 400);
      }

      if (SkillDB.exists(parsed.name)) {
        return json({ error: `A skill named "${parsed.name}" already exists` }, 400);
      }

      const skill = SkillDB.create({
        name: parsed.name,
        description: parsed.description,
        content: content, // Store full content including frontmatter
        license: parsed.license || null,
        compatibility: parsed.compatibility || null,
        metadata: parsed.metadata || {},
        allowed_tools: parsed.allowedTools || [],
        source: source || "import",
        source_url: source_url || null,
        enabled: true,
      });

      return json({ skill }, 201);
    } catch (err) {
      console.error("Failed to import skill:", err);
      return json({ error: `Failed to import skill: ${err}` }, 500);
    }
  }

  // GET /api/skills/:id/export - Export a skill as SKILL.md
  const skillExportMatch = path.match(/^\/api\/skills\/([^/]+)\/export$/);
  if (skillExportMatch && method === "GET") {
    const skill = SkillDB.findById(skillExportMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    // Return the raw content
    return new Response(skill.content, {
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="${skill.name}-SKILL.md"`,
      },
    });
  }

  // ============ SkillsMP Marketplace Endpoints ============

  // GET /api/skills/marketplace/search - Search skills marketplace
  if (path === "/api/skills/marketplace/search" && method === "GET") {
    const url = new URL(req.url);
    const query = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);

    // Get SkillsMP API key if configured
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");

    const result = await SkillsmpProvider.search(skillsmpKey || "", query, page);
    return json(result);
  }

  // GET /api/skills/marketplace/featured - Get featured skills
  if (path === "/api/skills/marketplace/featured" && method === "GET") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const skills = await SkillsmpProvider.getFeatured(skillsmpKey || "");
    return json({ skills });
  }

  // GET /api/skills/marketplace/:id - Get skill details from marketplace
  const marketplaceSkillMatch = path.match(/^\/api\/skills\/marketplace\/([^/]+)$/);
  if (marketplaceSkillMatch && method === "GET") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const skill = await SkillsmpProvider.getSkill(skillsmpKey || "", marketplaceSkillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found in marketplace" }, 404);
    }
    return json({ skill });
  }

  // POST /api/skills/marketplace/:id/install - Install a skill from marketplace
  const marketplaceInstallMatch = path.match(/^\/api\/skills\/marketplace\/([^/]+)\/install$/);
  if (marketplaceInstallMatch && method === "POST") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const marketplaceSkill = await SkillsmpProvider.getSkill(skillsmpKey || "", marketplaceInstallMatch[1]);

    if (!marketplaceSkill) {
      return json({ error: "Skill not found in marketplace" }, 404);
    }

    if (SkillDB.exists(marketplaceSkill.name)) {
      return json({ error: `A skill named "${marketplaceSkill.name}" already exists` }, 400);
    }

    const skill = SkillDB.create({
      name: marketplaceSkill.name,
      description: marketplaceSkill.description,
      content: marketplaceSkill.content,
      license: marketplaceSkill.license,
      compatibility: marketplaceSkill.compatibility,
      metadata: {
        author: marketplaceSkill.author,
        version: marketplaceSkill.version,
        ...(marketplaceSkill.repository ? { repository: marketplaceSkill.repository } : {}),
      },
      allowed_tools: [],
      source: "skillsmp",
      source_url: marketplaceSkill.repository || `https://skillsmp.com/skills/${marketplaceSkill.id}`,
      enabled: true,
    });

    return json({ skill }, 201);
  }

  // ============ Telemetry Endpoints ============

  // POST /api/telemetry - Receive telemetry events from agents
  if (path === "/api/telemetry" && method === "POST") {
    try {
      const body = await req.json() as {
        agent_id: string;
        sent_at: string;
        events: Array<{
          id: string;
          timestamp: string;
          category: string;
          type: string;
          level: string;
          trace_id?: string;
          span_id?: string;
          thread_id?: string;
          data?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          duration_ms?: number;
          error?: string;
        }>;
      };

      if (!body.agent_id || !body.events) {
        return json({ error: "agent_id and events are required" }, 400);
      }

      // Filter out debug events - too noisy
      const filteredEvents = body.events.filter(e => e.level !== "debug");
      const inserted = TelemetryDB.insertBatch(body.agent_id, filteredEvents);

      // Broadcast to SSE clients
      if (filteredEvents.length > 0) {
        const broadcastEvents: TelemetryEvent[] = filteredEvents.map(e => ({
          id: e.id,
          agent_id: body.agent_id,
          timestamp: e.timestamp,
          category: e.category,
          type: e.type,
          level: e.level,
          trace_id: e.trace_id,
          thread_id: e.thread_id,
          data: e.data,
          duration_ms: e.duration_ms,
          error: e.error,
        }));
        telemetryBroadcaster.broadcast(broadcastEvents);
      }

      return json({ received: body.events.length, inserted });
    } catch (e) {
      console.error("Telemetry error:", e);
      return json({ error: "Invalid telemetry payload" }, 400);
    }
  }

  // GET /api/telemetry/stream - SSE stream for real-time telemetry
  if (path === "/api/telemetry/stream" && method === "GET") {
    let controller: ReadableStreamDefaultController<string>;

    const stream = new ReadableStream<string>({
      start(c) {
        controller = c;
        telemetryBroadcaster.addClient(controller);
        // Send initial connection message
        controller.enqueue("data: {\"connected\":true}\n\n");
      },
      cancel() {
        telemetryBroadcaster.removeClient(controller);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // GET /api/telemetry/events - Query telemetry events
  if (path === "/api/telemetry/events" && method === "GET") {
    const url = new URL(req.url);
    const projectIdParam = url.searchParams.get("project_id");
    const events = TelemetryDB.query({
      agent_id: url.searchParams.get("agent_id") || undefined,
      project_id: projectIdParam === "null" ? null : projectIdParam || undefined,
      category: url.searchParams.get("category") || undefined,
      level: url.searchParams.get("level") || undefined,
      trace_id: url.searchParams.get("trace_id") || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
      limit: parseInt(url.searchParams.get("limit") || "100"),
      offset: parseInt(url.searchParams.get("offset") || "0"),
    });
    return json({ events });
  }

  // GET /api/telemetry/usage - Get usage statistics
  if (path === "/api/telemetry/usage" && method === "GET") {
    const url = new URL(req.url);
    const projectIdParam = url.searchParams.get("project_id");
    const usage = TelemetryDB.getUsage({
      agent_id: url.searchParams.get("agent_id") || undefined,
      project_id: projectIdParam === "null" ? null : projectIdParam || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
      group_by: (url.searchParams.get("group_by") as "agent" | "day") || undefined,
    });
    return json({ usage });
  }

  // GET /api/telemetry/stats - Get summary statistics
  if (path === "/api/telemetry/stats" && method === "GET") {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") || undefined;
    const projectIdParam = url.searchParams.get("project_id");
    const stats = TelemetryDB.getStats({
      agentId,
      projectId: projectIdParam === "null" ? null : projectIdParam || undefined,
    });
    return json({ stats });
  }

  // POST /api/telemetry/clear - Clear all telemetry data
  if (path === "/api/telemetry/clear" && method === "POST") {
    const deleted = TelemetryDB.deleteOlderThan(0); // Delete all
    return json({ deleted });
  }

  return json({ error: "Not found" }, 404);
}
