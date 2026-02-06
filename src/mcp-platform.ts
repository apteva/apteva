// Built-in MCP server that exposes the Apteva platform API as MCP tools
// This allows the meta agent (Apteva Assistant) to control the platform

import { AgentDB, ProjectDB, McpServerDB, TelemetryDB, generateId } from "./db";
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
    description: "List all configured MCP servers (tool integrations).",
    inputSchema: {
      type: "object",
      properties: {},
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
        const servers = McpServerDB.findAll();
        const result = servers.map(s => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          url: s.url,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_dashboard_stats": {
        const agentCount = AgentDB.count();
        const runningCount = AgentDB.countRunning();
        const projectCount = ProjectDB.count();
        const providers = getProvidersWithStatus().filter(p => p.type === "llm");
        const configuredProviders = providers.filter(p => p.hasKey).length;
        const mcpServers = McpServerDB.findAll().length;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agents: { total: agentCount - 1, running: runningCount }, // -1 for meta agent
              projects: projectCount,
              providers: { total: providers.length, configured: configuredProviders },
              mcpServers,
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
