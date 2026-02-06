// Built-in MCP server that exposes the Apteva platform API as MCP tools
// This allows the meta agent (Apteva Assistant) to control the platform

import { AgentDB, ProjectDB, McpServerDB, SkillDB, TelemetryDB, generateId } from "./db";
import { getProvidersWithStatus, PROVIDERS } from "./providers";
import { startAgentProcess, setAgentStatus, toApiAgent, META_AGENT_ID, agentFetch } from "./routes/api/agent-utils";
import { agentProcesses } from "./server";

// MCP Protocol version
const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Tool definitions
const PLATFORM_TOOLS = [
  {
    name: "list_agents",
    description: "List all agents on the platform. Optionally filter by project ID.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project ID (optional)" },
      },
    },
  },
  {
    name: "get_agent",
    description: "Get detailed information about a specific agent by ID.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "create_agent",
    description: "Create a new AI agent. Requires a name, provider, and model. The provider must have an API key configured.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name" },
        provider: { type: "string", description: "LLM provider ID (e.g. anthropic, openai, groq, gemini, xai, together, fireworks, ollama)" },
        model: { type: "string", description: "Model ID (e.g. claude-sonnet-4-5, gpt-4o, llama-3.3-70b-versatile)" },
        system_prompt: { type: "string", description: "System prompt for the agent (optional)" },
        project_id: { type: "string", description: "Project ID to assign the agent to (optional)" },
        features: {
          type: "object",
          description: "Feature flags (optional). All default to false.",
          properties: {
            memory: { type: "boolean" },
            tasks: { type: "boolean" },
            vision: { type: "boolean" },
            mcp: { type: "boolean" },
            files: { type: "boolean" },
          },
        },
      },
      required: ["name", "provider", "model"],
    },
  },
  {
    name: "update_agent",
    description: "Update an existing agent's configuration. Only provide fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to update" },
        name: { type: "string", description: "New name" },
        model: { type: "string", description: "New model ID" },
        provider: { type: "string", description: "New provider ID" },
        system_prompt: { type: "string", description: "New system prompt" },
        project_id: { type: "string", description: "New project ID (or null to unassign)" },
        features: { type: "object", description: "Feature flags to update" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "delete_agent",
    description: "Delete an agent. The agent must be stopped first.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to delete" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "start_agent",
    description: "Start a stopped agent. The agent's provider must have an API key configured.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to start" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to stop" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "list_projects",
    description: "List all projects with their agent counts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_project",
    description: "Create a new project for organizing agents.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Project description (optional)" },
        color: { type: "string", description: "Hex color code (optional, default #6366f1)" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_providers",
    description: "List all available LLM providers and their configuration status (which have API keys).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_mcp_servers",
    description: "List all configured MCP servers (tool integrations). Optionally filter by project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project ID (optional)" },
      },
    },
  },
  {
    name: "get_mcp_server",
    description: "Get detailed information about an MCP server by ID.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "The MCP server ID" },
      },
      required: ["server_id"],
    },
  },
  {
    name: "create_mcp_server",
    description: "Create a new MCP server. For HTTP (remote) servers, provide url and optional headers. For npm package servers, provide a package name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server display name" },
        type: { type: "string", description: "Server type: 'http' (remote URL), 'npm' (npm package), 'pip' (Python package), 'custom' (custom command)" },
        url: { type: "string", description: "For http type: the remote MCP server URL" },
        headers: { type: "object", description: "For http type: auth headers (e.g. {\"Authorization\": \"Bearer ...\"})" },
        package: { type: "string", description: "For npm/pip type: the package name (e.g. '@modelcontextprotocol/server-filesystem')" },
        command: { type: "string", description: "For custom type: the command to run" },
        args: { type: "string", description: "Command arguments (optional)" },
        project_id: { type: "string", description: "Project ID to scope the server to (optional, null = global)" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "delete_mcp_server",
    description: "Delete an MCP server. It must be stopped first.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "The MCP server ID to delete" },
      },
      required: ["server_id"],
    },
  },
  {
    name: "assign_mcp_server_to_agent",
    description: "Assign an MCP server to an agent so the agent can use its tools. The agent must have MCP feature enabled.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
        server_id: { type: "string", description: "The MCP server ID to assign" },
      },
      required: ["agent_id", "server_id"],
    },
  },
  {
    name: "unassign_mcp_server_from_agent",
    description: "Remove an MCP server from an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
        server_id: { type: "string", description: "The MCP server ID to remove" },
      },
      required: ["agent_id", "server_id"],
    },
  },
  {
    name: "get_dashboard_stats",
    description: "Get platform overview stats: agent counts, task counts, provider counts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_message",
    description: "Send a chat message to a running agent and get the response.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to message" },
        message: { type: "string", description: "The message to send" },
      },
      required: ["agent_id", "message"],
    },
  },
  // Skills management
  {
    name: "list_skills",
    description: "List all installed skills. Skills are reusable instruction sets that give agents specialized capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: { type: "boolean", description: "Only return enabled skills (optional, default false)" },
      },
    },
  },
  {
    name: "get_skill",
    description: "Get detailed information about a skill by ID, including its full instructions content.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "The skill ID" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "toggle_skill",
    description: "Enable or disable a skill.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "The skill ID" },
        enabled: { type: "boolean", description: "Whether to enable (true) or disable (false) the skill" },
      },
      required: ["skill_id", "enabled"],
    },
  },
  {
    name: "assign_skill_to_agent",
    description: "Assign a skill to an agent so it can use those instructions.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
        skill_id: { type: "string", description: "The skill ID to assign" },
      },
      required: ["agent_id", "skill_id"],
    },
  },
  {
    name: "unassign_skill_from_agent",
    description: "Remove a skill from an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
        skill_id: { type: "string", description: "The skill ID to remove" },
      },
      required: ["agent_id", "skill_id"],
    },
  },
  {
    name: "delete_skill",
    description: "Delete a skill. It will be unassigned from all agents.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "The skill ID to delete" },
      },
      required: ["skill_id"],
    },
  },
];

// Tool execution handlers
async function executeTool(name: string, args: Record<string, any>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case "list_agents": {
        const agents = args.project_id
          ? AgentDB.findByProject(args.project_id)
          : AgentDB.findAll();
        // Exclude meta agent from list
        const filtered = agents.filter(a => a.id !== META_AGENT_ID);
        const result = filtered.map(a => ({
          id: a.id,
          name: a.name,
          provider: a.provider,
          model: a.model,
          status: a.status,
          port: a.port,
          projectId: a.project_id,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(toApiAgent(agent), null, 2) }] };
      }

      case "create_agent": {
        // Validate provider exists
        const providerId = args.provider as keyof typeof PROVIDERS;
        const provider = PROVIDERS[providerId];
        if (!provider || provider.type !== "llm") {
          return { content: [{ type: "text", text: `Invalid provider: ${args.provider}. Valid providers: ${Object.values(PROVIDERS).filter(p => p.type === "llm").map(p => p.id).join(", ")}` }], isError: true };
        }

        const id = generateId();
        const agent = AgentDB.create({
          id,
          name: args.name,
          model: args.model,
          provider: args.provider,
          system_prompt: args.system_prompt || `You are ${args.name}, a helpful AI assistant.`,
          features: {
            memory: args.features?.memory ?? false,
            tasks: args.features?.tasks ?? false,
            vision: args.features?.vision ?? false,
            operator: false,
            mcp: args.features?.mcp ?? false,
            realtime: false,
            files: args.features?.files ?? false,
            agents: false,
          },
          mcp_servers: [],
          skills: [],
          project_id: args.project_id || null,
        });

        return { content: [{ type: "text", text: `Agent created successfully:\n${JSON.stringify({ id: agent.id, name: agent.name, provider: agent.provider, model: agent.model, port: agent.port }, null, 2)}` }] };
      }

      case "update_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }

        const updates: any = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.model !== undefined) updates.model = args.model;
        if (args.provider !== undefined) updates.provider = args.provider;
        if (args.system_prompt !== undefined) updates.system_prompt = args.system_prompt;
        if (args.project_id !== undefined) updates.project_id = args.project_id;
        if (args.features !== undefined) {
          updates.features = { ...agent.features, ...args.features };
        }

        const updated = AgentDB.update(args.agent_id, updates);
        return { content: [{ type: "text", text: `Agent updated: ${JSON.stringify({ id: updated?.id, name: updated?.name }, null, 2)}` }] };
      }

      case "delete_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        if (agent.status === "running") {
          return { content: [{ type: "text", text: "Cannot delete a running agent. Stop it first." }], isError: true };
        }
        if (agent.id === META_AGENT_ID) {
          return { content: [{ type: "text", text: "Cannot delete the Apteva Assistant." }], isError: true };
        }
        AgentDB.delete(args.agent_id);
        return { content: [{ type: "text", text: `Agent deleted: ${agent.name} (${agent.id})` }] };
      }

      case "start_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        if (agent.status === "running") {
          return { content: [{ type: "text", text: `Agent ${agent.name} is already running on port ${agent.port}` }] };
        }

        const result = await startAgentProcess(agent);
        if (!result.success) {
          return { content: [{ type: "text", text: `Failed to start agent: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Agent ${agent.name} started on port ${result.port}` }] };
      }

      case "stop_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        if (agent.status === "stopped") {
          return { content: [{ type: "text", text: `Agent ${agent.name} is already stopped` }] };
        }
        if (agent.id === META_AGENT_ID) {
          return { content: [{ type: "text", text: "Cannot stop yourself (the Apteva Assistant)." }], isError: true };
        }

        const proc = agentProcesses.get(args.agent_id);
        if (proc) {
          proc.proc.kill();
          agentProcesses.delete(args.agent_id);
        }
        setAgentStatus(args.agent_id, "stopped", "meta_agent");
        return { content: [{ type: "text", text: `Agent ${agent.name} stopped` }] };
      }

      case "list_projects": {
        const projects = ProjectDB.findAll();
        const agentCounts = ProjectDB.getAgentCounts();
        const result = projects.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          color: p.color,
          agentCount: agentCounts.get(p.id) || 0,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "create_project": {
        const project = ProjectDB.create({
          name: args.name,
          description: args.description || null,
          color: args.color,
        });
        return { content: [{ type: "text", text: `Project created: ${JSON.stringify({ id: project.id, name: project.name, color: project.color }, null, 2)}` }] };
      }

      case "list_providers": {
        const providers = getProvidersWithStatus();
        const llmProviders = providers.filter(p => p.type === "llm");
        const result = llmProviders.map(p => ({
          id: p.id,
          name: p.name,
          hasKey: p.hasKey,
          models: p.models,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_mcp_servers": {
        const servers = args.project_id
          ? McpServerDB.findByProject(args.project_id)
          : McpServerDB.findAll();
        const result = servers.map(s => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          url: s.url,
          package: s.package,
          projectId: s.project_id,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_mcp_server": {
        const server = McpServerDB.findById(args.server_id);
        if (!server) {
          return { content: [{ type: "text", text: `MCP server not found: ${args.server_id}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({
          id: server.id,
          name: server.name,
          type: server.type,
          status: server.status,
          url: server.url,
          package: server.package,
          command: server.command,
          args: server.args,
          port: server.port,
          source: server.source,
          projectId: server.project_id,
        }, null, 2) }] };
      }

      case "create_mcp_server": {
        const id = generateId();
        const server = McpServerDB.create({
          id,
          name: args.name,
          type: args.type || "http",
          package: args.package || null,
          pip_module: null,
          command: args.command || null,
          args: args.args || null,
          env: {},
          url: args.url || null,
          headers: args.headers || {},
          source: null,
          project_id: args.project_id || null,
        });
        return { content: [{ type: "text", text: `MCP server created: ${JSON.stringify({ id: server.id, name: server.name, type: server.type }, null, 2)}` }] };
      }

      case "delete_mcp_server": {
        const server = McpServerDB.findById(args.server_id);
        if (!server) {
          return { content: [{ type: "text", text: `MCP server not found: ${args.server_id}` }], isError: true };
        }
        if (server.status === "running") {
          return { content: [{ type: "text", text: "Cannot delete a running MCP server. Stop it first." }], isError: true };
        }
        McpServerDB.delete(args.server_id);
        return { content: [{ type: "text", text: `MCP server deleted: ${server.name} (${server.id})` }] };
      }

      case "assign_mcp_server_to_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        const server = McpServerDB.findById(args.server_id);
        if (!server) {
          return { content: [{ type: "text", text: `MCP server not found: ${args.server_id}` }], isError: true };
        }
        const mcpServers = agent.mcp_servers || [];
        if (mcpServers.includes(args.server_id)) {
          return { content: [{ type: "text", text: `Server ${server.name} is already assigned to ${agent.name}` }] };
        }
        AgentDB.update(args.agent_id, { mcp_servers: [...mcpServers, args.server_id] });
        // Enable MCP feature if not already
        if (!agent.features.mcp) {
          AgentDB.update(args.agent_id, { features: { ...agent.features, mcp: true } });
        }
        return { content: [{ type: "text", text: `Assigned MCP server "${server.name}" to agent "${agent.name}". Restart the agent for changes to take effect.` }] };
      }

      case "unassign_mcp_server_from_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        const mcpServers = agent.mcp_servers || [];
        if (!mcpServers.includes(args.server_id)) {
          return { content: [{ type: "text", text: `Server is not assigned to this agent` }] };
        }
        AgentDB.update(args.agent_id, { mcp_servers: mcpServers.filter((id: string) => id !== args.server_id) });
        return { content: [{ type: "text", text: `Removed MCP server from agent "${agent.name}". Restart the agent for changes to take effect.` }] };
      }

      case "get_dashboard_stats": {
        const agentCount = AgentDB.count();
        const runningCount = AgentDB.countRunning();
        const projectCount = ProjectDB.count();
        const providers = getProvidersWithStatus().filter(p => p.type === "llm");
        const configuredProviders = providers.filter(p => p.hasKey).length;
        const mcpServerCount = McpServerDB.findAll().length;
        const skillCount = SkillDB.count();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agents: { total: agentCount - 1, running: runningCount }, // -1 for meta agent
              projects: projectCount,
              providers: { total: providers.length, configured: configuredProviders },
              mcpServers: mcpServerCount,
              skills: skillCount,
            }, null, 2),
          }],
        };
      }

      case "send_message": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        if (agent.status !== "running" || !agent.port) {
          return { content: [{ type: "text", text: `Agent ${agent.name} is not running` }], isError: true };
        }

        try {
          const res = await agentFetch(args.agent_id, agent.port, "/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: args.message }),
            signal: AbortSignal.timeout(60000),
          });

          if (!res.ok) {
            const err = await res.text().catch(() => "Unknown error");
            return { content: [{ type: "text", text: `Agent responded with error: ${err}` }], isError: true };
          }

          const data = await res.json();
          const reply = data.response || data.message || JSON.stringify(data);
          return { content: [{ type: "text", text: reply }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to communicate with agent: ${err}` }], isError: true };
        }
      }

      case "list_skills": {
        const skills = args.enabled_only ? SkillDB.findEnabled() : SkillDB.findAll();
        const result = skills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
          enabled: s.enabled,
          source: s.source,
          projectId: s.project_id,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_skill": {
        const skill = SkillDB.findById(args.skill_id);
        if (!skill) {
          return { content: [{ type: "text", text: `Skill not found: ${args.skill_id}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          content: skill.content.slice(0, 500) + (skill.content.length > 500 ? "..." : ""),
          version: skill.version,
          enabled: skill.enabled,
          source: skill.source,
          allowedTools: skill.allowed_tools,
          projectId: skill.project_id,
        }, null, 2) }] };
      }

      case "toggle_skill": {
        const skill = SkillDB.findById(args.skill_id);
        if (!skill) {
          return { content: [{ type: "text", text: `Skill not found: ${args.skill_id}` }], isError: true };
        }
        SkillDB.setEnabled(args.skill_id, args.enabled);
        return { content: [{ type: "text", text: `Skill "${skill.name}" ${args.enabled ? "enabled" : "disabled"}` }] };
      }

      case "assign_skill_to_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        const skill = SkillDB.findById(args.skill_id);
        if (!skill) {
          return { content: [{ type: "text", text: `Skill not found: ${args.skill_id}` }], isError: true };
        }
        const skills = agent.skills || [];
        if (skills.includes(args.skill_id)) {
          return { content: [{ type: "text", text: `Skill "${skill.name}" is already assigned to "${agent.name}"` }] };
        }
        AgentDB.update(args.agent_id, { skills: [...skills, args.skill_id] });
        return { content: [{ type: "text", text: `Assigned skill "${skill.name}" to agent "${agent.name}". Restart the agent for changes to take effect.` }] };
      }

      case "unassign_skill_from_agent": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        const skills = agent.skills || [];
        if (!skills.includes(args.skill_id)) {
          return { content: [{ type: "text", text: `Skill is not assigned to this agent` }] };
        }
        AgentDB.update(args.agent_id, { skills: skills.filter((id: string) => id !== args.skill_id) });
        return { content: [{ type: "text", text: `Removed skill from agent "${agent.name}". Restart the agent for changes to take effect.` }] };
      }

      case "delete_skill": {
        const skill = SkillDB.findById(args.skill_id);
        if (!skill) {
          return { content: [{ type: "text", text: `Skill not found: ${args.skill_id}` }], isError: true };
        }
        // Unassign from all agents first
        const agentsWithSkill = AgentDB.findBySkill(args.skill_id);
        for (const agent of agentsWithSkill) {
          const updated = (agent.skills || []).filter((id: string) => id !== args.skill_id);
          AgentDB.update(agent.id, { skills: updated });
        }
        SkillDB.delete(args.skill_id);
        return { content: [{ type: "text", text: `Skill "${skill.name}" deleted${agentsWithSkill.length > 0 ? ` (unassigned from ${agentsWithSkill.length} agent(s))` : ""}` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Tool execution error: ${err}` }], isError: true };
  }
}

// Main MCP request handler
export async function handlePlatformMcpRequest(req: Request): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let body: JsonRpcRequest;
  try {
    body = await req.json() as JsonRpcRequest;
  } catch {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32700, message: "Parse error" },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { method, params, id } = body;

  let result: unknown;
  let error: { code: number; message: string } | undefined;

  switch (method) {
    case "initialize": {
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "apteva-platform",
          version: "1.0.0",
        },
        instructions: "This MCP server provides tools to control the Apteva AI agent platform. You can create, start, stop, and manage agents, projects, and view system status.",
      };
      break;
    }

    case "notifications/initialized": {
      // Acknowledgement - no response needed for notifications, but since this is HTTP we return ok
      result = {};
      break;
    }

    case "tools/list": {
      result = { tools: PLATFORM_TOOLS };
      break;
    }

    case "tools/call": {
      const { name, arguments: args } = params as { name: string; arguments: Record<string, any> };
      result = await executeTool(name, args || {});
      break;
    }

    default: {
      error = { code: -32601, message: `Method not found: ${method}` };
    }
  }

  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: id || 0,
    ...(error ? { error } : { result }),
  };

  return new Response(JSON.stringify(response), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
