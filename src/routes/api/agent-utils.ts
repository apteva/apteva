import { spawn } from "bun";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, rmSync } from "fs";
import { agentProcesses, agentsStarting, getBinaryPathForAgent, getBinaryStatus, BIN_DIR, telemetryBroadcaster, isShuttingDown, type TelemetryEvent } from "../../server";
import { AgentDB, McpServerDB, SkillDB, TelemetryDB, generateId, getMultiAgentConfig, type Agent, type Project } from "../../db";
import { ProviderKeys, PROVIDERS, type ProviderId } from "../../providers";
import { binaryExists } from "../../binary";

// Data directory for agent instances (in ~/.apteva/agents/)
export const AGENTS_DATA_DIR = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "agents")
  : join(homedir(), ".apteva", "agents");

// Meta Agent configuration
export const META_AGENT_ENABLED = process.env.META_AGENT_ENABLED === "true";
export const META_AGENT_ID = "apteva-assistant";

// Update agent status + emit telemetry event + broadcast to SSE
export function setAgentStatus(agentId: string, status: "running" | "stopped", reason?: string): Agent | null {
  const agent = AgentDB.setStatus(agentId, status);
  const event: TelemetryEvent = {
    id: generateId(),
    agent_id: agentId,
    timestamp: new Date().toISOString(),
    category: "system",
    type: status === "running" ? "agent_started" : "agent_stopped",
    level: "info",
    data: { reason: reason || status },
  };
  TelemetryDB.insertBatch(agentId, [event]);
  telemetryBroadcaster.broadcast([event]);
  return agent;
}

// Wait for agent to be healthy (with timeout)
// Note: /health endpoint is whitelisted in agent, no auth needed
export async function waitForAgentHealth(port: number, maxAttempts = 30, delayMs = 200): Promise<boolean> {
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
export async function checkPortFree(port: number): Promise<boolean> {
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
export async function agentFetch(
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
export function buildAgentConfig(agent: Agent, providerKey: string) {
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

    if (server.type === "local" && server.status === "running") {
      // Local MCP server (in-process, no subprocess)
      const baseUrl = `http://localhost:${process.env.PORT || 4280}`;
      mcpServers.push({
        name: server.name,
        type: "http",
        url: `${baseUrl}/api/mcp/servers/${server.id}/mcp`,
        headers: {},
        enabled: true,
      });
    } else if (server.type === "http" && server.url) {
      // Remote HTTP server (Composio, Smithery, or custom)
      mcpServers.push({
        name: server.name,
        type: "http",
        url: server.url,
        headers: server.headers || {},
        enabled: true,
      });
    } else if (server.status === "running" && server.port) {
      // Subprocess MCP server (npm, github, custom)
      mcpServers.push({
        name: server.name,
        type: "http",
        url: `http://localhost:${server.port}/mcp`,
        headers: {},
        enabled: true,
      });
    }
  }

  // Auto-inject built-in platform MCP server for meta agent
  if (agent.id === META_AGENT_ID) {
    const baseUrl = `http://localhost:${process.env.PORT || 4280}`;
    mcpServers.push({
      name: "Apteva Platform",
      type: "http",
      url: `${baseUrl}/api/mcp/platform`,
      headers: {},
      enabled: true,
    });
  }

  return {
    id: agent.id,
    name: agent.name,
    description: agent.system_prompt,
    public_url: `http://localhost:${agent.port}`,
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
      builtin_tools: [
        ...(features.builtinTools?.webSearch ? [{ type: "web_search_20250305", name: "web_search" }] : []),
        ...(features.builtinTools?.webFetch ? [{ type: "web_fetch_20250910", name: "web_fetch" }] : []),
      ],
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
      enabled: features.mcp || agent.id === META_AGENT_ID,
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

// Push config to running agent (with authentication)
export async function pushConfigToAgent(agentId: string, port: number, config: any): Promise<{ success: boolean; error?: string }> {
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
export async function pushSkillsToAgent(agentId: string, port: number, skills: Array<{
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
    // CONFIG_PATH ensures each agent has its own config file (prevents sharing)
    const agentConfigPath = join(agentDataDir, "agent-config.json");
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(port),
      DATA_DIR: agentDataDir,
      CONFIG_PATH: agentConfigPath,
      AGENT_API_KEY: agentApiKey,
      [providerConfig.envVar]: providerKey,
    };

    // If memory is enabled and agent doesn't use OpenAI, also pass OpenAI key for embeddings
    if (agent.features.memory && agent.provider !== "openai") {
      const openaiKey = ProviderKeys.getDecrypted("openai");
      if (openaiKey) {
        env.OPENAI_API_KEY = openaiKey;
      }
    }

    // Get binary path dynamically (allows hot-reload of new binary versions)
    const binaryPath = getBinaryPathForAgent();

    const proc = spawn({
      cmd: [binaryPath],
      env,
      stdout: "ignore",
      stderr: "ignore",
    });

    // Store process with port for tracking
    agentProcesses.set(agent.id, { proc, port });

    // Detect unexpected process exits (crashes) — but not during server shutdown
    proc.exited.then((code) => {
      if (isShuttingDown()) return; // Don't update DB during shutdown — keeps status "running" for auto-restart
      if (agentProcesses.has(agent.id)) {
        agentProcesses.delete(agent.id);
        setAgentStatus(agent.id, "stopped", code === 0 ? "exited" : "crashed");
      }
    });

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

    // Update status in database + emit telemetry event
    setAgentStatus(agent.id, "running");

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
export function toApiAgent(agent: Agent) {
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

// Batch transform: fetch all MCP servers + skills in 2 queries instead of N per agent
export function toApiAgentsBatch(agents: Agent[]) {
  // Collect all unique IDs
  const allMcpIds = new Set<string>();
  const allSkillIds = new Set<string>();
  for (const agent of agents) {
    for (const id of agent.mcp_servers || []) allMcpIds.add(id);
    for (const id of agent.skills || []) allSkillIds.add(id);
  }

  // Batch load in 2 queries
  const mcpMap = McpServerDB.findByIds([...allMcpIds]);
  const skillMap = SkillDB.findByIds([...allSkillIds]);

  return agents.map(agent => {
    const mcpServerDetails = (agent.mcp_servers || [])
      .map(id => mcpMap.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map(s => ({ id: s.id, name: s.name, type: s.type, status: s.status, port: s.port, url: s.url }));

    const skillDetails = (agent.skills || [])
      .map(id => skillMap.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map(s => ({ id: s.id, name: s.name, description: s.description, version: s.version, enabled: s.enabled }));

    return {
      id: agent.id, name: agent.name, model: agent.model, provider: agent.provider,
      systemPrompt: agent.system_prompt, status: agent.status, port: agent.port,
      features: agent.features, mcpServers: agent.mcp_servers, mcpServerDetails,
      skills: agent.skills, skillDetails, projectId: agent.project_id,
      createdAt: agent.created_at, updatedAt: agent.updated_at,
    };
  });
}

// Transform DB project to API response format
export function toApiProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    color: project.color,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

// Helper to fetch from a running agent (with authentication)
export async function fetchFromAgent(agentId: string, port: number, endpoint: string): Promise<any> {
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
