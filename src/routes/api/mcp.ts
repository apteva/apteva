import { spawn } from "bun";
import { json } from "./helpers";
import { McpServerDB, generateId, type McpServer } from "../../db";
import { getNextPort } from "../../server";
import {
  startMcpProcess,
  stopMcpProcess,
  initializeMcpServer,
  listMcpTools,
  callMcpTool,
  getMcpProcess,
  getHttpMcpClient,
} from "../../mcp-client";

export async function handleMcpRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // GET /api/mcp/servers - List MCP servers (optionally filtered by project)
  if (path === "/api/mcp/servers" && method === "GET") {
    const url = new URL(req.url);
    const projectFilter = url.searchParams.get("project"); // "all", "global", or project ID
    const forAgent = url.searchParams.get("forAgent"); // agent's project ID (shows global + project)

    let servers;
    if (forAgent !== null) {
      // Get servers available for an agent (global + agent's project)
      servers = McpServerDB.findForAgent(forAgent || null);
    } else if (projectFilter === "global") {
      servers = McpServerDB.findGlobal();
    } else if (projectFilter && projectFilter !== "all") {
      servers = McpServerDB.findByProject(projectFilter);
    } else {
      servers = McpServerDB.findAll();
    }
    return json({ servers });
  }

  // GET /api/mcp/registry - Search MCP registry for available servers
  if (path === "/api/mcp/registry" && method === "GET") {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || "";
    const limit = url.searchParams.get("limit") || "20";

    try {
      const registryUrl = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(search)}&limit=${limit}`;
      const res = await fetch(registryUrl);
      if (!res.ok) {
        return json({ error: "Failed to fetch registry" }, 500);
      }
      const data = await res.json();

      // Transform to simpler format - dedupe by name
      const seen = new Set<string>();
      const servers = (data.servers || [])
        .map((item: any) => {
          const s = item.server;
          const pkg = s.packages?.find((p: any) => p.registryType === "npm");
          const remote = s.remotes?.[0];

          // Extract a short display name from the full name
          const fullName = s.name || "";
          const shortName = fullName.split("/").pop()?.replace(/-mcp$/, "").replace(/^mcp-/, "") || fullName;

          return {
            id: fullName,
            name: shortName,
            fullName: fullName,
            description: s.description,
            version: s.version,
            repository: s.repository?.url,
            npmPackage: pkg?.identifier || null,
            remoteUrl: remote?.url || null,
            transport: pkg?.transport?.type || (remote ? "http" : "stdio"),
          };
        })
        .filter((s: any) => {
          // Dedupe by fullName
          if (seen.has(s.fullName)) return false;
          seen.add(s.fullName);
          // Only show servers with npm package or remote URL
          return s.npmPackage || s.remoteUrl;
        });

      return json({ servers });
    } catch (e) {
      return json({ error: "Failed to search registry" }, 500);
    }
  }

  // POST /api/mcp/servers - Create/install a new MCP server
  if (path === "/api/mcp/servers" && method === "POST") {
    try {
      const body = await req.json();
      const { name, type, package: pkg, pip_module, command, args, env, url, headers, source, project_id } = body;

      if (!name) {
        return json({ error: "Name is required" }, 400);
      }

      const server = McpServerDB.create({
        id: generateId(),
        name,
        type: type || "npm",
        package: pkg || null,
        pip_module: pip_module || null,
        command: command || null,
        args: args || null,
        env: env || {},
        url: url || null,
        headers: headers || {},
        source: source || null,
        project_id: project_id || null,
      });

      return json({ server }, 201);
    } catch (e) {
      console.error("Create MCP server error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/mcp/servers/:id - Get a specific MCP server
  const mcpServerMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (mcpServerMatch && method === "GET") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }
    return json({ server });
  }

  // PUT /api/mcp/servers/:id - Update an MCP server
  if (mcpServerMatch && method === "PUT") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<McpServer> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.type !== undefined) updates.type = body.type;
      if (body.package !== undefined) updates.package = body.package;
      if (body.pip_module !== undefined) updates.pip_module = body.pip_module;
      if (body.command !== undefined) updates.command = body.command;
      if (body.args !== undefined) updates.args = body.args;
      if (body.env !== undefined) updates.env = body.env;
      if (body.url !== undefined) updates.url = body.url;
      if (body.headers !== undefined) updates.headers = body.headers;
      if (body.project_id !== undefined) updates.project_id = body.project_id;

      const updated = McpServerDB.update(mcpServerMatch[1], updates);
      return json({ server: updated });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/mcp/servers/:id - Delete an MCP server
  if (mcpServerMatch && method === "DELETE") {
    const server = McpServerDB.findById(mcpServerMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Stop if running
    if (server.status === "running") {
      // TODO: Stop the server process
    }

    McpServerDB.delete(mcpServerMatch[1]);
    return json({ success: true });
  }

  // POST /api/mcp/servers/:id/start - Start an MCP server
  const mcpStartMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
  if (mcpStartMatch && method === "POST") {
    const server = McpServerDB.findById(mcpStartMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    if (server.status === "running") {
      return json({ error: "MCP server already running" }, 400);
    }

    // Determine command to run
    // Helper to substitute $ENV_VAR references with actual values
    const substituteEnvVars = (str: string, env: Record<string, string>): string => {
      return str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName) => {
        return env[varName] || '';
      });
    };

    let cmd: string[];
    const serverEnv = server.env || {};

    if (server.command) {
      // Custom command - substitute env vars in args
      cmd = server.command.split(" ");
      if (server.args) {
        const substitutedArgs = substituteEnvVars(server.args, serverEnv);
        cmd.push(...substitutedArgs.split(" "));
      }
    } else if (server.type === "pip" && server.package) {
      // Python pip package - install first, then run module
      const pipPackage = server.package;
      const pipModule = server.pip_module || server.package.split("[")[0]; // Default: package name without extras

      console.log(`Installing pip package: ${pipPackage}...`);
      const installResult = spawn({
        cmd: ["pip", "install", "--quiet", "--break-system-packages", pipPackage],
        env: { ...process.env as Record<string, string>, ...serverEnv },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait for installation to complete
      const exitCode = await installResult.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(installResult.stderr).text();
        return json({ error: `Failed to install pip package: ${stderr || "unknown error"}` }, 500);
      }

      // Now run the module
      cmd = ["python", "-m", pipModule];
      if (server.args) {
        const substitutedArgs = substituteEnvVars(server.args, serverEnv);
        cmd.push(...substitutedArgs.split(" "));
      }
    } else if (server.package) {
      // npm package - use npx
      cmd = ["npx", "-y", server.package];
      if (server.args) {
        const substitutedArgs = substituteEnvVars(server.args, serverEnv);
        cmd.push(...substitutedArgs.split(" "));
      }
    } else {
      return json({ error: "No command or package specified" }, 400);
    }

    // Get a port for the HTTP proxy
    const port = await getNextPort();

    console.log(`Starting MCP server ${server.name}...`);
    console.log(`  Command: ${cmd.join(" ")}`);
    console.log(`  HTTP proxy: http://localhost:${port}/mcp`);

    // Start the MCP process with stdio pipes + HTTP proxy
    const result = await startMcpProcess(server.id, cmd, server.env || {}, port);

    if (!result.success) {
      console.error(`Failed to start MCP server: ${result.error}`);
      return json({ error: `Failed to start: ${result.error}` }, 500);
    }

    // Update status with the HTTP proxy port
    const updated = McpServerDB.setStatus(server.id, "running", port);

    return json({
      server: updated,
      message: "MCP server started",
      proxyUrl: `http://localhost:${port}/mcp`,
    });
  }

  // POST /api/mcp/servers/:id/stop - Stop an MCP server
  const mcpStopMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
  if (mcpStopMatch && method === "POST") {
    const server = McpServerDB.findById(mcpStopMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // Stop the MCP process
    stopMcpProcess(server.id);

    const updated = McpServerDB.setStatus(server.id, "stopped");
    return json({ server: updated, message: "MCP server stopped" });
  }

  // GET /api/mcp/servers/:id/tools - List tools from an MCP server
  const mcpToolsMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (mcpToolsMatch && method === "GET") {
    const server = McpServerDB.findById(mcpToolsMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    // HTTP servers use remote HTTP transport
    if (server.type === "http" && server.url) {
      try {
        const httpClient = getHttpMcpClient(server.url, server.headers || {});
        const serverInfo = await httpClient.initialize();
        const tools = await httpClient.listTools();

        return json({
          serverInfo,
          tools,
        });
      } catch (err) {
        console.error(`Failed to list HTTP MCP tools: ${err}`);
        return json({ error: `Failed to communicate with MCP server: ${err}` }, 500);
      }
    }

    // Stdio servers require a running process
    const mcpProcess = getMcpProcess(server.id);
    if (!mcpProcess) {
      return json({ error: "MCP server is not running" }, 400);
    }

    try {
      const serverInfo = await initializeMcpServer(server.id);
      const tools = await listMcpTools(server.id);

      return json({
        serverInfo,
        tools,
      });
    } catch (err) {
      console.error(`Failed to list MCP tools: ${err}`);
      return json({ error: `Failed to communicate with MCP server: ${err}` }, 500);
    }
  }

  // POST /api/mcp/servers/:id/tools/:toolName/call - Call a tool on an MCP server
  const mcpToolCallMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/([^/]+)\/call$/);
  if (mcpToolCallMatch && method === "POST") {
    const server = McpServerDB.findById(mcpToolCallMatch[1]);
    if (!server) {
      return json({ error: "MCP server not found" }, 404);
    }

    const toolName = decodeURIComponent(mcpToolCallMatch[2]);

    // HTTP servers use remote HTTP transport
    if (server.type === "http" && server.url) {
      try {
        const body = await req.json();
        const args = body.arguments || {};

        const httpClient = getHttpMcpClient(server.url, server.headers || {});
        const result = await httpClient.callTool(toolName, args);

        return json({ result });
      } catch (err) {
        console.error(`Failed to call HTTP MCP tool: ${err}`);
        return json({ error: `Failed to call tool: ${err}` }, 500);
      }
    }

    // Stdio servers require a running process
    const mcpProcess = getMcpProcess(server.id);
    if (!mcpProcess) {
      return json({ error: "MCP server is not running" }, 400);
    }

    try {
      const body = await req.json();
      const args = body.arguments || {};

      const result = await callMcpTool(server.id, toolName, args);

      return json({ result });
    } catch (err) {
      console.error(`Failed to call MCP tool: ${err}`);
      return json({ error: `Failed to call tool: ${err}` }, 500);
    }
  }

  return null;
}
