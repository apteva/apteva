// Composio Integration Provider
// https://docs.composio.dev/api-reference

import type {
  IntegrationProvider,
  IntegrationApp,
  ConnectedAccount,
  ConnectionRequest,
  ConnectionCredentials,
} from "./index";

const COMPOSIO_API_BASE = "https://backend.composio.dev";

export const ComposioProvider: IntegrationProvider = {
  id: "composio",
  name: "Composio",

  async listApps(apiKey: string): Promise<IntegrationApp[]> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/toolkits`, {
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("Composio listApps error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.items || data.toolkits || data || [];

    return items.map((item: any) => ({
      id: item.slug || item.key || item.name,
      name: item.name || item.slug,
      slug: item.slug || item.key || item.name?.toLowerCase(),
      description: item.meta?.description || item.description || null,
      logo: item.meta?.logo || item.logo || null,
      categories: (item.meta?.categories || item.categories || []).map((c: any) =>
        typeof c === "string" ? c : c.name || c.id
      ),
      authSchemes: item.auth_schemes || item.authSchemes || ["OAUTH2"],
    }));
  },

  async listConnectedAccounts(apiKey: string, userId: string): Promise<ConnectedAccount[]> {
    console.log(`Fetching connected accounts for user: ${userId}`);
    const res = await fetch(
      `${COMPOSIO_API_BASE}/api/v3/connected_accounts?user_id=${encodeURIComponent(userId)}&limit=100`,
      {
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      console.error("Composio listConnectedAccounts error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.items || data.connections || data || [];
    console.log(`Found ${items.length} connected accounts`);
    if (items.length > 0) {
      console.log(`Sample account:`, JSON.stringify(items[0], null, 2));
    }

    return items.map((item: any) => ({
      id: item.id,
      appId: item.toolkit?.slug || item.toolkit_slug || item.appId || item.app_id,
      appName: item.toolkit?.name || item.toolkit_name || item.appName || item.toolkit?.slug,
      status: mapStatus(item.status),
      createdAt: item.created_at || item.createdAt || new Date().toISOString(),
      metadata: {
        entityId: item.entity_id || item.user_id,
        integrationId: item.auth_config?.id,
      },
    }));
  },

  async initiateConnection(
    apiKey: string,
    userId: string,
    appSlug: string,
    redirectUrl: string,
    credentials?: ConnectionCredentials
  ): Promise<ConnectionRequest> {
    const isApiKeyAuth = credentials?.authScheme === "API_KEY" && credentials?.apiKey;

    console.log(`Initiating ${isApiKeyAuth ? "API_KEY" : "OAuth"} connection for ${appSlug}`);

    // Step 1: Get toolkit info to find the API key field name
    let apiKeyFieldName = "api_key"; // default
    try {
      const toolkitRes = await fetch(`${COMPOSIO_API_BASE}/api/v3/toolkits/${appSlug}`, {
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      });
      if (toolkitRes.ok) {
        const toolkitData = await toolkitRes.json();
        // Find the API_KEY auth config details
        const apiKeyConfig = toolkitData.auth_config_details?.find(
          (c: any) => c.mode === "API_KEY"
        );
        if (apiKeyConfig?.fields?.connected_account_initiation?.required?.[0]?.name) {
          apiKeyFieldName = apiKeyConfig.fields.connected_account_initiation.required[0].name;
        }
        console.log(`Toolkit ${appSlug} API key field: ${apiKeyFieldName}`);
      }
    } catch (e) {
      console.error(`Failed to get toolkit info:`, e);
    }

    // Step 2: Get existing auth configs for this toolkit
    const configsRes = await fetch(`${COMPOSIO_API_BASE}/api/v3/auth_configs?toolkit=${appSlug}`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    });

    let authConfigId: string | null = null;

    if (configsRes.ok) {
      const configsData = await configsRes.json();
      const allConfigs = configsData.items || [];

      // Filter to configs for this toolkit
      const configs = allConfigs.filter((c: any) => {
        const toolkit = c.toolkit?.slug || c.toolkit_slug || "";
        return toolkit.toLowerCase() === appSlug.toLowerCase();
      });

      console.log(`Found ${configs.length} auth configs for ${appSlug}`);

      if (isApiKeyAuth) {
        const apiKeyConfig = configs.find((c: any) => c.auth_scheme === "API_KEY");
        if (apiKeyConfig) {
          authConfigId = apiKeyConfig.id;
          console.log(`Using existing API_KEY config: ${authConfigId}`);
        }
      } else {
        const oauthConfig = configs.find((c: any) =>
          c.auth_scheme === "OAUTH2" || c.is_composio_managed
        );
        if (oauthConfig) {
          authConfigId = oauthConfig.id;
          console.log(`Using existing OAuth config: ${authConfigId}`);
        }
      }
    }

    // Step 3: Create auth config if not found
    if (!authConfigId) {
      console.log(`Creating new auth config for ${appSlug}...`);

      const createBody = isApiKeyAuth
        ? {
            toolkit: { slug: appSlug },
            auth_config: {
              type: "use_custom_auth",
              authScheme: "API_KEY",
            },
          }
        : {
            toolkit: { slug: appSlug },
            auth_config: {
              type: "use_composio_managed_auth",
            },
          };

      const createRes = await fetch(`${COMPOSIO_API_BASE}/api/v3/auth_configs`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });

      if (createRes.ok) {
        const createData = await createRes.json();
        authConfigId = createData.auth_config?.id;
        console.log(`Created auth config: ${authConfigId}`);
      } else {
        const errText = await createRes.text();
        console.error(`Failed to create auth config:`, errText);
        throw new Error(`Failed to create auth config: ${errText}`);
      }
    }

    if (!authConfigId) {
      throw new Error(`Could not find or create auth configuration for ${appSlug}.`);
    }

    // Step 4: Create connected account
    const connectionBody: any = {
      auth_config: { id: authConfigId },
      connection: {
        user_id: userId,
      },
    };

    if (isApiKeyAuth && credentials?.apiKey) {
      connectionBody.connection.state = {
        authScheme: "API_KEY",
        val: {
          [apiKeyFieldName]: credentials.apiKey,
        },
      };
    } else {
      connectionBody.connection.callback_url = redirectUrl;
    }

    console.log(`Creating connected account...`);

    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/connected_accounts`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(connectionBody),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Composio connection error:", res.status, text);
      throw new Error(`Failed to create connection: ${text}`);
    }

    const data = await res.json();
    const status = (data.status || "").toLowerCase();

    console.log(`Connection created: ${data.id}, status: ${status}`);

    return {
      redirectUrl: isApiKeyAuth ? null : (data.redirect_url || data.redirectUrl),
      connectionId: data.id,
      status: (status === "active" || status === "connected") ? "active" : "pending",
    };
  },

  async getConnectionStatus(apiKey: string, connectionId: string): Promise<ConnectedAccount | null> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/connected_accounts/${connectionId}`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      console.error("Composio getConnectionStatus error:", res.status, await res.text());
      return null;
    }

    const item = await res.json();

    return {
      id: item.id,
      appId: item.toolkit_slug || item.appId,
      appName: item.toolkit_name || item.appName || item.toolkit_slug,
      status: mapStatus(item.status),
      createdAt: item.created_at || item.createdAt,
      metadata: {
        entityId: item.entity_id,
        integrationId: item.integration_id,
      },
    };
  },

  async disconnect(apiKey: string, connectionId: string): Promise<boolean> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/connected_accounts/${connectionId}`, {
      method: "DELETE",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    });

    return res.ok;
  },
};

// MCP Server types
export interface McpServer {
  id: string;
  name: string;
  authConfigIds: string[];
  mcpUrl: string;
  toolkits: string[];
  toolkitIcons: Record<string, string>;
  allowedTools: string[];
  createdAt: string;
}

export async function listMcpServers(apiKey: string): Promise<McpServer[]> {
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/mcp/servers`, {
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    console.error("Failed to list MCP servers:", await res.text());
    return [];
  }

  const data = await res.json();
  const items = data.items || [];

  return items.map((item: any) => ({
    id: item.id,
    name: item.name,
    authConfigIds: item.auth_config_ids || [],
    mcpUrl: item.mcp_url,
    toolkits: item.toolkits || [],
    toolkitIcons: item.toolkit_icons || {},
    allowedTools: item.allowed_tools || [],
    createdAt: item.created_at,
  }));
}

export async function createMcpServer(
  apiKey: string,
  name: string,
  authConfigIds: string[],
  allowedTools?: string[]
): Promise<McpServer | null> {
  // Use auth_config_ids - Composio includes all tools by default when allowed_tools is not provided
  const body: any = {
    name,
    auth_config_ids: authConfigIds,
  };

  // Only set allowed_tools if explicitly provided to restrict tools
  // If not provided, Composio enables all tools by default
  if (allowedTools?.length) {
    body.allowed_tools = allowedTools;
  }

  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/mcp/servers`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Failed to create MCP server:", errText);
    throw new Error(`Failed to create MCP server: ${errText}`);
  }

  const item = await res.json();
  return {
    id: item.id,
    name: item.name,
    authConfigIds: item.auth_config_ids || [],
    mcpUrl: item.mcp_url,
    toolkits: item.toolkits || [],
    toolkitIcons: item.toolkit_icons || {},
    allowedTools: item.allowed_tools || [],
    createdAt: item.created_at,
  };
}

export async function deleteMcpServer(apiKey: string, serverId: string): Promise<boolean> {
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/mcp/servers/${serverId}`, {
    method: "DELETE",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  });
  return res.ok;
}

// Create a server instance for a user
export async function createMcpServerInstance(
  apiKey: string,
  serverId: string,
  userId: string
): Promise<{ id: string; instanceId: string } | null> {
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/mcp/servers/${serverId}/instances`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Failed to create MCP server instance:", errText);
    return null;
  }

  const data = await res.json();
  return {
    id: data.id,
    instanceId: data.instance_id,
  };
}

// Get user_id from connected accounts for a specific auth config
export async function getUserIdForAuthConfig(
  apiKey: string,
  authConfigId: string
): Promise<string | null> {
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/connected_accounts?limit=100`, {
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const items = data.items || [];

  // Find an active connected account for this auth config
  const account = items.find((item: any) =>
    item.auth_config?.id === authConfigId && item.status === "ACTIVE"
  );

  return account?.user_id || null;
}

// Get auth config ID for a connected account's toolkit
export async function getAuthConfigForToolkit(
  apiKey: string,
  toolkitSlug: string,
  authScheme: "API_KEY" | "OAUTH2" = "API_KEY"
): Promise<string | null> {
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/auth_configs?toolkit=${toolkitSlug}`, {
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const configs = (data.items || []).filter((c: any) => {
    const toolkit = c.toolkit?.slug || "";
    return toolkit.toLowerCase() === toolkitSlug.toLowerCase();
  });

  const config = configs.find((c: any) => c.auth_scheme === authScheme);
  return config?.id || null;
}

function mapStatus(status: string): ConnectedAccount["status"] {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "connected") return "active";
  if (s === "pending" || s === "initiated") return "pending";
  if (s === "failed" || s === "error") return "failed";
  if (s === "expired") return "expired";
  return "pending";
}
