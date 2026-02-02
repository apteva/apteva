// OpenAPI 3.0 Specification for Apteva API

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Apteva API",
    description: `API for managing AI agents, MCP servers, and related resources.

## Authentication

All endpoints (except /health, /version, and /auth/*) require JWT authentication.

### Getting a Token

\`\`\`bash
curl -X POST /api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"username": "admin", "password": "yourpassword"}'
\`\`\`

Response (refresh token set as httpOnly cookie):
\`\`\`json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900,
  "user": { "id": "...", "username": "admin", "role": "admin" }
}
\`\`\`

### Using the Token

Include the access token in the Authorization header:

\`\`\`bash
curl /api/agents \\
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
\`\`\`

### Token Refresh

Access tokens expire after 15 minutes. The refresh token is stored as an httpOnly cookie, so just call:

\`\`\`bash
curl -X POST /api/auth/refresh
\`\`\`

The new access token will be returned and a new refresh token cookie will be set.
`,
    version: "0.2.8",
    contact: {
      name: "Apteva",
    },
  },
  servers: [
    {
      url: "/api",
      description: "Apteva API",
    },
  ],
  tags: [
    { name: "Auth", description: "Authentication endpoints" },
    { name: "Agents", description: "AI Agent management" },
    { name: "Chat", description: "Agent conversations" },
    { name: "Threads", description: "Conversation threads" },
    { name: "Memory", description: "Agent memory/knowledge" },
    { name: "Files", description: "Agent file management" },
    { name: "Tasks", description: "Scheduled tasks" },
    { name: "Telemetry", description: "Agent telemetry and usage tracking" },
    { name: "MCP", description: "Model Context Protocol servers" },
    { name: "Providers", description: "LLM providers and API keys" },
    { name: "Projects", description: "Agent grouping" },
    { name: "System", description: "Health and version info" },
  ],
  security: [{ BearerAuth: [] }],
  paths: {
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login and get access token",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LoginRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Login successful",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Refresh access token",
        description: "Refresh token is read from httpOnly cookie (set during login). No request body needed.",
        security: [],
        responses: {
          "200": {
            description: "Token refreshed. New refresh token set as httpOnly cookie.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RefreshResponse" },
              },
            },
          },
          "401": { description: "Invalid or expired refresh token" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout and invalidate tokens",
        responses: {
          "200": { description: "Logged out successfully" },
        },
      },
    },
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        security: [],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/version": {
      get: {
        tags: ["System"],
        summary: "Get version info",
        security: [],
        responses: {
          "200": {
            description: "Version information",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VersionResponse" },
              },
            },
          },
        },
      },
    },
    "/dashboard": {
      get: {
        tags: ["System"],
        summary: "Get dashboard statistics",
        responses: {
          "200": {
            description: "Dashboard stats",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DashboardStats" },
              },
            },
          },
        },
      },
    },
    "/agents": {
      get: {
        tags: ["Agents"],
        summary: "List all agents",
        responses: {
          "200": {
            description: "List of agents",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentListResponse" },
              },
            },
          },
        },
      },
      post: {
        tags: ["Agents"],
        summary: "Create a new agent",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAgent" },
            },
          },
        },
        responses: {
          "201": {
            description: "Agent created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentResponse" },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}": {
      get: {
        tags: ["Agents"],
        summary: "Get agent by ID",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Agent details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentResponse" },
              },
            },
          },
          "404": { description: "Agent not found" },
        },
      },
      put: {
        tags: ["Agents"],
        summary: "Update agent",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateAgent" },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentResponse" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Agents"],
        summary: "Delete agent",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Agent deleted" },
        },
      },
    },
    "/agents/{agentId}/start": {
      post: {
        tags: ["Agents"],
        summary: "Start an agent",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Agent started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    port: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}/stop": {
      post: {
        tags: ["Agents"],
        summary: "Stop an agent",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Agent stopped",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}/chat": {
      post: {
        tags: ["Chat"],
        summary: "Send a message to an agent",
        description: `Proxies the chat request to the running agent and streams the response.

**Requirements:**
- Agent must be running (status: "running")
- Agent must have an assigned port

**Response Format:**
The response is streamed as Server-Sent Events (SSE) or newline-delimited JSON.

**Event Types:**
- \`content\` - Text content from the agent
- \`tool_call\` - Agent is calling a tool
- \`tool_result\` - Result from a tool call
- \`done\` - Response complete
- \`error\` - Error occurred

**Example:**
\`\`\`javascript
const response = await fetch('/api/agents/{id}/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Hello!' })
});

const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Process streaming chunks
}
\`\`\``,
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "The agent's unique ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string", description: "The user's message to send to the agent" },
                  threadId: { type: "string", description: "Optional thread ID for conversation context. If omitted, uses default thread." },
                  images: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional array of image URLs or base64 data (requires vision feature)",
                  },
                },
              },
              example: {
                message: "What can you help me with?",
                threadId: "thread_abc123",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Streaming response from the agent",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  description: "SSE stream with events: content, tool_call, tool_result, done, error",
                },
              },
            },
          },
          "400": {
            description: "Agent is not running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", example: "Agent is not running" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Agent not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", example: "Agent not found" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}/threads": {
      get: {
        tags: ["Threads"],
        summary: "List agent threads",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "List of threads",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Thread" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Threads"],
        summary: "Create a new thread",
        parameters: [
          {
            name: "agentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Thread created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thread" },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}/threads/{threadId}": {
      get: {
        tags: ["Threads"],
        summary: "Get thread details",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "threadId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Thread details with messages",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thread" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Threads"],
        summary: "Delete a thread",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "threadId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Thread deleted" },
        },
      },
    },
    "/agents/{agentId}/memories": {
      get: {
        tags: ["Memory"],
        summary: "List agent memories",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of memories",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Memory" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Memory"],
        summary: "Add a memory",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: { type: "string" },
                  type: { type: "string", enum: ["fact", "preference", "instruction"] },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Memory added" },
        },
      },
    },
    "/agents/{agentId}/memories/{memoryId}": {
      delete: {
        tags: ["Memory"],
        summary: "Delete a memory",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "memoryId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Memory deleted" },
        },
      },
    },
    "/agents/{agentId}/files": {
      get: {
        tags: ["Files"],
        summary: "List agent files",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of files",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/File" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Files"],
        summary: "Upload a file",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "File uploaded" },
        },
      },
    },
    "/agents/{agentId}/files/{fileId}": {
      get: {
        tags: ["Files"],
        summary: "Get file metadata",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "fileId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "File metadata",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/File" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Files"],
        summary: "Delete a file",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "fileId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "File deleted" },
        },
      },
    },
    "/agents/{agentId}/files/{fileId}/download": {
      get: {
        tags: ["Files"],
        summary: "Download a file",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "fileId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "File content",
            content: {
              "application/octet-stream": {},
            },
          },
        },
      },
    },
    "/agents/{agentId}/tasks": {
      get: {
        tags: ["Tasks"],
        summary: "List agent tasks",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of tasks",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Task" },
                },
              },
            },
          },
        },
      },
    },
    "/agents/{agentId}/peers": {
      get: {
        tags: ["Agents"],
        summary: "List peer agents (for multi-agent)",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of peer agents",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Agent" },
                },
              },
            },
          },
        },
      },
    },
    "/tasks": {
      get: {
        tags: ["Tasks"],
        summary: "List all tasks",
        responses: {
          "200": {
            description: "List of tasks",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Task" },
                },
              },
            },
          },
        },
      },
    },
    "/mcp/servers": {
      get: {
        tags: ["MCP"],
        summary: "List MCP servers",
        responses: {
          "200": {
            description: "List of MCP servers",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/McpServerListResponse" },
              },
            },
          },
        },
      },
      post: {
        tags: ["MCP"],
        summary: "Create MCP server",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateMcpServer" },
            },
          },
        },
        responses: {
          "201": {
            description: "MCP server created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/McpServer" },
              },
            },
          },
        },
      },
    },
    "/mcp/servers/{serverId}": {
      delete: {
        tags: ["MCP"],
        summary: "Delete MCP server",
        parameters: [
          { name: "serverId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Server deleted" },
        },
      },
    },
    "/mcp/servers/{serverId}/start": {
      post: {
        tags: ["MCP"],
        summary: "Start MCP server",
        parameters: [
          { name: "serverId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Server started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    port: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/mcp/servers/{serverId}/stop": {
      post: {
        tags: ["MCP"],
        summary: "Stop MCP server",
        parameters: [
          { name: "serverId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Server stopped" },
        },
      },
    },
    "/mcp/servers/{serverId}/tools": {
      get: {
        tags: ["MCP"],
        summary: "List tools from MCP server",
        parameters: [
          { name: "serverId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of tools",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/McpTool" },
                },
              },
            },
          },
        },
      },
    },
    "/mcp/servers/{serverId}/tools/{toolName}/call": {
      post: {
        tags: ["MCP"],
        summary: "Call an MCP tool",
        parameters: [
          { name: "serverId", in: "path", required: true, schema: { type: "string" } },
          { name: "toolName", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Tool arguments (varies by tool)",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/McpToolResult" },
              },
            },
          },
        },
      },
    },
    "/mcp/registry": {
      get: {
        tags: ["MCP"],
        summary: "Search MCP registry (Smithery)",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query" },
        ],
        responses: {
          "200": {
            description: "Registry results",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      package: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/providers": {
      get: {
        tags: ["Providers"],
        summary: "List available providers",
        responses: {
          "200": {
            description: "List of providers",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Provider" },
                },
              },
            },
          },
        },
      },
    },
    "/keys/{providerId}": {
      post: {
        tags: ["Providers"],
        summary: "Save API key for provider",
        parameters: [
          { name: "providerId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["key"],
                properties: {
                  key: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Key saved" },
        },
      },
    },
    "/keys/{providerId}/test": {
      post: {
        tags: ["Providers"],
        summary: "Test API key validity",
        parameters: [
          { name: "providerId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Key validation result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    valid: { type: "boolean" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/projects": {
      get: {
        tags: ["Projects"],
        summary: "List projects",
        responses: {
          "200": {
            description: "List of projects",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Project" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Projects"],
        summary: "Create project",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Project created" },
        },
      },
    },
    "/projects/{projectId}": {
      put: {
        tags: ["Projects"],
        summary: "Update project",
        parameters: [
          { name: "projectId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Project updated" },
        },
      },
      delete: {
        tags: ["Projects"],
        summary: "Delete project",
        parameters: [
          { name: "projectId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Project deleted" },
        },
      },
    },
    "/telemetry": {
      post: {
        tags: ["Telemetry"],
        summary: "Receive telemetry events from agents",
        description: `Endpoint for agents to send telemetry data. Agents are configured to send to this endpoint automatically.

Events are batched and sent periodically. Debug-level events are filtered out.`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TelemetryBatch" },
            },
          },
        },
        responses: {
          "200": {
            description: "Events received",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    received: { type: "integer", description: "Number of events received" },
                    inserted: { type: "integer", description: "Number of events inserted" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/telemetry/stream": {
      get: {
        tags: ["Telemetry"],
        summary: "Real-time telemetry stream (SSE)",
        description: `Server-Sent Events stream for real-time telemetry updates.

Connect to this endpoint to receive live telemetry events as they are received from agents.

**Example:**
\`\`\`javascript
const eventSource = new EventSource('/api/telemetry/stream');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Telemetry:', data);
};
\`\`\``,
        responses: {
          "200": {
            description: "SSE stream of telemetry events",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  description: "Server-Sent Events stream. Each event contains JSON with telemetry data.",
                },
              },
            },
          },
        },
      },
    },
    "/telemetry/events": {
      get: {
        tags: ["Telemetry"],
        summary: "Query telemetry events",
        description: "Query stored telemetry events with optional filters.",
        parameters: [
          { name: "agent_id", in: "query", schema: { type: "string" }, description: "Filter by agent ID" },
          { name: "project_id", in: "query", schema: { type: "string" }, description: "Filter by project ID (use 'null' for unassigned)" },
          { name: "category", in: "query", schema: { type: "string" }, description: "Filter by category (llm, tool, memory, etc.)" },
          { name: "level", in: "query", schema: { type: "string" }, description: "Filter by level (info, warn, error)" },
          { name: "trace_id", in: "query", schema: { type: "string" }, description: "Filter by trace ID" },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "Events after this timestamp" },
          { name: "until", in: "query", schema: { type: "string", format: "date-time" }, description: "Events before this timestamp" },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 }, description: "Max events to return" },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Offset for pagination" },
        ],
        responses: {
          "200": {
            description: "List of telemetry events",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    events: {
                      type: "array",
                      items: { $ref: "#/components/schemas/TelemetryEvent" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/telemetry/usage": {
      get: {
        tags: ["Telemetry"],
        summary: "Get usage statistics",
        description: "Get token usage statistics, optionally grouped by agent or day.",
        parameters: [
          { name: "agent_id", in: "query", schema: { type: "string" }, description: "Filter by agent ID" },
          { name: "project_id", in: "query", schema: { type: "string" }, description: "Filter by project ID" },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "Start of time range" },
          { name: "until", in: "query", schema: { type: "string", format: "date-time" }, description: "End of time range" },
          { name: "group_by", in: "query", schema: { type: "string", enum: ["agent", "day"] }, description: "Group results by agent or day" },
        ],
        responses: {
          "200": {
            description: "Usage statistics",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelemetryUsage" },
              },
            },
          },
        },
      },
    },
    "/telemetry/stats": {
      get: {
        tags: ["Telemetry"],
        summary: "Get summary statistics",
        description: "Get aggregated telemetry statistics for dashboard display.",
        parameters: [
          { name: "agent_id", in: "query", schema: { type: "string" }, description: "Filter by agent ID" },
          { name: "project_id", in: "query", schema: { type: "string" }, description: "Filter by project ID" },
        ],
        responses: {
          "200": {
            description: "Summary statistics",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelemetryStats" },
              },
            },
          },
        },
      },
    },
    "/telemetry/clear": {
      post: {
        tags: ["Telemetry"],
        summary: "Clear all telemetry data",
        description: "Permanently deletes all stored telemetry data. Use with caution.",
        responses: {
          "200": {
            description: "Telemetry cleared",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deleted: { type: "integer", description: "Number of events deleted" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/integrations/composio/configs": {
      get: {
        tags: ["MCP"],
        summary: "List Composio MCP server configs",
        description: "Lists MCP server configurations from your Composio account.",
        responses: {
          "200": {
            description: "List of Composio configs",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    configs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          toolkits: { type: "array", items: { type: "string" } },
                          toolsCount: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/integrations/composio/configs/{configId}/add": {
      post: {
        tags: ["MCP"],
        summary: "Add Composio config as MCP server",
        description: "Creates an MCP server from a Composio config. Automatically fetches your Composio user ID from connected accounts.",
        parameters: [
          { name: "configId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "MCP server created from Composio config",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/McpServerResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT token obtained from /auth/login",
      },
    },
    schemas: {
      // Auth schemas
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", example: "admin" },
          password: { type: "string", example: "yourpassword" },
        },
      },
      LoginResponse: {
        type: "object",
        properties: {
          accessToken: { type: "string", description: "JWT access token (expires in 15min)" },
          expiresIn: { type: "integer", description: "Token expiry in seconds", example: 900 },
          user: { $ref: "#/components/schemas/User" },
        },
        description: "Refresh token is set as httpOnly cookie",
      },
      RefreshResponse: {
        type: "object",
        properties: {
          accessToken: { type: "string" },
          expiresIn: { type: "integer", description: "Token expiry in seconds" },
        },
        description: "Refresh token read from httpOnly cookie, new one set as cookie",
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          email: { type: "string", format: "email", nullable: true },
          role: { type: "string", example: "admin" },
          createdAt: { type: "string", format: "date-time" },
          lastLoginAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      // System schemas
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          version: { type: "string", example: "0.2.8" },
          agents: {
            type: "object",
            properties: {
              total: { type: "integer", example: 3 },
              running: { type: "integer", example: 1 },
            },
          },
        },
      },
      VersionResponse: {
        type: "object",
        properties: {
          apteva: { $ref: "#/components/schemas/VersionInfo" },
          agent: { $ref: "#/components/schemas/VersionInfo" },
          isDocker: { type: "boolean" },
        },
      },
      VersionInfo: {
        type: "object",
        properties: {
          installed: { type: "string", nullable: true, example: "0.2.8" },
          latest: { type: "string", nullable: true, example: "0.2.9" },
          updateAvailable: { type: "boolean" },
          lastChecked: { type: "string", format: "date-time", nullable: true },
        },
      },
      // Agent schemas
      Agent: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
          systemPrompt: { type: "string" },
          status: { type: "string", enum: ["stopped", "running"] },
          port: { type: "integer" },
          features: { $ref: "#/components/schemas/AgentFeatures" },
          mcpServers: { type: "array", items: { type: "string" } },
          projectId: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      AgentResponse: {
        type: "object",
        properties: {
          agent: { $ref: "#/components/schemas/Agent" },
        },
      },
      AgentListResponse: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: { $ref: "#/components/schemas/Agent" },
          },
        },
      },
      CreateAgent: {
        type: "object",
        required: ["name", "model", "provider"],
        properties: {
          name: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
          systemPrompt: { type: "string" },
          features: { $ref: "#/components/schemas/AgentFeatures" },
          mcpServers: { type: "array", items: { type: "string" } },
          projectId: { type: "string" },
        },
      },
      UpdateAgent: {
        type: "object",
        properties: {
          name: { type: "string" },
          model: { type: "string" },
          provider: { type: "string" },
          systemPrompt: { type: "string" },
          features: { $ref: "#/components/schemas/AgentFeatures" },
          mcpServers: { type: "array", items: { type: "string" } },
          projectId: { type: "string", nullable: true },
        },
      },
      AgentFeatures: {
        type: "object",
        properties: {
          memory: { type: "boolean" },
          tasks: { type: "boolean" },
          vision: { type: "boolean" },
          operator: { type: "boolean" },
          mcp: { type: "boolean" },
          realtime: { type: "boolean" },
          files: { type: "boolean" },
          agents: { type: "boolean" },
        },
      },
      Thread: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          messageCount: { type: "integer" },
        },
      },
      Memory: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          type: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      File: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          size: { type: "integer" },
          mimeType: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Task: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          type: { type: "string", enum: ["once", "recurring"] },
          status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
          priority: { type: "integer" },
          source: { type: "string", enum: ["local", "delegated"] },
          createdAt: { type: "string", format: "date-time" },
          executeAt: { type: "string", format: "date-time" },
          executedAt: { type: "string", format: "date-time" },
          agentId: { type: "string" },
          agentName: { type: "string" },
        },
      },
      McpServer: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["npm", "github", "http", "custom"] },
          package: { type: "string", nullable: true },
          command: { type: "string", nullable: true },
          url: { type: "string", nullable: true },
          port: { type: "integer", nullable: true },
          status: { type: "string", enum: ["stopped", "running"] },
          source: { type: "string", nullable: true },
        },
      },
      McpServerListResponse: {
        type: "object",
        properties: {
          servers: {
            type: "array",
            items: { $ref: "#/components/schemas/McpServer" },
          },
        },
      },
      CreateMcpServer: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["npm", "github", "http", "custom"] },
          package: { type: "string", description: "NPM package name (for npm type)" },
          command: { type: "string", description: "Command to run (for custom type)" },
          url: { type: "string", description: "Server URL (for http type)" },
          headers: { type: "object", description: "HTTP headers (for http type)" },
        },
      },
      McpTool: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          inputSchema: { type: "object" },
        },
      },
      McpToolResult: {
        type: "object",
        properties: {
          content: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["text", "image", "resource"] },
                text: { type: "string" },
                data: { type: "string" },
                mimeType: { type: "string" },
              },
            },
          },
          isError: { type: "boolean" },
        },
      },
      Provider: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["llm", "integration"] },
          docsUrl: { type: "string" },
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
                label: { type: "string" },
                recommended: { type: "boolean" },
              },
            },
          },
          hasKey: { type: "boolean" },
          isValid: { type: "boolean", nullable: true },
        },
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      DashboardStats: {
        type: "object",
        properties: {
          agents: {
            type: "object",
            properties: {
              total: { type: "integer" },
              running: { type: "integer" },
            },
          },
          tasks: {
            type: "object",
            properties: {
              total: { type: "integer" },
              pending: { type: "integer" },
              running: { type: "integer" },
              completed: { type: "integer" },
            },
          },
          providers: {
            type: "object",
            properties: {
              configured: { type: "integer" },
            },
          },
        },
      },
      // Telemetry schemas
      TelemetryBatch: {
        type: "object",
        required: ["agent_id", "events"],
        properties: {
          agent_id: { type: "string", description: "ID of the agent sending telemetry" },
          sent_at: { type: "string", format: "date-time", description: "When the batch was sent" },
          events: {
            type: "array",
            items: { $ref: "#/components/schemas/TelemetryEventInput" },
          },
        },
      },
      TelemetryEventInput: {
        type: "object",
        required: ["id", "timestamp", "category", "type", "level"],
        properties: {
          id: { type: "string", description: "Unique event ID" },
          timestamp: { type: "string", format: "date-time" },
          category: {
            type: "string",
            description: "Event category",
            enum: ["llm", "tool", "memory", "task", "agent", "mcp", "system"],
          },
          type: { type: "string", description: "Event type within category (e.g., 'request', 'response', 'error')" },
          level: { type: "string", enum: ["debug", "info", "warn", "error"] },
          trace_id: { type: "string", description: "Trace ID for correlating related events" },
          span_id: { type: "string", description: "Span ID within a trace" },
          thread_id: { type: "string", description: "Conversation thread ID" },
          data: {
            type: "object",
            description: "Event-specific data (tokens, model, tool name, etc.)",
          },
          metadata: { type: "object", description: "Additional metadata" },
          duration_ms: { type: "integer", description: "Duration in milliseconds (for timed events)" },
          error: { type: "string", description: "Error message if event represents an error" },
        },
      },
      TelemetryEvent: {
        type: "object",
        properties: {
          id: { type: "string" },
          agent_id: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          category: { type: "string" },
          type: { type: "string" },
          level: { type: "string" },
          trace_id: { type: "string", nullable: true },
          thread_id: { type: "string", nullable: true },
          data: { type: "object", nullable: true },
          duration_ms: { type: "integer", nullable: true },
          error: { type: "string", nullable: true },
        },
      },
      TelemetryUsage: {
        type: "object",
        properties: {
          usage: {
            type: "object",
            properties: {
              total_tokens: { type: "integer" },
              prompt_tokens: { type: "integer" },
              completion_tokens: { type: "integer" },
              request_count: { type: "integer" },
              by_agent: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    agent_id: { type: "string" },
                    total_tokens: { type: "integer" },
                    request_count: { type: "integer" },
                  },
                },
              },
              by_day: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", format: "date" },
                    total_tokens: { type: "integer" },
                    request_count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      TelemetryStats: {
        type: "object",
        properties: {
          stats: {
            type: "object",
            properties: {
              total_events: { type: "integer" },
              events_by_category: { type: "object", additionalProperties: { type: "integer" } },
              events_by_level: { type: "object", additionalProperties: { type: "integer" } },
              total_tokens: { type: "integer" },
              total_requests: { type: "integer" },
              avg_response_time_ms: { type: "number" },
              error_count: { type: "integer" },
            },
          },
        },
      },
    },
  },
};
