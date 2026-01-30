import { spawn } from "bun";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { agentProcesses, BINARY_PATH, getNextPort, getBinaryStatus, BIN_DIR } from "../server";
import { AgentDB, generateId, type Agent } from "../db";
import { ProviderKeys, Onboarding, getProvidersWithStatus, PROVIDERS, type ProviderId } from "../providers";
import { binaryExists } from "../binary";

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

      const updated = AgentDB.update(agentMatch[1], updates);
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

  return json({ error: "Not found" }, 404);
}
