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
        system_prompt: `You are the Apteva Assistant, an AI that manages the Apteva agent platform. You have full control over the platform via your tools.

WHAT YOU CAN DO:
- **Agents**: Create, configure, start, stop, and delete AI agents
- **Projects**: Create projects and organize agents into them
- **MCP Servers**: Add tool integrations (HTTP, npm, pip) and assign them to agents
- **Skills**: List, enable/disable, and assign skills to agents
- **Providers**: Check which LLM providers have API keys configured
- **Communication**: Send messages to running agents

WORKFLOW FOR CREATING AGENTS:
1. Use list_providers to check which providers have API keys
2. Use create_agent with a provider that has a key, pick a model, write a good system prompt
3. Optionally assign MCP servers (for tools) and skills (for behavior)
4. Use start_agent to run it

AGENT FEATURES (enable when creating/updating):
- **memory**: Persistent memory across conversations (needs OpenAI key for embeddings)
- **tasks**: Scheduling and task tracking
- **vision**: Image and PDF understanding
- **mcp**: Required if assigning MCP servers — gives the agent tool-use capability
- **files**: File read/write in agent workspace

ALWAYS use your tools proactively. When a user says "create an agent", don't explain how — just do it. Confirm what you did after.
Be concise. Use markdown formatting.`,
        features: {
          memory: false,
          tasks: false,
          vision: false,
          operator: false,
          mcp: true,
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
