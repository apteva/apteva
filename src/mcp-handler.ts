// Local MCP server handler
// Handles JSON-RPC requests for servers of type "local"
// Tools are stored in the database with configurable handler types: mock, http, javascript

import { McpServerDB, McpServerToolDB, type McpServerTool } from "./db";

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

// Template helpers available in mock_response and javascript handlers
function templateHelpers() {
  return {
    uuid: () => crypto.randomUUID(),
    now: new Date().toISOString(),
    timestamp: Date.now(),
    random_int: (min: number, max: number) =>
      Math.floor(Math.random() * (max - min + 1)) + min,
    random_float: (min: number, max: number) =>
      Math.random() * (max - min) + min,
  };
}

// Render mock response template with variable substitution
// Supports: {{args.field}}, {{uuid()}}, {{now}}, {{timestamp}}, {{random_int(min,max)}}
function renderTemplate(template: any, args: Record<string, any>): any {
  const helpers = templateHelpers();

  if (typeof template === "string") {
    // Check if entire string is a single expression
    const fullMatch = template.match(/^\{\{(.+)\}\}$/);
    if (fullMatch) {
      return evaluateExpression(fullMatch[1].trim(), args, helpers);
    }
    // Replace embedded expressions
    return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      const result = evaluateExpression(expr.trim(), args, helpers);
      if (result === null || result === undefined) return "";
      if (typeof result === "object") return JSON.stringify(result);
      return String(result);
    });
  }

  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, args));
  }

  if (template !== null && typeof template === "object") {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(template)) {
      result[key] = renderTemplate(val, args);
    }
    return result;
  }

  return template;
}

function evaluateExpression(
  expr: string,
  args: Record<string, any>,
  helpers: ReturnType<typeof templateHelpers>,
): any {
  // Handle args.* references (e.g. args.name, args.query)
  if (expr.startsWith("args.")) {
    const key = expr.slice(5);
    return args[key] ?? null;
  }

  // Handle known helper values
  if (expr === "now") return helpers.now;
  if (expr === "timestamp") return helpers.timestamp;

  // Handle known helper function calls
  const uuidMatch = expr.match(/^uuid\(\)$/);
  if (uuidMatch) return helpers.uuid();

  const randIntMatch = expr.match(/^random_int\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (randIntMatch) return helpers.random_int(Number(randIntMatch[1]), Number(randIntMatch[2]));

  const randFloatMatch = expr.match(/^random_float\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
  if (randFloatMatch) return helpers.random_float(Number(randFloatMatch[1]), Number(randFloatMatch[2]));

  // Return expression as-is if not recognized — never execute arbitrary code
  return expr;
}

// Execute a mock handler — returns the rendered mock_response
function executeMock(
  tool: McpServerTool,
  args: Record<string, any>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const mockResponse = tool.mock_response || {};
  const rendered = renderTemplate(mockResponse, args);
  return {
    content: [{ type: "text", text: JSON.stringify(rendered, null, 2) }],
  };
}

// Execute an HTTP handler — makes a real API call
async function executeHttp(
  tool: McpServerTool,
  args: Record<string, any>,
  credentials: Record<string, string>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const config = tool.http_config;
  if (!config || !config.url) {
    return {
      content: [{ type: "text", text: "Error: No HTTP config or URL defined" }],
      isError: true,
    };
  }

  const { method = "GET", url, headers = {}, body } = config;

  // Render templates in URL, headers, and body
  const renderedUrl = renderTemplate(url, args) as string;
  const renderedHeaders = renderTemplate(headers, args) as Record<string, string>;

  // Substitute credential references in headers
  const finalHeaders: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(renderedHeaders)) {
    let val = String(v);
    // Replace {{credential.*}} references
    val = val.replace(/\{\{credential\.([^}]+)\}\}/g, (_, key) => credentials[key] || "");
    finalHeaders[k] = val;
  }

  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers: finalHeaders,
  };

  if (["POST", "PUT", "PATCH"].includes(fetchOptions.method!)) {
    if (body) {
      const renderedBody = renderTemplate(body, args);
      fetchOptions.body = JSON.stringify(renderedBody);
    } else {
      fetchOptions.body = JSON.stringify(args);
    }
  }

  try {
    const response = await fetch(renderedUrl, fetchOptions);
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `HTTP error: ${err}` }],
      isError: true,
    };
  }
}

// Execute a JavaScript handler — runs user-defined code in a restricted scope.
// SECURITY NOTE: This intentionally allows authenticated admins to define custom tool logic.
// The code runs in a restricted Function scope with only args, credentials, and helpers exposed.
// process, require, import, Bun, fetch etc. are NOT passed in — but note that new Function()
// still has access to globalThis. For full sandboxing, consider using a Worker or subprocess.
function executeJavascript(
  tool: McpServerTool,
  args: Record<string, any>,
  credentials: Record<string, string>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (!tool.code) {
    return {
      content: [{ type: "text", text: "Error: No code defined for this tool" }],
      isError: true,
    };
  }

  // Basic static checks — block obvious dangerous patterns
  const dangerous = /\b(process|require|import|Bun|Deno|eval|Function|child_process|exec|spawn)\b/;
  if (dangerous.test(tool.code)) {
    return {
      content: [{ type: "text", text: "Error: Tool code contains disallowed keywords (process, require, import, eval, exec, spawn)" }],
      isError: true,
    };
  }

  try {
    const helpers = templateHelpers();
    const fn = new Function(
      "args",
      "credentials",
      "uuid",
      "now",
      "timestamp",
      "random_int",
      "random_float",
      tool.code,
    );
    const result = fn(
      args,
      credentials,
      helpers.uuid,
      helpers.now,
      helpers.timestamp,
      helpers.random_int,
      helpers.random_float,
    );
    const text =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `JavaScript error: ${err}` }],
      isError: true,
    };
  }
}

// Execute a tool based on its handler_type
async function executeTool(
  tool: McpServerTool,
  args: Record<string, any>,
  credentials: Record<string, string>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  switch (tool.handler_type) {
    case "http":
      return executeHttp(tool, args, credentials);
    case "javascript":
      return executeJavascript(tool, args, credentials);
    case "mock":
    default:
      return executeMock(tool, args);
  }
}

// Main JSON-RPC handler for local MCP servers
export async function handleLocalMcpRequest(
  req: Request,
  serverId: string,
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const server = McpServerDB.findById(serverId);
  if (!server || server.type !== "local") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32600, message: "Server not found or not a local server" },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32700, message: "Parse error" },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { method, params, id } = body;
  let result: unknown;
  let error: { code: number; message: string } | undefined;

  // Parse server credentials
  let credentials: Record<string, string> = {};
  try {
    if (server.env && Object.keys(server.env).length > 0) {
      credentials = server.env;
    }
  } catch {
    // ignore
  }

  switch (method) {
    case "initialize": {
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: server.name,
          version: "1.0.0",
        },
      };
      break;
    }

    case "notifications/initialized": {
      result = {};
      break;
    }

    case "tools/list": {
      const tools = McpServerToolDB.findByServer(serverId);
      result = {
        tools: tools
          .filter((t) => t.enabled)
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
      };
      break;
    }

    case "tools/call": {
      const { name, arguments: args } = params as {
        name: string;
        arguments: Record<string, any>;
      };
      const tool = McpServerToolDB.findByServerAndName(serverId, name);
      if (!tool) {
        result = {
          content: [{ type: "text", text: `Tool '${name}' not found` }],
          isError: true,
        };
      } else if (!tool.enabled) {
        result = {
          content: [{ type: "text", text: `Tool '${name}' is disabled` }],
          isError: true,
        };
      } else {
        result = await executeTool(tool, args || {}, credentials);
      }
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
