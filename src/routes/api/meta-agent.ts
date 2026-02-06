import { json } from "./helpers";
import { META_AGENT_ENABLED, META_AGENT_ID, toApiAgent, startAgentProcess, setAgentStatus } from "./agent-utils";
import { AgentDB } from "../../db";
import { ProviderKeys, Onboarding, PROVIDERS } from "../../providers";
import { agentProcesses } from "../../server";

export async function handleMetaAgentRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // GET /api/meta-agent/status - Get meta agent status and config
  if (path === "/api/meta-agent/status" && method === "GET") {
    if (!META_AGENT_ENABLED) {
      return json({ enabled: false });
    }

    // Check if onboarding is complete
    if (!Onboarding.isComplete()) {
      return json({ enabled: true, available: false, reason: "onboarding_incomplete" });
    }

    // Get first configured provider
    const configuredProviders = ProviderKeys.getConfiguredProviders();
    if (configuredProviders.length === 0) {
      return json({ enabled: true, available: false, reason: "no_provider" });
    }

    const providerId = configuredProviders[0] as keyof typeof PROVIDERS;
    const provider = PROVIDERS[providerId];
    if (!provider) {
      return json({ enabled: true, available: false, reason: "invalid_provider" });
    }

    // Check if meta agent exists, create if not
    let metaAgent = AgentDB.findById(META_AGENT_ID);
    if (!metaAgent) {
      // Find a recommended model or use first one
      const defaultModel = provider.models.find((m: any) => m.recommended)?.value || provider.models[0]?.value;
      if (!defaultModel) {
        return json({ enabled: true, available: false, reason: "no_model" });
      }

      // Create the meta agent
      metaAgent = AgentDB.create({
        id: META_AGENT_ID,
        name: "Apteva Assistant",
        model: defaultModel,
        provider: providerId,
        system_prompt: `You are the Apteva Assistant, a helpful guide for users of the Apteva agent management platform.

You can help users with:
- Creating and configuring AI agents
- Setting up MCP servers for tool integrations
- Managing projects and organizing agents
- Explaining features like Memory, Tasks, Vision, Operator, Files, and Multi-Agent
- Troubleshooting common issues

Be concise, friendly, and helpful. When users ask about creating something, guide them step by step.
Keep responses short and actionable. Use markdown formatting when helpful.`,
        features: {
          memory: false,
          tasks: false,
          vision: false,
          operator: false,
          mcp: false,
          realtime: false,
          files: false,
          agents: false,
        },
        mcp_servers: [],
        skills: [],
        project_id: null, // Meta agent belongs to no project
      } as any);
    }

    // Return status
    return json({
      enabled: true,
      available: true,
      agent: {
        id: metaAgent.id,
        name: metaAgent.name,
        status: metaAgent.status,
        port: metaAgent.port,
        provider: metaAgent.provider,
        model: metaAgent.model,
      },
    });
  }

  // POST /api/meta-agent/start - Start the meta agent
  if (path === "/api/meta-agent/start" && method === "POST") {
    if (!META_AGENT_ENABLED) {
      return json({ error: "Meta agent is not enabled" }, 400);
    }

    const metaAgent = AgentDB.findById(META_AGENT_ID);
    if (!metaAgent) {
      return json({ error: "Meta agent not found" }, 404);
    }

    if (metaAgent.status === "running") {
      return json({ agent: toApiAgent(metaAgent), message: "Already running" });
    }

    // Start the agent using existing startAgentProcess function
    const result = await startAgentProcess(metaAgent, { silent: true });
    if (!result.success) {
      return json({ error: result.error || "Failed to start meta agent" }, 500);
    }

    const updated = AgentDB.findById(META_AGENT_ID);
    return json({ agent: updated ? toApiAgent(updated) : null });
  }

  // POST /api/meta-agent/stop - Stop the meta agent
  if (path === "/api/meta-agent/stop" && method === "POST") {
    if (!META_AGENT_ENABLED) {
      return json({ error: "Meta agent is not enabled" }, 400);
    }

    const metaAgent = AgentDB.findById(META_AGENT_ID);
    if (!metaAgent) {
      return json({ error: "Meta agent not found" }, 404);
    }

    if (metaAgent.status === "stopped") {
      return json({ agent: toApiAgent(metaAgent), message: "Already stopped" });
    }

    // Stop the agent
    const proc = agentProcesses.get(META_AGENT_ID);
    if (proc) {
      proc.proc.kill(); // BUG FIX: was proc.kill() which would fail
      agentProcesses.delete(META_AGENT_ID);
    }
    setAgentStatus(META_AGENT_ID, "stopped", "user_stopped");

    const updated = AgentDB.findById(META_AGENT_ID);
    return json({ agent: updated ? toApiAgent(updated) : null });
  }

  return null;
}
