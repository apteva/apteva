// Built-in MCP server that exposes the Apteva platform API as MCP tools
// This allows the meta agent (Apteva Assistant) to control the platform

import { AgentDB, ProjectDB, McpServerDB, McpServerToolDB, SkillDB, TelemetryDB, SubscriptionDB, SettingsDB, generateId } from "./db";
import { TestCaseDB, TestRunDB } from "./db-tests";
import { runTest, runAll } from "./test-runner";
import { getProvidersWithStatus, PROVIDERS, ProviderKeys } from "./providers";
import { startAgentProcess, setAgentStatus, toApiAgent, META_AGENT_ID, agentFetch } from "./routes/api/agent-utils";
import { agentProcesses } from "./server";
import { getTriggerProvider, getTriggerProviderIds, registerTriggerProvider } from "./triggers";
import { ComposioTriggerProvider } from "./triggers/composio";
import { AgentDojoTriggerProvider } from "./triggers/agentdojo";
import { getProvider, getProviderIds, registerProvider } from "./integrations";
import { ComposioProvider } from "./integrations/composio";
import {
  AgentDojoProvider,
  listServers as listAgentDojoServers,
  createServer as createAgentDojoServer,
  getServer as getAgentDojoServer,
} from "./integrations/agentdojo";
import {
  listMcpServers as listComposioServers,
  createMcpServer as createComposioServer,
  getAuthConfigForToolkit as getComposioAuthConfig,
  getUserIdForAuthConfig as getComposioUserForAuth,
  createMcpServerInstance as createComposioInstance,
} from "./integrations/composio";

// Register trigger + integration providers on module load
registerTriggerProvider(ComposioTriggerProvider);
registerTriggerProvider(AgentDojoTriggerProvider);
registerProvider(ComposioProvider);
registerProvider(AgentDojoProvider);

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
    description: `Create a new AI agent. The provider must have an API key configured — use list_providers first to check.

PROVIDERS & MODELS (use list_providers to see which have keys):
- anthropic: claude-sonnet-4-6 (recommended), claude-sonnet-4-5, claude-haiku-4-5 (fast/cheap)
- openai: gpt-4o (recommended), gpt-4o-mini (fast/cheap)
- groq: llama-3.3-70b-versatile (recommended), llama-3.1-8b-instant (fast)
- gemini: gemini-3-pro-preview (recommended), gemini-3-flash-preview (fast)
- xai: grok-2 (recommended), grok-2-mini (fast)
- together: moonshotai/Kimi-K2.5 (recommended), moonshotai/Kimi-K2-Thinking (reasoning)
- fireworks: accounts/fireworks/models/kimi-k2p5, accounts/fireworks/models/kimi-k2-thinking
- moonshot: moonshot-v1-128k (recommended), moonshot-v1-32k (fast)
- ollama: llama3.3, llama3.2, qwen2.5, mistral, deepseek-r1 (local, no API key needed)

FEATURES (all optional, default false):
- memory: Persistent memory across conversations — agent remembers past interactions. Requires OpenAI key for embeddings.
- tasks: Task scheduling — agent can create, schedule, and track tasks. Supports recurring tasks.
- vision: Image & PDF understanding — agent can analyze uploaded images and PDFs.
- mcp: MCP tool use — agent can use tools from assigned MCP servers. Enable this if you plan to assign MCP servers.
- files: File management — agent can read, write, and manage files in its workspace.

TIPS:
- Always provide a descriptive system_prompt that tells the agent what it does and how to behave.
- Assign to a project_id to organize agents. Use list_projects to see available projects.
- After creating, use start_agent to run it. Then assign MCP servers or skills as needed.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (e.g. 'Customer Support', 'Code Reviewer')" },
        provider: { type: "string", description: "LLM provider ID: anthropic, openai, groq, gemini, xai, together, fireworks, moonshot, ollama" },
        model: { type: "string", description: "Model ID — see tool description for full list per provider" },
        system_prompt: { type: "string", description: "Instructions for the agent. Describe its role, personality, and capabilities. This is the most important field for agent behavior." },
        project_id: { type: "string", description: "Project ID to assign the agent to (optional). Use list_projects to find IDs." },
        features: {
          type: "object",
          description: "Feature flags to enable. All default to false. See tool description for details on each feature.",
          properties: {
            memory: { type: "boolean", description: "Persistent memory across conversations (requires OpenAI key for embeddings)" },
            tasks: { type: "boolean", description: "Task scheduling and tracking" },
            vision: { type: "boolean", description: "Image and PDF understanding" },
            mcp: { type: "boolean", description: "MCP tool use — required if assigning MCP servers" },
            files: { type: "boolean", description: "File read/write in agent workspace" },
          },
        },
      },
      required: ["name", "provider", "model"],
    },
  },
  {
    name: "update_agent",
    description: `Update an existing agent's configuration. Only provide fields you want to change. If the agent is running, restart it after updating for changes to take effect.

SKILLS & MCP SERVERS:
- Pass skill_ids or mcp_server_ids to SET the full list (replaces existing).
- Use add_skills / remove_skills to add/remove individual skills without replacing the whole list.
- Use add_mcp_servers / remove_mcp_servers to add/remove individual MCP servers.
- Adding MCP servers automatically enables the mcp feature.
- Use list_skills and list_mcp_servers to find IDs.`,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to update" },
        name: { type: "string", description: "New display name" },
        model: { type: "string", description: "New model ID (see create_agent for available models per provider)" },
        provider: { type: "string", description: "New provider ID (the new provider must have an API key configured)" },
        system_prompt: { type: "string", description: "New system prompt / instructions" },
        project_id: { type: "string", description: "New project ID, or null to unassign from project" },
        features: {
          type: "object",
          description: "Feature flags to update (only provided flags are changed, others remain as-is)",
          properties: {
            memory: { type: "boolean" },
            tasks: { type: "boolean" },
            vision: { type: "boolean" },
            mcp: { type: "boolean" },
            files: { type: "boolean" },
          },
        },
        skill_ids: { type: "array", items: { type: "string" }, description: "Set the full list of skill IDs (replaces existing)" },
        add_skills: { type: "array", items: { type: "string" }, description: "Skill IDs to add (keeps existing)" },
        remove_skills: { type: "array", items: { type: "string" }, description: "Skill IDs to remove" },
        mcp_server_ids: { type: "array", items: { type: "string" }, description: "Set the full list of MCP server IDs (replaces existing)" },
        add_mcp_servers: { type: "array", items: { type: "string" }, description: "MCP server IDs to add (keeps existing)" },
        remove_mcp_servers: { type: "array", items: { type: "string" }, description: "MCP server IDs to remove" },
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
    description: "Start a stopped agent. The agent's provider must have an API key configured. Starting spawns a process, waits for health check, and pushes configuration (model, features, MCP servers, skills). Takes a few seconds.",
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
    description: `Create a new MCP server configuration. MCP servers provide tools that agents can use (web search, file access, APIs, etc).

SERVER TYPES:
- local: Runs inside the apteva server — no external process needed. Add tools with add_tool_to_local_server. Ready to use immediately after adding tools.
- http: Remote MCP server accessible via URL. Provide url and optional auth headers. Ready to use immediately.
- npm: Node.js MCP server from npm. Provide package name (e.g. '@modelcontextprotocol/server-filesystem'). Needs to be started.
- pip: Python MCP server from PyPI. Provide package name. Needs to be started.
- custom: Custom command. Provide command and args. Needs to be started.

After creating, assign to agents with assign_mcp_server_to_agent. Local and HTTP servers work immediately; npm/pip/custom servers need to be started from the MCP page in the UI.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name (e.g. 'Filesystem', 'Web Search', 'GitHub')" },
        type: { type: "string", description: "Server type: http, npm, pip, or custom" },
        url: { type: "string", description: "For http type: the remote MCP server URL (e.g. 'https://mcp.example.com/sse')" },
        headers: { type: "object", description: "For http type: auth headers as key-value pairs" },
        package: { type: "string", description: "For npm/pip type: package name" },
        command: { type: "string", description: "For custom type: executable command" },
        args: { type: "string", description: "Command arguments string (optional)" },
        project_id: { type: "string", description: "Scope to a project (optional). null = available globally to all agents." },
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
    name: "add_tool_to_local_server",
    description: `Add a tool to a local MCP server. Only works for servers with type "local".

HANDLER TYPES:
- mock: Returns a static/templated response. Use mock_response with template variables: {{args.field}}, {{uuid()}}, {{now}}, {{timestamp}}, {{random_int(min,max)}}.
- http: Makes a real HTTP API call. Provide http_config with method, url, headers, and optional body. Templates work in url/headers/body. Use {{credential.KEY}} to reference server env vars for auth.
- javascript: Runs custom JavaScript code. The code receives args, credentials, and helper functions (uuid, now, timestamp, random_int, random_float). Return a value or JSON object.

EXAMPLES:
- Mock: handler_type="mock", mock_response={"greeting": "Hello {{args.name}}!", "id": "{{uuid()}}"}
- HTTP: handler_type="http", http_config={"method": "GET", "url": "https://api.example.com/users/{{args.user_id}}", "headers": {"Authorization": "Bearer {{credential.API_KEY}}"}}
- JavaScript: handler_type="javascript", code="return { sum: args.a + args.b, computed_at: now }"`,
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "The local MCP server ID" },
        name: { type: "string", description: "Tool name (snake_case, e.g. 'get_weather', 'create_ticket')" },
        description: { type: "string", description: "What this tool does (shown to the agent)" },
        input_schema: {
          type: "object",
          description: "JSON Schema for tool parameters. Must have type='object' with properties.",
        },
        handler_type: { type: "string", description: "How the tool executes: mock, http, or javascript" },
        mock_response: { type: "object", description: "For mock handler: the response template (supports {{args.field}}, {{uuid()}}, {{now}})" },
        http_config: {
          type: "object",
          description: "For http handler: { method, url, headers?, body? }. Templates supported in all fields.",
        },
        code: { type: "string", description: "For javascript handler: JS code to execute. Has access to args, credentials, uuid, now, timestamp, random_int, random_float. Must return a value." },
      },
      required: ["server_id", "name", "description", "input_schema", "handler_type"],
    },
  },
  {
    name: "update_tool_on_local_server",
    description: `Update an existing tool on a local MCP server. Only provide fields you want to change. Only works for servers with type "local".`,
    inputSchema: {
      type: "object",
      properties: {
        tool_id: { type: "string", description: "The tool ID to update" },
        name: { type: "string", description: "New tool name" },
        description: { type: "string", description: "New description" },
        input_schema: { type: "object", description: "New JSON Schema for tool parameters" },
        handler_type: { type: "string", description: "New handler type: mock, http, or javascript" },
        mock_response: { type: "object", description: "New mock response template" },
        http_config: { type: "object", description: "New HTTP config: { method, url, headers?, body? }" },
        code: { type: "string", description: "New JavaScript code" },
        enabled: { type: "boolean", description: "Enable or disable the tool" },
      },
      required: ["tool_id"],
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
    description: "List all installed skills. Skills are reusable instruction sets (like prompt templates with tool permissions) that give agents specialized capabilities. Skills can be installed from the SkillsMP marketplace or created locally. Pass project_id to only see skills scoped to that project (plus global skills).",
    inputSchema: {
      type: "object",
      properties: {
        enabled_only: { type: "boolean", description: "Only return enabled skills (optional, default false)" },
        project_id: { type: "string", description: "Filter by project ID — returns skills scoped to this project plus global skills" },
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
    name: "update_skill",
    description: "Update an existing skill. Only provide fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "The skill ID to update" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        content: { type: "string", description: "New instructions content (markdown)" },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description: "New list of allowed MCP tool names",
        },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "create_skill",
    description: "Create a new skill. Skills are reusable instruction sets (markdown content) that give agents specialized capabilities. Provide a name, description, and the full instructions content (markdown). Optionally specify allowed MCP tools. If the user is working within a project, set project_id to scope the skill to that project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name" },
        description: { type: "string", description: "Short description of what the skill does" },
        content: { type: "string", description: "Full skill instructions in markdown format" },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of MCP tool names this skill is allowed to use",
        },
        project_id: { type: "string", description: "Project ID to scope the skill to. Use the current project ID from context when the user is working within a project. Omit for a global skill." },
      },
      required: ["name", "description", "content"],
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
  // Test tools
  {
    name: "list_tests",
    description: "List all test cases. Tests validate agent workflows by sending a message and using an LLM judge to evaluate the result.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Optional project ID to filter tests" },
      },
    },
  },
  {
    name: "create_test",
    description: "Create a new test case for an agent. The test sends a message to the agent, then an LLM judge evaluates the conversation against the success criteria.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Test name" },
        agent_id: { type: "string", description: "Agent ID to test" },
        input_message: { type: "string", description: "Message to send to the agent" },
        eval_criteria: { type: "string", description: "Natural language success criteria for the LLM judge. E.g. 'The agent should use the post_tweet tool and confirm the post was made.'" },
        description: { type: "string", description: "Optional description" },
        timeout_ms: { type: "number", description: "Timeout in ms (default 60000)" },
      },
      required: ["name", "agent_id", "input_message", "eval_criteria"],
    },
  },
  {
    name: "run_test",
    description: "Run a test case. The agent must be running. Returns pass/fail with LLM judge reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        test_id: { type: "string", description: "Test case ID to run. Use list_tests to find IDs." },
      },
      required: ["test_id"],
    },
  },
  {
    name: "run_all_tests",
    description: "Run all test cases (or specific ones). Returns summary of pass/fail results.",
    inputSchema: {
      type: "object",
      properties: {
        test_case_ids: { type: "array", items: { type: "string" }, description: "Optional array of test case IDs. If empty, runs all tests." },
      },
    },
  },
  {
    name: "get_test_results",
    description: "Get run history for a test case. Shows pass/fail status, judge reasoning, and duration.",
    inputSchema: {
      type: "object",
      properties: {
        test_id: { type: "string", description: "Test case ID" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["test_id"],
    },
  },
  {
    name: "delete_test",
    description: "Delete a test case and all its run history.",
    inputSchema: {
      type: "object",
      properties: {
        test_id: { type: "string", description: "Test case ID to delete" },
      },
      required: ["test_id"],
    },
  },
  // Subscription & Trigger management
  {
    name: "list_trigger_providers",
    description: "List available trigger/webhook providers (e.g. composio, agentdojo) and whether they have API keys configured.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
    },
  },
  {
    name: "list_trigger_types",
    description: `Browse available trigger types from a provider. Trigger types are events you can subscribe to (e.g. github:push, stripe:payment_intent, slack:message).

Each trigger type has:
- slug: unique identifier (e.g. "github:push")
- name: display name
- description: what the trigger does
- config_schema: JSON schema of required config fields (e.g. owner, repo for GitHub triggers)

Use this to find trigger slugs before creating a subscription.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Trigger provider ID: composio or agentdojo" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "list_subscriptions",
    description: "List local trigger subscriptions. Subscriptions route incoming webhook events to agents. Each subscription maps a trigger (e.g. github:push) to a specific agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent ID (optional)" },
        project_id: { type: "string", description: "Filter by project ID (optional)" },
      },
    },
  },
  {
    name: "create_subscription",
    description: `Create a trigger subscription: registers a webhook with the external service and routes events to an agent. The webhook URL is auto-configured — you do NOT need to provide a callback URL.

Just provide all 4 required fields in a single call:
- provider: "agentdojo" or "composio"
- trigger_slug: from list_trigger_types
- connected_account_id: from list_integration_connections
- agent_id: from list_agents

Some triggers require extra config fields (e.g. GitHub needs "owner" and "repo") — pass them in the config object.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Trigger provider ID: composio or agentdojo" },
        trigger_slug: { type: "string", description: "Trigger type slug (e.g. 'github:push', 'GITHUB_PUSH_EVENT'). Use list_trigger_types to find slugs." },
        connected_account_id: { type: "string", description: "Connected account ID that owns the integration. Use list_integration_connections to find IDs." },
        agent_id: { type: "string", description: "Agent ID to route trigger events to. Use list_agents to find IDs." },
        project_id: { type: "string", description: "Project ID for scoping (optional)" },
        config: {
          type: "object",
          description: "Extra config fields required by the trigger type (e.g. { owner: 'myorg', repo: 'myrepo' } for GitHub). Check config_schema from list_trigger_types.",
        },
      },
      required: ["provider", "trigger_slug", "connected_account_id", "agent_id"],
    },
  },
  {
    name: "enable_subscription",
    description: "Enable a disabled subscription so it starts routing events to the agent again. Optionally also enables the remote trigger on the provider.",
    inputSchema: {
      type: "object",
      properties: {
        subscription_id: { type: "string", description: "Local subscription ID" },
        provider: { type: "string", description: "Provider ID to also enable the remote trigger (optional)" },
        project_id: { type: "string", description: "Project ID for API key resolution (optional)" },
      },
      required: ["subscription_id"],
    },
  },
  {
    name: "disable_subscription",
    description: "Disable a subscription so it stops routing events to the agent. Optionally also disables the remote trigger on the provider.",
    inputSchema: {
      type: "object",
      properties: {
        subscription_id: { type: "string", description: "Local subscription ID" },
        provider: { type: "string", description: "Provider ID to also disable the remote trigger (optional)" },
        project_id: { type: "string", description: "Project ID for API key resolution (optional)" },
      },
      required: ["subscription_id"],
    },
  },
  {
    name: "delete_subscription",
    description: "Delete a local subscription. Optionally also deletes the remote trigger on the provider.",
    inputSchema: {
      type: "object",
      properties: {
        subscription_id: { type: "string", description: "Local subscription ID" },
        delete_remote: { type: "boolean", description: "Also delete the remote trigger on the provider (default false)" },
        provider: { type: "string", description: "Provider ID (required if delete_remote is true)" },
        project_id: { type: "string", description: "Project ID for API key resolution (optional)" },
      },
      required: ["subscription_id"],
    },
  },
  // Integration management tools
  {
    name: "list_integration_providers",
    description: "List available integration providers (e.g. agentdojo, composio) and whether they have API keys configured. Integration providers give access to third-party apps, OAuth connections, and MCP server creation.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
    },
  },
  {
    name: "list_integration_apps",
    description: `List available apps/toolkits from an integration provider. Each app represents a service (e.g. GitHub, Slack, Stripe) that can be connected via OAuth or API key.

Returns apps with their auth schemes (OAUTH2, API_KEY), connection status, and categories.
Use this to browse what's available before connecting an app.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
        search: { type: "string", description: "Optional search filter for app name/slug" },
      },
      required: ["provider"],
    },
  },
  {
    name: "connect_integration_app",
    description: `Connect/authenticate an app by storing credentials on the integration provider. This enables the app's tools to be used in MCP servers.

NOTE: Only API_KEY auth is supported from the assistant. For OAuth apps, direct the user to the Browse Toolkits UI.

Some apps require multiple credential fields (e.g. Pushover needs appToken + userKey). Use list_integration_apps to see credentialFields for each app — if present, pass all required fields in the "credentials" object. If the app has no credentialFields, pass a single "api_key".

WORKFLOW:
1. list_integration_apps to find the app and its credentialFields
2. connect_integration_app with the app slug and credentials
3. create_integration_config to create an MCP server from the connected app
4. add_integration_config_locally to add it as a local MCP server`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        app_slug: { type: "string", description: "App slug (from list_integration_apps)" },
        api_key: { type: "string", description: "Single API key (for apps with no credentialFields)" },
        credentials: {
          type: "object",
          description: "Credential fields as key-value pairs (e.g. { appToken: '...', userKey: '...' }). Use this for apps with multiple credentialFields. Takes priority over api_key.",
        },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider", "app_slug"],
    },
  },
  {
    name: "list_integration_connections",
    description: "List connected accounts (credentials) for an integration provider. Shows which apps have been authenticated and their status.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "disconnect_integration_app",
    description: "Disconnect/revoke a connected account (credential) from an integration provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        connection_id: { type: "string", description: "Connection/credential ID (from list_integration_connections)" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider", "connection_id"],
    },
  },
  {
    name: "list_integration_configs",
    description: "List MCP server configs on an integration provider. These are remote MCP servers hosted by the provider that can be added locally.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "create_integration_config",
    description: `Create an MCP server config on an integration provider from a connected app/toolkit. This creates a remote MCP server on the provider that bundles the app's tools.

After creation, use add_integration_config_locally to add it as a local MCP server.

WORKFLOW:
1. list_integration_apps → find the app slug
2. Ensure app is connected (list_integration_connections or connect_integration_app)
3. create_integration_config → creates remote MCP server
4. add_integration_config_locally → adds it locally so agents can use it`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        name: { type: "string", description: "Name for the MCP config (e.g. 'GitHub MCP', 'Slack Tools')" },
        toolkit_slug: { type: "string", description: "Toolkit/app slug to create the config from" },
        project_id: { type: "string", description: "Project ID for project-scoped API keys (optional)" },
      },
      required: ["provider", "name", "toolkit_slug"],
    },
  },
  {
    name: "add_integration_config_locally",
    description: `Add a remote integration MCP config as a local MCP server. This creates a local MCP server entry that connects to the provider's hosted MCP endpoint, making its tools available to agents.

After adding, use assign_mcp_server_to_agent to give an agent access to these tools.`,
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Integration provider ID: agentdojo or composio" },
        config_id: { type: "string", description: "Config/server ID on the provider (from list_integration_configs or create_integration_config)" },
        project_id: { type: "string", description: "Project ID to scope the local server to (optional)" },
      },
      required: ["provider", "config_id"],
    },
  },
];

// Build tools list — when PROJECTS_ENABLED, add project_id to required for all tools that accept it
function getPlatformTools() {
  const projectsEnabled = process.env.PROJECTS_ENABLED === "true";
  if (!projectsEnabled) return PLATFORM_TOOLS;

  return PLATFORM_TOOLS.map(tool => {
    const props = tool.inputSchema.properties as Record<string, unknown> | undefined;
    if (!props || !("project_id" in props)) return tool;

    const existing = (tool.inputSchema as any).required || [];
    if (existing.includes("project_id")) return tool;

    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        required: [...existing, "project_id"],
      },
    };
  });
}

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

        // Skills: set, add, or remove
        let skills = agent.skills || [];
        if (args.skill_ids !== undefined) {
          skills = args.skill_ids;
        }
        if (args.add_skills) {
          for (const sid of args.add_skills) {
            if (!skills.includes(sid)) skills.push(sid);
          }
        }
        if (args.remove_skills) {
          skills = skills.filter((id: string) => !args.remove_skills.includes(id));
        }
        if (args.skill_ids !== undefined || args.add_skills || args.remove_skills) {
          updates.skills = skills;
        }

        // MCP servers: set, add, or remove
        let mcpServers = agent.mcp_servers || [];
        if (args.mcp_server_ids !== undefined) {
          mcpServers = args.mcp_server_ids;
        }
        if (args.add_mcp_servers) {
          for (const sid of args.add_mcp_servers) {
            if (!mcpServers.includes(sid)) mcpServers.push(sid);
          }
        }
        if (args.remove_mcp_servers) {
          mcpServers = mcpServers.filter((id: string) => !args.remove_mcp_servers.includes(id));
        }
        if (args.mcp_server_ids !== undefined || args.add_mcp_servers || args.remove_mcp_servers) {
          updates.mcp_servers = mcpServers;
          // Auto-enable MCP feature if servers are being added
          if (mcpServers.length > 0 && !agent.features.mcp) {
            updates.features = { ...(updates.features || agent.features), mcp: true };
          }
        }

        const updated = AgentDB.update(args.agent_id, updates);
        return { content: [{ type: "text", text: `Agent updated: ${JSON.stringify({ id: updated?.id, name: updated?.name, skills: updates.skills !== undefined ? updates.skills.length + " skills" : "unchanged", mcp_servers: updates.mcp_servers !== undefined ? updates.mcp_servers.length + " servers" : "unchanged" }, null, 2)}` }] };
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
          ? McpServerDB.findByProjectLight(args.project_id)
          : McpServerDB.findAllLight();
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
        const serverInfo: Record<string, any> = {
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
        };
        // Include tools with full details for local servers
        if (server.type === "local") {
          const tools = McpServerToolDB.findByServer(server.id);
          serverInfo.tools = tools.map(t => ({
            id: t.id,
            name: t.name,
            description: t.description,
            handler_type: t.handler_type,
            enabled: t.enabled,
            input_schema: t.input_schema,
            mock_response: t.mock_response,
            http_config: t.http_config,
            code: t.code,
          }));
        }
        return { content: [{ type: "text", text: JSON.stringify(serverInfo, null, 2) }] };
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

      case "add_tool_to_local_server": {
        const server = McpServerDB.findById(args.server_id);
        if (!server) {
          return { content: [{ type: "text", text: `MCP server not found: ${args.server_id}` }], isError: true };
        }
        if (server.type !== "local") {
          return { content: [{ type: "text", text: `Server "${server.name}" is type "${server.type}" — add_tool_to_local_server only works for local servers.` }], isError: true };
        }
        // Check for duplicate tool name
        const existing = McpServerToolDB.findByServerAndName(args.server_id, args.name);
        if (existing) {
          return { content: [{ type: "text", text: `Tool "${args.name}" already exists on this server (ID: ${existing.id}). Use a different name or delete the existing tool first.` }], isError: true };
        }
        const tool = McpServerToolDB.create({
          id: generateId(),
          server_id: args.server_id,
          name: args.name,
          description: args.description,
          input_schema: args.input_schema || { type: "object", properties: {} },
          handler_type: args.handler_type || "mock",
          mock_response: args.mock_response || null,
          http_config: args.http_config || null,
          code: args.code || null,
          enabled: true,
        });
        return { content: [{ type: "text", text: `Tool added: ${JSON.stringify({ id: tool.id, name: tool.name, handler_type: tool.handler_type, server: server.name }, null, 2)}` }] };
      }

      case "update_tool_on_local_server": {
        const tool = McpServerToolDB.findById(args.tool_id);
        if (!tool) {
          return { content: [{ type: "text", text: `Tool not found: ${args.tool_id}` }], isError: true };
        }
        const server = McpServerDB.findById(tool.server_id);
        if (!server || server.type !== "local") {
          return { content: [{ type: "text", text: `Tool belongs to a non-local server — update_tool_on_local_server only works for local servers.` }], isError: true };
        }
        const updates: Record<string, unknown> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.input_schema !== undefined) updates.input_schema = args.input_schema;
        if (args.handler_type !== undefined) updates.handler_type = args.handler_type;
        if (args.mock_response !== undefined) updates.mock_response = args.mock_response;
        if (args.http_config !== undefined) updates.http_config = args.http_config;
        if (args.code !== undefined) updates.code = args.code;
        if (args.enabled !== undefined) updates.enabled = args.enabled;
        const updated = McpServerToolDB.update(args.tool_id, updates);
        if (!updated) {
          return { content: [{ type: "text", text: `Failed to update tool ${args.tool_id}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Tool updated: ${JSON.stringify({ id: updated.id, name: updated.name, handler_type: updated.handler_type, enabled: updated.enabled, server: server.name }, null, 2)}` }] };
      }

      case "get_dashboard_stats": {
        const agentCount = AgentDB.count();
        const runningCount = AgentDB.countRunning();
        const projectCount = ProjectDB.count();
        const providers = getProvidersWithStatus().filter(p => p.type === "llm");
        const configuredProviders = providers.filter(p => p.hasKey).length;
        const mcpServerCount = McpServerDB.count();
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
        let skills = args.enabled_only ? SkillDB.findEnabled() : SkillDB.findAll();
        if (args.project_id) {
          skills = skills.filter(s => !s.project_id || s.project_id === args.project_id);
        }
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

      case "update_skill": {
        const skill = SkillDB.findById(args.skill_id);
        if (!skill) {
          return { content: [{ type: "text", text: `Skill not found: ${args.skill_id}` }], isError: true };
        }
        const updates: Record<string, any> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.content !== undefined) updates.content = args.content;
        if (args.allowed_tools !== undefined) updates.allowed_tools = args.allowed_tools;
        const updated = SkillDB.update(args.skill_id, updates);
        return { content: [{ type: "text", text: `Skill "${updated?.name || skill.name}" updated.` }] };
      }

      case "create_skill": {
        if (!args.name || !args.description || !args.content) {
          return { content: [{ type: "text", text: "name, description, and content are required" }], isError: true };
        }
        const newSkill = SkillDB.create({
          name: args.name,
          description: args.description,
          content: args.content,
          version: "1.0.0",
          license: null,
          compatibility: null,
          metadata: {},
          allowed_tools: args.allowed_tools || [],
          source: "local",
          source_url: null,
          enabled: true,
          project_id: args.project_id || null,
        });
        return { content: [{ type: "text", text: `Skill "${newSkill.name}" created (ID: ${newSkill.id}). You can now assign it to an agent with assign_skill_to_agent.` }] };
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

      // Test tools
      case "list_tests": {
        const tests = TestCaseDB.findAll(args.project_id);
        const result = tests.map(tc => {
          const agent = AgentDB.findById(tc.agent_id);
          const lastRun = TestRunDB.getLatestByTestCase(tc.id);
          return {
            id: tc.id,
            name: tc.name,
            agent_id: tc.agent_id,
            agent_name: agent?.name || "Unknown",
            input_message: tc.input_message,
            eval_criteria: tc.eval_criteria,
            timeout_ms: tc.timeout_ms,
            last_status: lastRun?.status || null,
            last_reasoning: lastRun?.judge_reasoning || null,
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "create_test": {
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }
        const tc = TestCaseDB.create({
          name: args.name,
          agent_id: args.agent_id,
          input_message: args.input_message,
          eval_criteria: args.eval_criteria,
          description: args.description,
          timeout_ms: args.timeout_ms,
        });
        return { content: [{ type: "text", text: `Test "${tc.name}" created (id: ${tc.id}) for agent "${agent.name}". Use run_test to execute it.` }] };
      }

      case "run_test": {
        const tc = TestCaseDB.findById(args.test_id);
        if (!tc) {
          return { content: [{ type: "text", text: `Test not found: ${args.test_id}` }], isError: true };
        }
        const result = await runTest(tc);
        const agent = AgentDB.findById(tc.agent_id);
        return { content: [{ type: "text", text: `Test "${tc.name}" (agent: ${agent?.name || tc.agent_id}): ${result.status.toUpperCase()}${result.duration_ms ? ` in ${(result.duration_ms / 1000).toFixed(1)}s` : ""}\n\nJudge: ${result.judge_reasoning || result.error || "No reasoning"}` }] };
      }

      case "run_all_tests": {
        const results = await runAll(args.test_case_ids);
        const passed = results.filter(r => r.status === "passed").length;
        const failed = results.filter(r => r.status === "failed").length;
        const errors = results.filter(r => r.status === "error").length;
        const lines = results.map(r => {
          const tc = TestCaseDB.findById(r.test_case_id);
          return `- ${tc?.name || r.test_case_id}: ${r.status.toUpperCase()}${r.judge_reasoning ? ` — ${r.judge_reasoning}` : ""}${r.error ? ` — Error: ${r.error}` : ""}`;
        });
        return { content: [{ type: "text", text: `Test Results: ${passed} passed, ${failed} failed, ${errors} errors (${results.length} total)\n\n${lines.join("\n")}` }] };
      }

      case "get_test_results": {
        const tc = TestCaseDB.findById(args.test_id);
        if (!tc) {
          return { content: [{ type: "text", text: `Test not found: ${args.test_id}` }], isError: true };
        }
        const runs = TestRunDB.findByTestCase(args.test_id, args.limit || 10);
        const result = runs.map(r => ({
          id: r.id,
          status: r.status,
          duration_ms: r.duration_ms,
          judge_reasoning: r.judge_reasoning,
          error: r.error,
          created_at: r.created_at,
        }));
        return { content: [{ type: "text", text: `Run history for "${tc.name}":\n${JSON.stringify(result, null, 2)}` }] };
      }

      case "delete_test": {
        const tc = TestCaseDB.findById(args.test_id);
        if (!tc) {
          return { content: [{ type: "text", text: `Test not found: ${args.test_id}` }], isError: true };
        }
        TestCaseDB.delete(args.test_id);
        return { content: [{ type: "text", text: `Test "${tc.name}" deleted.` }] };
      }

      // Subscription & Trigger tools
      case "list_trigger_providers": {
        const providerIds = getTriggerProviderIds();
        const projectId = args.project_id || null;
        const result = providerIds.map(id => {
          const provider = getTriggerProvider(id);
          const hasKey = !!ProviderKeys.getDecryptedForProject(id, projectId);
          return {
            id,
            name: provider?.name || id,
            hasKey,
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_trigger_types": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const triggerProvider = getTriggerProvider(providerId);
        if (!triggerProvider) {
          return { content: [{ type: "text", text: `Unknown trigger provider: ${providerId}. Available: ${getTriggerProviderIds().join(", ")}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${triggerProvider.name} API key not configured` }], isError: true };
        }
        const types = await triggerProvider.listTriggerTypes(apiKey);
        const result = types.map(t => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          type: t.type,
          toolkit_slug: t.toolkit_slug,
          toolkit_name: t.toolkit_name,
          config_schema: t.config_schema,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }


      case "list_subscriptions": {
        let subscriptions;
        if (args.agent_id) {
          subscriptions = SubscriptionDB.findByAgentId(args.agent_id);
        } else {
          subscriptions = SubscriptionDB.findAll(args.project_id || null);
        }
        const result = subscriptions.map(s => {
          const agent = AgentDB.findById(s.agent_id);
          return {
            id: s.id,
            trigger_slug: s.trigger_slug,
            trigger_instance_id: s.trigger_instance_id,
            agent_id: s.agent_id,
            agent_name: agent?.name || "Unknown",
            enabled: s.enabled,
            project_id: s.project_id,
            created_at: s.created_at,
          };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "create_subscription": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const triggerProvider = getTriggerProvider(providerId);
        if (!triggerProvider) {
          return { content: [{ type: "text", text: `Unknown trigger provider: ${providerId}. Available: ${getTriggerProviderIds().join(", ")}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${triggerProvider.name} API key not configured` }], isError: true };
        }
        // Validate agent exists
        const agent = AgentDB.findById(args.agent_id);
        if (!agent) {
          return { content: [{ type: "text", text: `Agent not found: ${args.agent_id}` }], isError: true };
        }

        // Auto-setup webhook if not already configured for this provider
        const existingWebhook = SettingsDB.get(`${providerId}_webhook_url`);
        if (!existingWebhook) {
          try {
            const instanceUrl = SettingsDB.get("instance_url");
            if (instanceUrl) {
              const webhookUrl = `${instanceUrl}/api/webhooks/${providerId}`;
              const webhookResult = await triggerProvider.setupWebhook(apiKey, webhookUrl);
              if (webhookResult.secret) {
                SettingsDB.set(`${providerId}_webhook_secret`, webhookResult.secret);
              }
              SettingsDB.set(`${providerId}_webhook_url`, webhookUrl);
              console.log(`[platform-mcp] Auto-configured ${providerId} webhook: ${webhookUrl}`);
            }
          } catch (e) {
            console.warn(`[platform-mcp] Failed to auto-setup ${providerId} webhook:`, e);
          }
        }

        // Create remote trigger on the provider — auto-inject callback_url
        const webhookUrl = SettingsDB.get(`${providerId}_webhook_url`);
        const config: Record<string, unknown> = {
          agent_id: args.agent_id,
          ...(webhookUrl ? { callback_url: webhookUrl } : {}),
          ...(args.config || {}),
        };
        const triggerResult = await triggerProvider.createTrigger(apiKey, args.trigger_slug, args.connected_account_id, config);

        // Create local subscription for webhook routing
        const subscription = SubscriptionDB.create({
          trigger_slug: args.trigger_slug,
          trigger_instance_id: triggerResult.triggerId || null,
          agent_id: args.agent_id,
          enabled: true,
          project_id: projectId,
        });

        console.log(`[platform-mcp] Created subscription: ${args.trigger_slug} (instance=${triggerResult.triggerId}) → agent ${agent.name} (${agent.id})`);
        return { content: [{ type: "text", text: `Subscription created:\n${JSON.stringify({
          subscription_id: subscription.id,
          trigger_slug: args.trigger_slug,
          trigger_instance_id: triggerResult.triggerId,
          agent: agent.name,
          provider: providerId,
          enabled: true,
        }, null, 2)}` }] };
      }

      case "enable_subscription": {
        const sub = SubscriptionDB.findById(args.subscription_id);
        if (!sub) {
          return { content: [{ type: "text", text: `Subscription not found: ${args.subscription_id}` }], isError: true };
        }
        SubscriptionDB.update(args.subscription_id, { enabled: true });

        // Also enable remote trigger if provider specified
        if (args.provider && sub.trigger_instance_id) {
          const triggerProvider = getTriggerProvider(args.provider);
          const apiKey = triggerProvider ? ProviderKeys.getDecryptedForProject(args.provider, args.project_id || null) : null;
          if (triggerProvider && apiKey) {
            try {
              await triggerProvider.enableTrigger(apiKey, sub.trigger_instance_id);
            } catch (e) {
              console.warn(`[platform-mcp] Failed to enable remote trigger ${sub.trigger_instance_id}:`, e);
            }
          }
        }
        return { content: [{ type: "text", text: `Subscription "${sub.trigger_slug}" enabled` }] };
      }

      case "disable_subscription": {
        const sub = SubscriptionDB.findById(args.subscription_id);
        if (!sub) {
          return { content: [{ type: "text", text: `Subscription not found: ${args.subscription_id}` }], isError: true };
        }
        SubscriptionDB.update(args.subscription_id, { enabled: false });

        // Also disable remote trigger if provider specified
        if (args.provider && sub.trigger_instance_id) {
          const triggerProvider = getTriggerProvider(args.provider);
          const apiKey = triggerProvider ? ProviderKeys.getDecryptedForProject(args.provider, args.project_id || null) : null;
          if (triggerProvider && apiKey) {
            try {
              await triggerProvider.disableTrigger(apiKey, sub.trigger_instance_id);
            } catch (e) {
              console.warn(`[platform-mcp] Failed to disable remote trigger ${sub.trigger_instance_id}:`, e);
            }
          }
        }
        return { content: [{ type: "text", text: `Subscription "${sub.trigger_slug}" disabled` }] };
      }

      case "delete_subscription": {
        const sub = SubscriptionDB.findById(args.subscription_id);
        if (!sub) {
          return { content: [{ type: "text", text: `Subscription not found: ${args.subscription_id}` }], isError: true };
        }

        // Delete remote trigger if requested
        if (args.delete_remote && args.provider && sub.trigger_instance_id) {
          const triggerProvider = getTriggerProvider(args.provider);
          const apiKey = triggerProvider ? ProviderKeys.getDecryptedForProject(args.provider, args.project_id || null) : null;
          if (triggerProvider && apiKey) {
            try {
              await triggerProvider.deleteTrigger(apiKey, sub.trigger_instance_id);
              console.log(`[platform-mcp] Deleted remote trigger ${sub.trigger_instance_id} on ${args.provider}`);
            } catch (e) {
              console.warn(`[platform-mcp] Failed to delete remote trigger ${sub.trigger_instance_id}:`, e);
            }
          }
        }

        SubscriptionDB.delete(args.subscription_id);
        return { content: [{ type: "text", text: `Subscription "${sub.trigger_slug}" deleted` }] };
      }

      // Integration management tools
      case "list_integration_providers": {

        const providerIds = getProviderIds();
        const projectId = args.project_id || null;
        const result = providerIds.map(id => {
          const provider = getProvider(id);
          const hasKey = !!ProviderKeys.getDecryptedForProject(id, projectId);
          return { id, name: provider?.name || id, hasKey };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "list_integration_apps": {

        const providerId = args.provider;
        const projectId = args.project_id || null;
        const provider = getProvider(providerId);
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown integration provider: ${providerId}. Available: ${getProviderIds().join(", ")}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${provider.name} API key not configured` }], isError: true };
        }
        let apps = await provider.listApps(apiKey);
        if (args.search) {
          const s = args.search.toLowerCase();
          apps = apps.filter(a =>
            a.name.toLowerCase().includes(s) ||
            a.slug.toLowerCase().includes(s) ||
            a.description?.toLowerCase().includes(s)
          );
        }
        // Also check which are connected
        let connectedIds = new Set<string>();
        try {
          const accounts = await provider.listConnectedAccounts(apiKey, "platform-agent");
          connectedIds = new Set(accounts.filter(a => a.status === "active").map(a => a.appId));
        } catch {}
        const result = apps.slice(0, 50).map(a => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          authSchemes: a.authSchemes,
          categories: a.categories,
          connected: connectedIds.has(a.slug) || (a.providerSlug ? connectedIds.has(a.providerSlug) : false),
          credentialFields: a.credentialFields || undefined,
        }));
        return { content: [{ type: "text", text: `Found ${apps.length} apps (showing ${result.length}):\n${JSON.stringify(result, null, 2)}` }] };
      }

      case "connect_integration_app": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const provider = getProvider(providerId);
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown integration provider: ${providerId}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${provider.name} API key not configured` }], isError: true };
        }
        if (!args.api_key && !args.credentials) {
          return { content: [{ type: "text", text: `Either api_key or credentials is required` }], isError: true };
        }
        // Build credential object — prefer multi-field credentials over single api_key
        const creds: any = { authScheme: "API_KEY" as const };
        if (args.credentials && Object.keys(args.credentials).length > 0) {
          creds.fields = args.credentials;
        } else {
          creds.apiKey = args.api_key;
        }
        const connectionResult = await provider.initiateConnection(apiKey, "platform-agent", args.app_slug, "", creds);
        if (connectionResult.status === "active") {
          return { content: [{ type: "text", text: `Successfully connected "${args.app_slug}". Connection ID: ${connectionResult.connectionId || "N/A"}` }] };
        }
        return { content: [{ type: "text", text: `Connection initiated but status is ${connectionResult.status}. This may require OAuth — direct the user to the Browse Toolkits UI.` }] };
      }

      case "list_integration_connections": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const provider = getProvider(providerId);
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown integration provider: ${providerId}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${provider.name} API key not configured` }], isError: true };
        }
        const accounts = await provider.listConnectedAccounts(apiKey, "platform-agent");
        const result = accounts.map(a => ({
          id: a.id,
          appName: a.appName,
          appId: a.appId,
          status: a.status,
          createdAt: a.createdAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "disconnect_integration_app": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const provider = getProvider(providerId);
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown integration provider: ${providerId}` }], isError: true };
        }
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${provider.name} API key not configured` }], isError: true };
        }
        const success = await provider.disconnect(apiKey, args.connection_id);
        return { content: [{ type: "text", text: success ? `Disconnected successfully` : `Failed to disconnect` }], isError: !success };
      }

      case "list_integration_configs": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${providerId} API key not configured` }], isError: true };
        }

        if (providerId === "agentdojo") {
          const servers = await listAgentDojoServers(apiKey, true);
          const result = servers.map(s => ({
            id: s.id,
            name: s.name,
            slug: s.slug,
            url: s.url,
            toolsCount: s.tools?.length || 0,
          }));
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } else if (providerId === "composio") {
          const servers = await listComposioServers(apiKey);
          const result = servers.map(s => ({
            id: s.id,
            name: s.name,
            url: s.mcpUrl,
            toolkits: s.toolkits,
          }));
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: "text", text: `Config listing not supported for provider: ${providerId}` }], isError: true };
      }

      case "create_integration_config": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${providerId} API key not configured` }], isError: true };
        }

        if (providerId === "agentdojo") {
          const server = await createAgentDojoServer(apiKey, args.name, [args.toolkit_slug]);
          if (!server) {
            return { content: [{ type: "text", text: "Failed to create MCP config on AgentDojo" }], isError: true };
          }
          return { content: [{ type: "text", text: `MCP config created on AgentDojo:\n${JSON.stringify({ id: server.id, name: server.name, slug: server.slug, url: server.url }, null, 2)}\n\nUse add_integration_config_locally to add it as a local MCP server.` }] };
        } else if (providerId === "composio") {
          // For Composio, we need the authConfigId for the toolkit
          const authConfigId = await getComposioAuthConfig(apiKey, args.toolkit_slug);
          if (!authConfigId) {
            return { content: [{ type: "text", text: `No auth config found for toolkit "${args.toolkit_slug}". Make sure the app is connected first.` }], isError: true };
          }
          const server = await createComposioServer(apiKey, args.name, [authConfigId]);
          if (!server) {
            return { content: [{ type: "text", text: "Failed to create MCP config on Composio" }], isError: true };
          }
          // Create server instance for the user
          const userId = await getComposioUserForAuth(apiKey, authConfigId);
          if (userId) {
            await createComposioInstance(apiKey, server.id, userId);
          }
          return { content: [{ type: "text", text: `MCP config created on Composio:\n${JSON.stringify({ id: server.id, name: server.name, url: server.mcpUrl }, null, 2)}\n\nUse add_integration_config_locally to add it as a local MCP server.` }] };
        }
        return { content: [{ type: "text", text: `Config creation not supported for provider: ${providerId}` }], isError: true };
      }

      case "add_integration_config_locally": {
        const providerId = args.provider;
        const projectId = args.project_id || null;
        const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
        if (!apiKey) {
          return { content: [{ type: "text", text: `${providerId} API key not configured` }], isError: true };
        }

        const effectiveProjectId = projectId && projectId !== "unassigned" ? projectId : null;

        if (providerId === "agentdojo") {
          const server = await getAgentDojoServer(apiKey, args.config_id);
          if (!server) {
            return { content: [{ type: "text", text: `Config not found on AgentDojo: ${args.config_id}` }], isError: true };
          }
          // Check if already exists locally
          const existing = McpServerDB.findAllLight().find(
            s => s.source === "agentdojo" && s.project_id === effectiveProjectId && s.url?.endsWith(`/${server.slug}`)
          );
          if (existing) {
            return { content: [{ type: "text", text: `Server "${server.name}" already exists locally (ID: ${existing.id})` }] };
          }
          const localServer = McpServerDB.create({
            id: generateId(),
            name: server.name,
            type: "http",
            package: null,
            command: null,
            args: null,
            pip_module: null,
            env: {},
            url: server.url,
            headers: { "X-API-Key": apiKey },
            source: "agentdojo",
            project_id: effectiveProjectId,
          });
          return { content: [{ type: "text", text: `Server "${server.name}" added locally (ID: ${localServer.id}). Use assign_mcp_server_to_agent to give agents access.` }] };
        } else if (providerId === "composio") {
          // Fetch config details from Composio
          const res = await fetch(`https://backend.composio.dev/api/v3/mcp/${args.config_id}`, {
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          });
          if (!res.ok) {
            return { content: [{ type: "text", text: `Config not found on Composio: ${args.config_id}` }], isError: true };
          }
          const data = await res.json();
          const configName = data.name || `composio-${args.config_id.slice(0, 8)}`;
          const mcpUrl = data.mcp_url;
          if (!mcpUrl) {
            return { content: [{ type: "text", text: "Config does not have an MCP URL" }], isError: true };
          }
          // Check if already exists locally
          const existing = McpServerDB.findAllLight().find(
            s => s.source === "composio" && s.url?.includes(args.config_id)
          );
          if (existing) {
            return { content: [{ type: "text", text: `Server "${configName}" already exists locally (ID: ${existing.id})` }] };
          }
          // Get user_id for URL auth
          const authConfigIds = data.auth_config_ids || [];
          let userId: string | null = null;
          if (authConfigIds.length > 0) {
            userId = await getComposioUserForAuth(apiKey, authConfigIds[0]);
          }
          const mcpUrlWithUser = userId ? `${mcpUrl}?user_id=${encodeURIComponent(userId)}` : mcpUrl;
          const localServer = McpServerDB.create({
            id: generateId(),
            name: configName,
            type: "http",
            package: null,
            command: null,
            args: null,
            pip_module: null,
            env: {},
            url: mcpUrlWithUser,
            headers: { "x-api-key": apiKey },
            source: "composio",
            project_id: effectiveProjectId,
          });
          return { content: [{ type: "text", text: `Server "${configName}" added locally (ID: ${localServer.id}). Use assign_mcp_server_to_agent to give agents access.` }] };
        }
        return { content: [{ type: "text", text: `Local add not supported for provider: ${providerId}` }], isError: true };
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
        instructions: `This MCP server controls the Apteva AI agent management platform.

You can manage:
- AGENTS: Create, configure, start, stop, and delete AI agents. Each agent has a provider (LLM), model, system prompt, and optional features (memory, tasks, vision, MCP tools, files).
- PROJECTS: Organize agents into projects for grouping.
- MCP SERVERS: Tool integrations that give agents capabilities (web search, file access, APIs). Assign servers to agents.
- SKILLS: Reusable instruction sets that specialize agent behavior. Use create_skill to create new skills (pass project_id from context to scope to the current project), then assign them to agents. Use list_skills, get_skill, create_skill, toggle_skill, assign_skill_to_agent, unassign_skill_from_agent, delete_skill.
- PROVIDERS: View which LLM providers have API keys configured.
- TESTS: Create and run automated tests for agent workflows. Tests send a message to an agent, then an LLM judge evaluates the response against success criteria. Use list_tests, create_test, run_test, run_all_tests, get_test_results, delete_test.
- SUBSCRIPTIONS & TRIGGERS: Subscribe agents to external events (webhooks). Supports multiple providers (composio, agentdojo). Use list_trigger_providers → list_trigger_types → list_integration_connections → create_subscription. Manage with enable_subscription, disable_subscription, delete_subscription, list_subscriptions.
- INTEGRATIONS: Connect third-party apps and create MCP servers from them. Supports agentdojo and composio providers. Use list_integration_providers → list_integration_apps → connect_integration_app (API key) → create_integration_config → add_integration_config_locally → assign_mcp_server_to_agent. For OAuth apps, direct the user to the Browse Toolkits UI.

CRITICAL: ALWAYS pass project_id to every tool call that accepts it. API keys and resources are scoped per project — calls without project_id will fail. The chat context tells you the current project id.

Typical workflow: list_providers → create_agent → assign MCP servers/skills → start_agent.
Integration workflow: list_integration_providers → list_integration_apps (browse) → connect_integration_app (API key) → create_integration_config → add_integration_config_locally → assign_mcp_server_to_agent.
Subscription workflow: list_trigger_providers → list_trigger_types (pick trigger) → list_integration_connections (pick account) → create_subscription (link trigger to agent).
Test workflow: create_test (set agent, message, eval criteria) → run_test → check results.
Always use list_providers first to check which providers have API keys before creating agents.`,
      };
      break;
    }

    case "notifications/initialized": {
      // Acknowledgement - no response needed for notifications, but since this is HTTP we return ok
      result = {};
      break;
    }

    case "tools/list": {
      result = { tools: getPlatformTools() };
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
