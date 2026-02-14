import { existsSync, rmSync } from "fs";
import { join } from "path";
import { json, isDev } from "./helpers";
import {
  agentFetch,
  toApiAgent, toApiAgentsBatch,
  checkPortFree,
  startAgentProcess,
  buildAgentConfig,
  pushConfigToAgent,
  pushSkillsToAgent,
  fetchFromAgent,
  AGENTS_DATA_DIR,
  META_AGENT_ID,
  setAgentStatus,
} from "./agent-utils";
import { AgentDB, McpServerDB, SkillDB, TelemetryDB, generateId, getMultiAgentConfig, type Agent } from "../../db";
import { ProviderKeys } from "../../providers";
import { agentProcesses } from "../../server";
import type { AuthContext } from "../../auth/middleware";

export async function handleAgentRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: AuthContext,
): Promise<Response | null> {
  // ==================== AGENT CRUD ====================

  // GET /api/agents - List agents (excludes meta agent), optionally filtered by project
  if (path === "/api/agents" && method === "GET") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id");

    let agents;
    if (projectId === "unassigned") {
      // Agents with no project
      agents = AgentDB.findByProject(null);
    } else if (projectId) {
      agents = AgentDB.findByProject(projectId);
    } else {
      agents = AgentDB.findAll();
    }

    agents = agents.filter(a => a.id !== META_AGENT_ID);
    return json({ agents: toApiAgentsBatch(agents) });
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
      const { DEFAULT_FEATURES } = await import("../../db");

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
      } as any);

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
      if (body.skills !== undefined) updates.skills = body.skills;
      if (body.projectId !== undefined) updates.project_id = body.projectId;

      const updated = AgentDB.update(agentMatch[1], updates);

      // If agent is running, handle config update
      if (updated && updated.status === "running" && updated.port) {
        const providerChanged = body.provider !== undefined && body.provider !== agent.provider;

        if (providerChanged) {
          // Provider changed — must restart to get new API key in env
          console.log(`Provider changed for ${updated.name} (${agent.provider} -> ${updated.provider}), restarting...`);
          const agentProc = agentProcesses.get(updated.id);
          if (agentProc) {
            // Graceful shutdown
            try {
              await fetch(`http://localhost:${updated.port}/shutdown`, {
                method: "POST",
                signal: AbortSignal.timeout(2000),
              });
              await new Promise(r => setTimeout(r, 500));
            } catch {}
            try { agentProc.proc.kill(); } catch {}
            agentProcesses.delete(updated.id);
          }
          setAgentStatus(updated.id, "stopped", "provider_changed");
          // Start with new provider
          const startResult = await startAgentProcess(updated, { silent: true });
          if (!startResult.success) {
            console.error(`Failed to restart agent after provider change: ${startResult.error}`);
          }
        } else {
          // Same provider — just push updated config
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
    const port = agent.port;

    if (agentProc) {
      // Try graceful shutdown first
      if (port) {
        try {
          await fetch(`http://localhost:${port}/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
          });
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // Graceful shutdown failed
        }
      }

      try {
        agentProc.proc.kill();
      } catch {
        // Already dead
      }
      agentProcesses.delete(agentId);

      // Ensure port is freed
      if (port) {
        const isFree = await checkPortFree(port);
        if (!isFree) {
          try {
            const { execSync } = await import("child_process");
            execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null || true`, { stdio: "ignore" });
          } catch {
            // Ignore
          }
        }
      }
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

  // ==================== AGENT API KEY ====================

  // GET /api/agents/:id/api-key - Get the agent's API key (masked)
  const apiKeyMatch = path.match(/^\/api\/agents\/([^/]+)\/api-key$/);
  if (apiKeyMatch && method === "GET") {
    const agent = AgentDB.findById(apiKeyMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    const apiKey = AgentDB.getApiKey(agent.id);
    if (!apiKey) {
      return json({ error: "No API key found for this agent" }, 404);
    }

    // Return masked key + full key (full key only shown on demand by frontend)
    const masked = apiKey.substring(0, 8) + "..." + apiKey.substring(apiKey.length - 4);
    return json({
      apiKey: masked,
      fullKey: apiKey,
      hasKey: true,
    });
  }

  // POST /api/agents/:id/api-key - Regenerate the agent's API key
  if (apiKeyMatch && method === "POST") {
    const agent = AgentDB.findById(apiKeyMatch[1]);
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

  // ==================== AGENT LIFECYCLE ====================

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
    const port = agent.port;

    if (agentProc) {
      console.log(`Stopping agent ${agent.name} (pid: ${agentProc.proc.pid})...`);

      // Try graceful shutdown first
      if (port) {
        try {
          await fetch(`http://localhost:${port}/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
          });
          await new Promise(r => setTimeout(r, 500)); // Wait for graceful shutdown
        } catch {
          // Graceful shutdown failed or timed out
        }
      }

      // Force kill if still running
      try {
        agentProc.proc.kill();
      } catch {
        // Already dead
      }
      agentProcesses.delete(agent.id);

      // Ensure port is freed
      if (port) {
        const isFree = await checkPortFree(port);
        if (!isFree) {
          // Force kill by port
          try {
            const { execSync } = await import("child_process");
            execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null || true`, { stdio: "ignore" });
          } catch {
            // Ignore
          }
        }
      }
    }

    const updated = setAgentStatus(agent.id, "stopped", "user_stopped");
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

  // ==================== WEBHOOK ENDPOINT ====================

  // POST /api/agents/:id/webhook - Receive external trigger events and forward to agent chat
  const webhookMatch = path.match(/^\/api\/agents\/([^/]+)\/webhook$/);
  if (webhookMatch && method === "POST") {
    const agent = AgentDB.findById(webhookMatch[1]);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    try {
      const body = await req.json();

      // Format the webhook payload as a chat message
      const triggerSlug = body.trigger_name || body.type || "unknown_trigger";
      const eventPayload = body.payload || body.data || body;

      const triggerName = String(triggerSlug).replace(/_/g, " ");
      const message = [
        `[Trigger: ${triggerName}]`,
        "",
        "```json",
        JSON.stringify(eventPayload, null, 2),
        "```",
        "",
        "Process this event and take appropriate action.",
      ].join("\n");

      // Forward to agent's /chat endpoint
      const response = await agentFetch(agent.id, agent.port, "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      // Consume the streaming response (we don't need the agent's reply)
      if (response.body) {
        try {
          const reader = response.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // Ignore read errors
        }
      }

      if (!response.ok) {
        return json({ error: "Agent failed to process webhook" }, 502);
      }

      return json({ received: true, agent_id: agent.id, trigger: triggerSlug });
    } catch (err) {
      console.error(`Webhook proxy error for agent ${webhookMatch[1]}:`, err);
      return json({ error: `Failed to process webhook: ${err}` }, 500);
    }
  }

  // ==================== THREAD & MESSAGE PROXY ====================

  // GET/POST /api/agents/:id/threads
  const threadsListMatch = path.match(/^\/api\/agents\/([^/]+)\/threads$/);
  if (threadsListMatch && method === "GET") {
    const agent = AgentDB.findById(threadsListMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  if (threadsListMatch && method === "POST") {
    const agent = AgentDB.findById(threadsListMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  // GET/DELETE /api/agents/:id/threads/:threadId
  const threadDetailMatch = path.match(/^\/api\/agents\/([^/]+)\/threads\/([^/]+)$/);
  if (threadDetailMatch && method === "GET") {
    const agent = AgentDB.findById(threadDetailMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  if (threadDetailMatch && method === "DELETE") {
    const agent = AgentDB.findById(threadDetailMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const threadId = threadDetailMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/threads/${threadId}`, { method: "DELETE" });
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

  // GET /api/agents/:id/threads/:threadId/messages
  const threadMessagesMatch = path.match(/^\/api\/agents\/([^/]+)\/threads\/([^/]+)\/messages$/);
  if (threadMessagesMatch && method === "GET") {
    const agent = AgentDB.findById(threadMessagesMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  const memoriesMatch = path.match(/^\/api\/agents\/([^/]+)\/memories$/);
  if (memoriesMatch && method === "GET") {
    const agent = AgentDB.findById(memoriesMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  if (memoriesMatch && method === "DELETE") {
    const agent = AgentDB.findById(memoriesMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  const memoryDeleteMatch = path.match(/^\/api\/agents\/([^/]+)\/memories\/([^/]+)$/);
  if (memoryDeleteMatch && method === "DELETE") {
    const agent = AgentDB.findById(memoryDeleteMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  const filesMatch = path.match(/^\/api\/agents\/([^/]+)\/files$/);
  if (filesMatch && method === "POST") {
    const agent = AgentDB.findById(filesMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const contentType = req.headers.get("content-type") || "";
      const body = await req.arrayBuffer();
      const response = await agentFetch(agent.id, agent.port, "/files", {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: body,
      });
      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }
      const data = await response.json();
      return json(data);
    } catch (err) {
      console.error(`File upload proxy error: ${err}`);
      return json({ error: `Failed to upload file: ${err}` }, 500);
    }
  }

  if (filesMatch && method === "GET") {
    const agent = AgentDB.findById(filesMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  // GET/DELETE /api/agents/:id/files/:fileId/download and /api/agents/:id/files/:fileId
  const fileDownloadMatch = path.match(/^\/api\/agents\/([^/]+)\/files\/([^/]+)\/download$/);
  if (fileDownloadMatch && method === "GET") {
    const agent = AgentDB.findById(fileDownloadMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const fileId = fileDownloadMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/files/${fileId}/download`);
      if (!response.ok) {
        const errorText = await response.text();
        return json({ error: `Agent error: ${errorText}` }, response.status);
      }
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

  const fileGetMatch = path.match(/^\/api\/agents\/([^/]+)\/files\/([^/]+)$/);
  if (fileGetMatch && method === "GET") {
    const agent = AgentDB.findById(fileGetMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  if (fileGetMatch && method === "DELETE") {
    const agent = AgentDB.findById(fileGetMatch[1]);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const fileId = fileGetMatch[2];
      const response = await agentFetch(agent.id, agent.port, `/files/${fileId}`, { method: "DELETE" });
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

  // ==================== DISCOVERY/PEERS PROXY ====================

  // GET /api/discovery/agents - Central discovery endpoint for agents to find peers
  if (path === "/api/discovery/agents" && method === "GET") {
    const url = new URL(req.url); // BUG FIX: was missing url declaration
    const group = url.searchParams.get("group");
    const excludeId = url.searchParams.get("exclude") || req.headers.get("X-Agent-ID");

    // Find all running agents in the same group
    const allAgents = AgentDB.findAll();
    const peers = allAgents
      .filter(a => {
        if (a.status !== "running" || !a.port) return false;
        if (excludeId && a.id === excludeId) return false;
        const agentConfig = getMultiAgentConfig(a.features, a.project_id);
        if (!agentConfig.enabled) return false;
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
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

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

  // ==================== AGENT TASKS ====================

  // GET /api/agents/:id/tasks - Get tasks from a specific agent
  const agentTasksMatch = path.match(/^\/api\/agents\/([^/]+)\/tasks$/);
  if (agentTasksMatch && method === "GET") {
    const agentId = agentTasksMatch[1];
    const agent = AgentDB.findById(agentId);

    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";

    const data = await fetchFromAgent(agent.id, agent.port, `/tasks?status=${status}`);
    if (!data) {
      return json({ error: "Failed to fetch tasks from agent" }, 500);
    }

    return json(data);
  }

  return null;
}
