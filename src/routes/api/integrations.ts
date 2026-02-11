import { json } from "./helpers";
import { McpServerDB, generateId } from "../../db";
import { ProviderKeys } from "../../providers";
import { getProvider, getProviderIds, registerProvider } from "../../integrations";
import { ComposioProvider } from "../../integrations/composio";
import {
  AgentDojoProvider,
  listServers as listAgentDojoServers,
  createServer as createAgentDojoServer,
  getServer as getAgentDojoServer,
  deleteServer as deleteAgentDojoServer,
} from "../../integrations/agentdojo";
import type { AuthContext } from "../../auth/middleware";

// Register integration providers on module load
registerProvider(ComposioProvider);
registerProvider(AgentDojoProvider);

export async function handleIntegrationRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: AuthContext,
): Promise<Response | null> {
  const user = authContext?.user;

  // ============ Generic Integration Providers ============

  // GET /api/integrations/providers - List available integration providers
  if (path === "/api/integrations/providers" && method === "GET") {
    const providerIds = getProviderIds();
    const providers = providerIds.map(id => {
      const provider = getProvider(id);
      const hasKey = !!ProviderKeys.getDecrypted(id);
      return {
        id,
        name: provider?.name || id,
        connected: hasKey,
      };
    });
    return json({ providers });
  }

  // GET /api/integrations/:provider/apps - List available apps from a provider
  const appsMatch = path.match(/^\/api\/integrations\/([^/]+)\/apps$/);
  if (appsMatch && method === "GET") {
    const providerId = appsMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured`, apps: [] }, 200);
    }

    try {
      const apps = await provider.listApps(apiKey);
      return json({ apps });
    } catch (e) {
      console.error(`Failed to list apps from ${providerId}:`, e);
      return json({ error: "Failed to fetch apps" }, 500);
    }
  }

  // GET /api/integrations/:provider/connected - List user's connected accounts
  const connectedMatch = path.match(/^\/api\/integrations\/([^/]+)\/connected$/);
  if (connectedMatch && method === "GET") {
    const providerId = connectedMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    console.log(`[integrations/connected] provider=${providerId}, projectId=${projectId}`);
    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    console.log(`[integrations/connected] apiKey found: ${!!apiKey}, length: ${apiKey?.length || 0}`);
    if (!apiKey) {
      console.log(`[integrations/connected] NO API KEY for ${providerId}`);
      return json({ error: `${provider.name} API key not configured`, accounts: [] }, 200);
    }

    // Use Apteva user ID as the entity ID for the provider
    if (!user?.id) {
      return json({ error: "Authentication required" }, 401);
    }

    try {
      const accounts = await provider.listConnectedAccounts(apiKey, user.id);
      console.log(`[integrations/connected] Got ${accounts.length} accounts from ${providerId}`);
      return json({ accounts });
    } catch (e) {
      console.error(`[integrations/connected] Failed from ${providerId}:`, e);
      return json({ error: "Failed to fetch connected accounts" }, 500);
    }
  }

  // POST /api/integrations/:provider/connect - Initiate connection (OAuth or API Key)
  const connectMatch = path.match(/^\/api\/integrations\/([^/]+)\/connect$/);
  if (connectMatch && method === "POST") {
    const providerId = connectMatch[1];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    try {
      const body = await req.json();
      const { appSlug, redirectUrl, credentials, project_id } = body;
      const apiKey = ProviderKeys.getDecryptedForProject(providerId, project_id || null);
      if (!apiKey) {
        return json({ error: `${provider.name} API key not configured` }, 401);
      }

      if (!appSlug) {
        return json({ error: "appSlug is required" }, 400);
      }

      // Use Apteva user ID as the entity ID
      if (!user?.id) {
        return json({ error: "Authentication required" }, 401);
      }

      // Default redirect URL back to our integrations page
      const callbackUrl = redirectUrl || `http://localhost:${process.env.PORT || 4280}/mcp?tab=hosted&connected=${appSlug}`;

      const result = await provider.initiateConnection(apiKey, user.id, appSlug, callbackUrl, credentials);
      return json(result);
    } catch (e) {
      console.error(`Failed to initiate connection for ${providerId}:`, e);
      return json({ error: `Failed to initiate connection: ${e}` }, 500);
    }
  }

  // GET /api/integrations/:provider/connection/:id - Check connection status
  const connectionStatusMatch = path.match(/^\/api\/integrations\/([^/]+)\/connection\/([^/]+)$/);
  if (connectionStatusMatch && method === "GET") {
    const providerId = connectionStatusMatch[1];
    const connectionId = connectionStatusMatch[2];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const connection = await provider.getConnectionStatus(apiKey, connectionId);
      if (!connection) {
        return json({ error: "Connection not found" }, 404);
      }
      return json({ connection });
    } catch (e) {
      console.error(`Failed to get connection status:`, e);
      return json({ error: "Failed to get connection status" }, 500);
    }
  }

  // DELETE /api/integrations/:provider/connection/:id - Disconnect/revoke
  if (connectionStatusMatch && method === "DELETE") {
    const providerId = connectionStatusMatch[1];
    const connectionId = connectionStatusMatch[2];
    const provider = getProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown provider: ${providerId}` }, 404);
    }

    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const success = await provider.disconnect(apiKey, connectionId);
      return json({ success });
    } catch (e) {
      console.error(`Failed to disconnect:`, e);
      return json({ error: "Failed to disconnect" }, 500);
    }
  }

  // ============ Composio-Specific Routes ============

  // GET /api/integrations/composio/configs - List Composio MCP configs
  if (path === "/api/integrations/composio/configs" && method === "GET") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("composio", projectId);
    if (!apiKey) {
      return json({ error: "Composio API key not configured", configs: [] }, 200);
    }

    try {
      const res = await fetch("https://backend.composio.dev/api/v3/mcp/servers?limit=50", {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("Composio API error:", res.status, text);
        return json({ error: "Failed to fetch Composio configs" }, 500);
      }

      const data = await res.json();

      // Transform to our format
      const configs = (data.items || data.servers || []).map((item: any) => ({
        id: item.id,
        name: item.name || item.id,
        toolkits: item.toolkits || item.apps || [],
        toolsCount: item.toolsCount || item.tools?.length || 0,
        createdAt: item.createdAt || item.created_at,
      }));

      return json({ configs });
    } catch (e) {
      console.error("Composio fetch error:", e);
      return json({ error: "Failed to connect to Composio" }, 500);
    }
  }

  // GET /api/integrations/composio/configs/:id - Get single Composio config details
  const composioConfigMatch = path.match(/^\/api\/integrations\/composio\/configs\/([^/]+)$/);
  if (composioConfigMatch && method === "GET") {
    const configId = composioConfigMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("composio", projectId);
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const res = await fetch(`https://backend.composio.dev/api/v3/mcp/${configId}`, {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        return json({ error: "Config not found" }, 404);
      }

      const data = await res.json();
      return json({
        config: {
          id: data.id,
          name: data.name || data.id,
          toolkits: data.toolkits || data.apps || [],
          tools: data.tools || [],
        },
      });
    } catch (e) {
      return json({ error: "Failed to fetch config" }, 500);
    }
  }

  // POST /api/integrations/composio/configs/:id/add - Add a Composio config as an MCP server
  const composioAddMatch = path.match(/^\/api\/integrations\/composio\/configs\/([^/]+)\/add$/);
  if (composioAddMatch && method === "POST") {
    const configId = composioAddMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("composio", projectId);
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      // Fetch config details from Composio to get the name and mcp_url
      const res = await fetch(`https://backend.composio.dev/api/v3/mcp/${configId}`, {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Failed to fetch Composio MCP config:", errText);
        return json({ error: "Failed to fetch MCP config from Composio" }, 400);
      }

      const data = await res.json();
      const configName = data.name || `composio-${configId.slice(0, 8)}`;
      const mcpUrl = data.mcp_url;
      const authConfigIds = data.auth_config_ids || [];
      const serverInstanceCount = data.server_instance_count || 0;

      if (!mcpUrl) {
        return json({ error: "MCP config does not have a URL" }, 400);
      }

      // Get user_id from connected accounts for this auth config
      const { createMcpServerInstance, getUserIdForAuthConfig } = await import("../../integrations/composio");
      let userId: string | null = null;

      if (authConfigIds.length > 0) {
        userId = await getUserIdForAuthConfig(apiKey, authConfigIds[0]);

        // Create server instance if none exists
        if (serverInstanceCount === 0 && userId) {
          const instance = await createMcpServerInstance(apiKey, configId, userId);
          if (instance) {
            console.log(`Created server instance for user ${userId} on server ${configId}`);
          }
        }
      }

      // Append user_id to mcp_url for authentication
      const mcpUrlWithUser = userId
        ? `${mcpUrl}?user_id=${encodeURIComponent(userId)}`
        : mcpUrl;

      // Check if already exists (match by config ID in URL)
      const existing = McpServerDB.findAll().find(
        s => s.source === "composio" && s.url?.includes(configId)
      );
      if (existing) {
        return json({ server: existing, message: "Server already exists" });
      }

      // Create the MCP server entry with user_id in URL
      const server = McpServerDB.create({
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
        project_id: projectId,
      });

      return json({ server, message: "Server added successfully" });
    } catch (e) {
      console.error("Failed to add Composio config:", e);
      return json({ error: "Failed to add Composio config" }, 500);
    }
  }

  // POST /api/integrations/composio/configs - Create a new MCP config from connected app
  if (path === "/api/integrations/composio/configs" && method === "POST") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("composio", projectId);
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const body = await req.json();
      const { name, toolkitSlug, authConfigId } = body;

      if (!name || !toolkitSlug) {
        return json({ error: "name and toolkitSlug are required" }, 400);
      }

      // If authConfigId not provided, find it from the toolkit
      let configId = authConfigId;
      if (!configId) {
        const { getAuthConfigForToolkit } = await import("../../integrations/composio");
        configId = await getAuthConfigForToolkit(apiKey, toolkitSlug);
        if (!configId) {
          return json({ error: `No auth config found for ${toolkitSlug}. Make sure you have connected this app first.` }, 400);
        }
      }

      // Create MCP server in Composio
      const { createMcpServer, createMcpServerInstance, getUserIdForAuthConfig } = await import("../../integrations/composio");
      const mcpServer = await createMcpServer(apiKey, name, [configId]);

      if (!mcpServer) {
        return json({ error: "Failed to create MCP config" }, 500);
      }

      // Create server instance for the user who has the connected account
      const userId = await getUserIdForAuthConfig(apiKey, configId);
      if (userId) {
        const instance = await createMcpServerInstance(apiKey, mcpServer.id, userId);
        if (!instance) {
          console.warn(`Created MCP server but failed to create instance for user ${userId}`);
        }
      }

      // Append user_id to mcp_url for authentication
      const mcpUrlWithUser = userId
        ? `${mcpServer.mcpUrl}?user_id=${encodeURIComponent(userId)}`
        : mcpServer.mcpUrl;

      return json({
        config: {
          id: mcpServer.id,
          name: mcpServer.name,
          toolkits: mcpServer.toolkits,
          mcpUrl: mcpUrlWithUser,
          allowedTools: mcpServer.allowedTools,
          userId,
        },
      }, 201);
    } catch (e: any) {
      console.error("Failed to create Composio MCP config:", e);
      return json({ error: e.message || "Failed to create MCP config" }, 500);
    }
  }

  // DELETE /api/integrations/composio/configs/:id - Delete a Composio MCP config
  if (composioConfigMatch && method === "DELETE") {
    const configId = composioConfigMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("composio", projectId);
    if (!apiKey) {
      return json({ error: "Composio API key not configured" }, 401);
    }

    try {
      const { deleteMcpServer } = await import("../../integrations/composio");
      const success = await deleteMcpServer(apiKey, configId);
      if (!success) {
        return json({ error: "Failed to delete MCP config" }, 500);
      }
      return json({ success: true });
    } catch (e) {
      console.error("Failed to delete Composio config:", e);
      return json({ error: "Failed to delete MCP config" }, 500);
    }
  }

  // ============ AgentDojo-Specific Routes ============

  // GET /api/integrations/agentdojo/configs - List AgentDojo MCP servers (configs)
  if (path === "/api/integrations/agentdojo/configs" && method === "GET") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("agentdojo", projectId);
    if (!apiKey) {
      return json({ error: "AgentDojo API key not configured", configs: [] }, 200);
    }

    try {
      const servers = await listAgentDojoServers(apiKey, true);
      const configs = servers.map(s => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        toolkits: [], // Could be extracted from tools
        toolsCount: s.tools?.length || 0,
        mcpUrl: s.url,
        createdAt: s.createdAt,
      }));
      return json({ configs });
    } catch (e) {
      console.error("AgentDojo fetch error:", e);
      return json({ error: "Failed to connect to AgentDojo" }, 500);
    }
  }

  // GET /api/integrations/agentdojo/configs/:id - Get single AgentDojo config details
  const agentdojoConfigMatch = path.match(/^\/api\/integrations\/agentdojo\/configs\/([^/]+)$/);
  if (agentdojoConfigMatch && method === "GET") {
    const configId = agentdojoConfigMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("agentdojo", projectId);
    if (!apiKey) {
      return json({ error: "AgentDojo API key not configured" }, 401);
    }

    try {
      const server = await getAgentDojoServer(apiKey, configId);
      if (!server) {
        return json({ error: "Config not found" }, 404);
      }
      return json({
        config: {
          id: server.id,
          name: server.name,
          slug: server.slug,
          mcpUrl: server.url,
          tools: server.tools || [],
        },
      });
    } catch (e) {
      return json({ error: "Failed to fetch config" }, 500);
    }
  }

  // POST /api/integrations/agentdojo/configs/:id/add - Add an AgentDojo config as a local MCP server
  const agentdojoAddMatch = path.match(/^\/api\/integrations\/agentdojo\/configs\/([^/]+)\/add$/);
  if (agentdojoAddMatch && method === "POST") {
    const configId = agentdojoAddMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("agentdojo", projectId);
    if (!apiKey) {
      return json({ error: "AgentDojo API key not configured" }, 401);
    }

    try {
      const server = await getAgentDojoServer(apiKey, configId);
      if (!server) {
        return json({ error: "Config not found" }, 404);
      }

      // Check if already exists
      const existing = McpServerDB.findAll().find(
        s => s.source === "agentdojo" && (s.url?.includes(server.slug) || s.url?.includes(configId))
      );
      if (existing) {
        return json({ server: existing, message: "Server already exists" });
      }

      // Create the MCP server entry
      const mcpServer = McpServerDB.create({
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
        project_id: projectId && projectId !== "unassigned" ? projectId : null,
      });

      return json({ server: mcpServer, message: "Server added successfully" });
    } catch (e) {
      console.error("Failed to add AgentDojo config:", e);
      return json({ error: "Failed to add AgentDojo config" }, 500);
    }
  }

  // POST /api/integrations/agentdojo/configs - Create a new MCP server from toolkit
  if (path === "/api/integrations/agentdojo/configs" && method === "POST") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("agentdojo", projectId);
    if (!apiKey) {
      return json({ error: "AgentDojo API key not configured" }, 401);
    }

    try {
      const body = await req.json();
      const { name, toolkitSlug, toolkits } = body;

      if (!name) {
        return json({ error: "name is required" }, 400);
      }

      // Accept either toolkitSlug (single) or toolkits (array)
      const toolkitList = toolkits || (toolkitSlug ? [toolkitSlug] : []);
      if (toolkitList.length === 0) {
        return json({ error: "toolkitSlug or toolkits is required" }, 400);
      }

      const server = await createAgentDojoServer(apiKey, name, toolkitList);
      if (!server) {
        return json({ error: "Failed to create MCP config" }, 500);
      }

      return json({
        config: {
          id: server.id,
          name: server.name,
          slug: server.slug,
          mcpUrl: server.url,
          tools: server.tools || [],
        },
      }, 201);
    } catch (e: any) {
      console.error("Failed to create AgentDojo MCP config:", e);
      return json({ error: e.message || "Failed to create MCP config" }, 500);
    }
  }

  // DELETE /api/integrations/agentdojo/configs/:id - Delete an AgentDojo MCP config
  if (agentdojoConfigMatch && method === "DELETE") {
    const configId = agentdojoConfigMatch[1];
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || null;
    const apiKey = ProviderKeys.getDecryptedForProject("agentdojo", projectId);
    if (!apiKey) {
      return json({ error: "AgentDojo API key not configured" }, 401);
    }

    try {
      const success = await deleteAgentDojoServer(apiKey, configId);
      if (!success) {
        return json({ error: "Failed to delete MCP config" }, 500);
      }
      return json({ success: true });
    } catch (e) {
      console.error("Failed to delete AgentDojo config:", e);
      return json({ error: "Failed to delete MCP config" }, 500);
    }
  }

  return null;
}
